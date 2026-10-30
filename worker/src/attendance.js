import { HttpError, bad, conflict, forbidden, notFound, json, str, httpUrl, int, audit, auditStmt, getSetting } from './http.js';
import { requireDevice } from './auth.js';
import { ipAllowed } from './lib/net.js';
import { uuid } from './lib/crypto.js';
import { checkDeposit } from './scriptcheck.js';
import { rebuildEmployee, sweepMissingCheckouts, activeState, loadShiftContext, attendanceEnd, statusMap } from './engine.js';
import { classify } from './lib/timer.js';
import { localDate, localMidnightMs, addDays, localMinutes } from './lib/time.js';

export function clientIp(req) { return req.headers.get('cf-connecting-ip') || null; }
// Cloudflare WARP (a VPN) comes out of Cloudflare's own network. An office never does, so this is never a real office address.
export const onVpn = (req) => req.cf?.asn === 13335;

// Remembers refused attempts from signed-in, approved computers (bounded: one row per person and address, at most one write a minute).
async function noteRefusal(ctx, employeeId, ip, vpn) {
  if (!ip) return;
  try {
    const row = await ctx.env.DB.prepare('SELECT last_at FROM network_refusals WHERE employee_id=? AND ip=?').bind(employeeId, ip).first();
    if (row && ctx.now - row.last_at < 60000) return;
    await ctx.env.DB.prepare('INSERT INTO network_refusals(employee_id,ip,is_vpn,first_at,last_at,count) VALUES (?,?,?,?,?,1) ON CONFLICT(employee_id,ip) DO UPDATE SET last_at=excluded.last_at,count=count+1,is_vpn=excluded.is_vpn')
      .bind(employeeId, ip, vpn ? 1 : 0, ctx.now, ctx.now).run();
  } catch { /* never block the answer because of bookkeeping */ }
}

// Network must be an approved office address, or an admin-created, time-boxed, audited exception.
export async function checkNetwork(ctx, employeeId) {
  const rules = await getSetting(ctx.env.DB, 'office_ips', []);
  const ip = clientIp(ctx.req);
  if (ip && ipAllowed(ip, rules)) return { ok: true, exceptionId: null, ip };
  const ex = await ctx.env.DB.prepare(
    'SELECT id FROM network_exceptions WHERE revoked_at IS NULL AND starts_at<=? AND expires_at>? AND (employee_id IS NULL OR employee_id=?) ORDER BY id DESC LIMIT 1')
    .bind(ctx.now, ctx.now, employeeId).first();
  if (ex) return { ok: true, exceptionId: ex.id, ip };
  if (!rules.length) throw new HttpError(403, 'network_not_configured', 'Office network is not set up yet. Ask your admin.');
  const vpn = onVpn(ctx.req);
  await noteRefusal(ctx, employeeId, ip, vpn);
  if (vpn) throw new HttpError(403, 'vpn_detected', 'You are connected through a VPN (Cloudflare WARP). Turn it off, then press the button again.', { vpn: true });
  throw new HttpError(403, 'not_office_network', `You can only check in or out from the office network. The server sees your address as ${ip || 'unknown'}.`);
}

async function openAttendance(db, employeeId) {
  return db.prepare("SELECT * FROM attendance WHERE employee_id=? AND status='open'").bind(employeeId).first();
}
const view = (a) => a && ({ id: a.id, check_in_at: a.check_in_at, check_out_at: a.check_out_at, status: a.status, corrected: !!a.corrected, checkout_exception: a.checkout_exception || null });

async function replay(db, employeeId, action, requestId) {
  const r = await db.prepare('SELECT result_json FROM idempotency WHERE request_id=? AND employee_id=? AND action=?').bind(requestId, employeeId, action).first();
  return r ? JSON.parse(r.result_json) : null;
}

export async function today(ctx) {
  const { env, emp, now } = ctx;
  await sweepMissingCheckouts(env.DB, now);
  const open = await openAttendance(env.DB, emp.id);
  const dayStart = localMidnightMs(localDate(now));
  const last = await env.DB.prepare('SELECT * FROM attendance WHERE employee_id=? AND check_in_at>=? ORDER BY check_in_at DESC LIMIT 1').bind(emp.id, dayStart - 86400000).first();
  const dep = open ? (await env.DB.prepare('SELECT COUNT(*) n FROM deposits WHERE attendance_id=?').bind(open.id).first()).n : 0;
  const state = await activeState(env, emp.id, now);
  let task = null;
  if (state.active) task = await env.DB.prepare('SELECT id,name,url,status FROM tasks WHERE id=?').bind(state.active.task_id).first();
  const sessions = (await env.DB.prepare('SELECT task_id,kind,start_ms,end_ms FROM task_sessions WHERE employee_id=? AND (end_ms IS NULL OR end_ms>?)').bind(emp.id, dayStart).all()).results;
  let recorded = 0;
  for (const s of sessions) recorded += Math.max(0, Math.min(s.end_ms ?? now, now) - Math.max(s.start_ms, dayStart));
  const dev = await env.DB.prepare("SELECT status FROM devices WHERE employee_id=? ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END LIMIT 1").bind(emp.id).first();
  let choices = [];
  if (state.ambiguous) choices = (await env.DB.prepare(`SELECT id,name,url FROM tasks WHERE id IN (${state.ambiguous.tasks.map(() => '?').join(',')})`).bind(...state.ambiguous.tasks).all()).results;
  let created = null;
  const trackJobs = (await getSetting(env.DB, 'created_tracking_jobs', [])).map((j) => String(j).toLowerCase());
  if (emp.clickup_user_id && emp.job_role && trackJobs.includes(emp.job_role.toLowerCase())) {
    const weekStart = localMidnightMs(addDays(localDate(now), -((new Date(localDate(now) + 'T00:00:00Z').getUTCDay() + 6) % 7)));
    const rows = (await env.DB.prepare('SELECT name,created_ms FROM tasks WHERE creator_id=? AND created_ms>=? AND deleted=0').bind(emp.clickup_user_id, weekStart).all()).results;
    const { codeOf } = await import('./lib/titles.js');
    created = { today: rows.filter((r) => r.created_ms >= dayStart).length, week: rows.length, by_code: Object.create(null) };
    for (const r of rows) { const c = codeOf(r.name) || 'No code'; created.by_code[c] = (created.by_code[c] || 0) + 1; }
  }
  let unverified = [];
  if (emp.clickup_user_id) {
    unverified = (await env.DB.prepare(
      `SELECT t.id,t.name FROM tasks t JOIN task_assignees ta ON ta.task_id=t.id AND ta.end_ms IS NULL AND ta.clickup_user_id=?
        WHERE t.deleted=0 AND lower(t.status)='in progress'
          AND (SELECT note FROM task_events e WHERE e.task_id=t.id AND e.kind='status' ORDER BY e.at_ms DESC,e.id DESC LIMIT 1)='approx'`).bind(emp.clickup_user_id).all()).results;
  }
  // ---- My Work (everything the Today screen needs, from ClickUp data we already hold) ----
  const map = await statusMap(env.DB, emp.job_role);
  const mine = emp.clickup_user_id ? (await env.DB.prepare(
    `SELECT t.id,t.name,t.url,t.status,t.due_ms FROM tasks t JOIN task_assignees ta ON ta.task_id=t.id
       WHERE ta.clickup_user_id=? AND ta.end_ms IS NULL AND t.deleted=0 ORDER BY t.due_ms IS NULL, t.due_ms LIMIT 100`).bind(emp.clickup_user_id).all()).results : [];
  const doneIds = new Set(open ? (await env.DB.prepare('SELECT DISTINCT task_id FROM deposits WHERE attendance_id=? AND task_id IS NOT NULL').bind(open.id).all()).results.map((r) => r.task_id) : []);
  const my_work = mine.map((t) => ({ ...t, class: classify(t.status, map) })).filter((t) => !['done', 'ignore'].includes(t.class))
    .map((t) => ({ id: t.id, name: t.name, url: t.url, status: t.status, due_ms: t.due_ms, class: t.class, active: task?.id === t.id,
      can_switch: ['active', 'revision'].includes(t.class) && task?.id !== t.id, has_update: doneIds.has(t.id) }));
  // tasks to ask about at check-out: timed this shift, already updated, or active
  let worked = [];
  if (open) {
    const ids = new Set([...doneIds, ...(task ? [task.id] : []), ...(await env.DB.prepare('SELECT DISTINCT task_id FROM task_sessions WHERE employee_id=? AND (end_ms IS NULL OR end_ms>=?)').bind(emp.id, open.check_in_at).all()).results.map((r) => r.task_id)]);
    for (const id of ids) {
      const t = await env.DB.prepare('SELECT id,name,url FROM tasks WHERE id=?').bind(id).first();
      if (!t) continue;
      const last = await env.DB.prepare('SELECT link,completed,pending,created_at FROM deposits WHERE employee_id=? AND task_id=? ORDER BY created_at DESC LIMIT 1').bind(emp.id, id).first();
      worked.push({ ...t, has_update: doneIds.has(id), last_link: last?.link || null, last_update_at: last?.created_at || null, active: task?.id === id });
    }
  }
  const sh = await loadShiftContext(env.DB, emp.id, dayStart - 86400000, dayStart + 2 * 86400000);
  const todayWin = sh.windows.find((w) => w.date === localDate(now));
  const shiftName = todayWin ? sh.asg.find((a) => a.effective_from <= todayWin.date && (!a.effective_to || todayWin.date <= a.effective_to))?.shift : null;
  const asked = (await env.DB.prepare('SELECT id,check_in_at FROM attendance WHERE employee_id=? AND asked_at IS NOT NULL AND status=\'missing_checkout\'').bind(emp.id).all()).results;
  return json({
    shift: todayWin ? { start_ms: todayWin.start, end_ms: todayWin.end, name: shiftName?.name || null } : null, my_work, worked_tasks: worked, asked,
    created, unverified_tasks: unverified, server_time: now, state: open ? 'checked_in' : 'checked_out', attendance: view(open || last),
    deposit_count: dep, active_task: task ? { ...task, kind: state.active.kind, since: state.active.start } : null,
    needs_task_choice: choices, recorded_ms_today: recorded, device_status: dev?.status || 'none',
  });
}

export async function checkIn(ctx) {
  const { env, emp, now, body } = ctx;
  const requestId = str(body.request_id, 'request_id', { min: 8, max: 80 });
  const deviceId = await requireDevice(ctx);
  const prior = await replay(env.DB, emp.id, 'checkin', requestId);
  if (prior) return json({ ...prior, duplicate: true });
  const net = await checkNetwork(ctx, emp.id);
  await sweepMissingCheckouts(env.DB, now);
  const open = await openAttendance(env.DB, emp.id);
  if (open) throw conflict('already_checked_in', 'You are already checked in.', { attendance: view(open) });
  const id = uuid();
  const result = { ok: true, attendance: { id, check_in_at: now, check_out_at: null, status: 'open' } };
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO attendance(id,employee_id,request_id,check_in_at,status,device_id,ip,network_exception_id) VALUES (?,?,?,?, 'open',?,?,?)")
        .bind(id, emp.id, requestId, now, deviceId, net.ip, net.exceptionId),
      env.DB.prepare('INSERT INTO idempotency(request_id,employee_id,action,result_json,at_ms) VALUES (?,?,?,?,?)').bind(requestId, emp.id, 'checkin', JSON.stringify(result), now),
      ...(net.exceptionId ? [auditStmt(env.DB, { at: now, actor: emp.id, action: 'checkin_network_exception', entity: 'attendance', entityId: id, after: { exception: net.exceptionId, ip: net.ip } })] : []),
    ]);
  } catch (e) {
    // A concurrent tab/double-click lost the race on a unique index: report the winner, never create a second row.
    const again = await replay(env.DB, emp.id, 'checkin', requestId);
    if (again) return json({ ...again, duplicate: true });
    const o = await openAttendance(env.DB, emp.id);
    if (o) throw conflict('already_checked_in', 'You are already checked in.', { attendance: view(o) });
    throw e;
  }
  await rebuildEmployee(env, emp.id, now, now);
  return json(result);
}

export function validateDeposit(body) {
  return {
    task_id: body.task_id ? str(String(body.task_id), 'task', { max: 64 }) : null,
    taskless_reason: str(body.taskless_reason, 'reason', { optional: true, min: 5, max: 300 }),
    link: httpUrl(body.link, 'work link'),
    completed: str(body.completed, 'what was completed', { max: 4000 }),
    pending: str(body.pending, 'what is pending', { optional: true, max: 4000 }),
    is_complete: body.is_complete ? 1 : 0,
  };
}
async function assertTaskAllowed(db, emp, taskId) {
  const row = await db.prepare(
    `SELECT 1 FROM task_assignees ta WHERE ta.task_id=? AND ta.clickup_user_id=? AND ta.end_ms IS NULL`).bind(taskId, emp.clickup_user_id || '').first();
  if (!row) throw forbidden('task_not_yours', 'That task is not assigned to you.');
}
export function depositStmt(db, emp, attendanceId, requestId, d, now, id = uuid()) {
  return { id, stmt: db.prepare(
    `INSERT INTO deposits(id,employee_id,attendance_id,request_id,task_id,taskless_reason,link,completed,pending,is_complete,created_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM attendance WHERE id=? AND employee_id=? AND status='open')`)
    .bind(id, emp.id, attendanceId, requestId, d.task_id, d.taskless_reason, d.link, d.completed, d.pending, d.is_complete, now, attendanceId, emp.id) };
}
export async function checkDepositTarget(db, emp, d) {
  if (d.task_id) await assertTaskAllowed(db, emp, d.task_id);
  else if (!d.taskless_reason) throw bad('task_or_reason', 'Pick a task, or explain why this work has no task.');
}

export async function checkOut(ctx) {
  const { env, emp, now, body } = ctx;
  const requestId = str(body.request_id, 'request_id', { min: 8, max: 80 });
  await requireDevice(ctx);
  const prior = await replay(env.DB, emp.id, 'checkout', requestId);
  if (prior) return json({ ...prior, duplicate: true });
  const net = await checkNetwork(ctx, emp.id);
  const open = await openAttendance(env.DB, emp.id);
  if (!open) throw conflict('not_checked_in', 'You are not checked in.');

  const stmts = [];
  let exception = null, depositId = null, depositLink = null;
  if (body.exception_reason) {
    exception = str(body.exception_reason, 'reason', { min: 10, max: 500 });
  } else if (Array.isArray(body.updates) && body.updates.length) {
    // several tasks in one go; all saved together with the check-out
    if (body.updates.length > 10) throw bad('too_many', 'Too many updates at once.');
    for (let i = 0; i < body.updates.length; i++) {
      const d = validateDeposit(body.updates[i]);
      await checkDepositTarget(env.DB, emp, d);
      const ds = depositStmt(env.DB, emp, open.id, i === 0 ? requestId : `${requestId}:${i}`, d, now);
      stmts.push(ds.stmt); if (i === 0) { depositId = ds.id; depositLink = d.link; }
    }
  } else if (body.deposit) {
    const d = validateDeposit(body.deposit);
    await checkDepositTarget(env.DB, emp, d);
    const ds = depositStmt(env.DB, emp, open.id, requestId, d, now);
    stmts.push(ds.stmt); depositId = ds.id; depositLink = d.link;
  } else {
    const have = await env.DB.prepare('SELECT COUNT(*) n FROM deposits WHERE attendance_id=?').bind(open.id).first();
    if (!have.n) throw new HttpError(422, 'deposit_required', 'Deposit your current work before you check out.');
  }
  const result = { ok: true, attendance: { id: open.id, check_in_at: open.check_in_at, check_out_at: now, status: 'closed' }, exception: !!exception };
  stmts.push(
    env.DB.prepare("INSERT INTO idempotency(request_id,employee_id,action,result_json,at_ms) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM attendance WHERE id=? AND status='open')")
      .bind(requestId, emp.id, 'checkout', JSON.stringify(result), now, open.id),
    env.DB.prepare("UPDATE attendance SET status='closed',check_out_at=?,checkout_request_id=?,checkout_ip=?,checkout_exception=? WHERE id=? AND status='open'")
      .bind(now, requestId, net.ip, exception, open.id),
    ...(exception ? [auditStmt(env.DB, { at: now, actor: emp.id, action: 'checkout_exception', entity: 'attendance', entityId: open.id, reason: exception })] : []),
  );
  try { await env.DB.batch(stmts); }
  catch (e) {
    const again = await replay(env.DB, emp.id, 'checkout', requestId);
    if (again) return json({ ...again, duplicate: true });
    throw e;
  }
  const after = await env.DB.prepare('SELECT checkout_request_id FROM attendance WHERE id=?').bind(open.id).first();
  if (after.checkout_request_id !== requestId) throw conflict('not_checked_in', 'You were already checked out from another tab.');
  await rebuildEmployee(env, emp.id, open.check_in_at, now);
  if (depositId) result.check = await checkDeposit(env, { id: depositId, link: depositLink }, emp.job_role, now); // after checkout is saved; failures never undo it
  return json(result);
}

export async function myHistory(ctx) {
  const { env, emp, now, url } = ctx;
  const days = Math.min(+url.searchParams.get('days') || 14, 92);
  const from = localMidnightMs(addDays(localDate(now), -days));
  const att = (await env.DB.prepare('SELECT * FROM attendance WHERE employee_id=? AND check_in_at>=? ORDER BY check_in_at DESC').bind(emp.id, from).all()).results.map(view);
  const dep = (await env.DB.prepare('SELECT d.id,d.created_at,d.link,d.completed,d.pending,d.is_complete,d.taskless_reason,d.review_note,d.check_json,t.name task_name,t.url task_url FROM deposits d LEFT JOIN tasks t ON t.id=d.task_id WHERE d.employee_id=? AND d.created_at>=? ORDER BY d.created_at DESC').bind(emp.id, from).all()).results;
  const ses = (await env.DB.prepare('SELECT s.task_id,s.kind,s.start_ms,s.end_ms,t.name task_name FROM task_sessions s LEFT JOIN tasks t ON t.id=s.task_id WHERE s.employee_id=? AND (s.end_ms IS NULL OR s.end_ms>=?) ORDER BY s.start_ms DESC').bind(emp.id, from).all()).results;
  return json({ attendance: att, deposits: dep, sessions: ses });
}

// ---- corrections (admin, or manager with can_correct for own team) ----
export async function assertCanCorrect(ctx, employeeId) {
  const { canDecide } = await import('./corrections.js');
  if (await canDecide(ctx, employeeId)) return;
  throw forbidden('cannot_correct', ctx.emp.id === employeeId ? 'You cannot change your own record. Ask the Owner.' : 'You are not allowed to correct attendance for this person.');
}

export async function correctAttendance(ctx) {
  const { env, emp, now, body, params } = ctx;
  const reason = str(body.reason, 'reason', { min: 5, max: 500 });
  const before = await env.DB.prepare('SELECT * FROM attendance WHERE id=?').bind(params.id).first();
  if (!before) throw notFound('Attendance record not found.');
  await assertCanCorrect(ctx, before.employee_id);
  const ci = body.check_in_at != null ? int(body.check_in_at, 'check-in time', { min: 1e12 }) : before.check_in_at;
  const co = body.check_out_at === null ? null : body.check_out_at != null ? int(body.check_out_at, 'check-out time', { min: 1e12 }) : before.check_out_at;
  if (co != null && co <= ci) throw bad('bad_times', 'Check-out must be after check-in.');
  if (ci > now || (co != null && co > now)) throw bad('future_time', 'Times cannot be in the future.');
  const status = co == null ? (before.status === 'missing_checkout' ? 'missing_checkout' : 'open') : 'closed';
  const overlap = await env.DB.prepare(
    'SELECT id FROM attendance WHERE employee_id=? AND id<>? AND check_in_at<? AND COALESCE(check_out_at,?)>?').bind(before.employee_id, before.id, co ?? now, now, ci).first();
  if (overlap) throw conflict('overlap', 'That overlaps another attendance record.');
  const after = { check_in_at: ci, check_out_at: co, status };
  await env.DB.batch([
    env.DB.prepare('UPDATE attendance SET check_in_at=?,check_out_at=?,status=?,corrected=1 WHERE id=?').bind(ci, co, status, before.id),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'attendance_corrected', entity: 'attendance', entityId: before.id,
      before: { check_in_at: before.check_in_at, check_out_at: before.check_out_at, status: before.status }, after, reason }),
  ]);
  await rebuildEmployee(env, before.employee_id, Math.min(ci, before.check_in_at), now);
  return json({ ok: true, attendance: { id: before.id, ...after } });
}

export async function addMissingAttendance(ctx) {
  const { env, emp, now, body } = ctx;
  const reason = str(body.reason, 'reason', { min: 5, max: 500 });
  const employeeId = str(body.employee_id, 'employee', { max: 64 });
  await assertCanCorrect(ctx, employeeId);
  const ci = int(body.check_in_at, 'check-in time', { min: 1e12 });
  const co = int(body.check_out_at, 'check-out time', { min: 1e12 });
  if (co <= ci || co > now) throw bad('bad_times', 'Times are not valid.');
  const overlap = await env.DB.prepare('SELECT id FROM attendance WHERE employee_id=? AND check_in_at<? AND COALESCE(check_out_at,?)>?').bind(employeeId, co, now, ci).first();
  if (overlap) throw conflict('overlap', 'That overlaps another attendance record.');
  const id = uuid();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO attendance(id,employee_id,request_id,check_in_at,check_out_at,status,corrected) VALUES (?,?,?,?,?,'closed',1)").bind(id, employeeId, 'manual-' + id, ci, co),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'attendance_added', entity: 'attendance', entityId: id, before: null, after: { employee_id: employeeId, check_in_at: ci, check_out_at: co }, reason }),
  ]);
  await rebuildEmployee(env, employeeId, ci, now);
  return json({ ok: true, id });
}
