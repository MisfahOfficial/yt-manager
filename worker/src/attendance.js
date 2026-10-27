import { HttpError, bad, conflict, forbidden, notFound, json, str, httpUrl, int, audit, auditStmt, getSetting } from './http.js';
import { requireDevice } from './auth.js';
import { ipAllowed } from './lib/net.js';
import { uuid } from './lib/crypto.js';
import { checkDeposit } from './scriptcheck.js';
import { rebuildEmployee, sweepMissingCheckouts, activeState, loadShiftContext, attendanceEnd } from './engine.js';
import { localDate, localMidnightMs, addDays, localMinutes } from './lib/time.js';

export function clientIp(req) { return req.headers.get('cf-connecting-ip') || null; }

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
  let unverified = [];
  if (emp.clickup_user_id) {
    unverified = (await env.DB.prepare(
      `SELECT t.id,t.name FROM tasks t JOIN task_assignees ta ON ta.task_id=t.id AND ta.end_ms IS NULL AND ta.clickup_user_id=?
        WHERE t.deleted=0 AND lower(t.status)='in progress'
          AND (SELECT note FROM task_events e WHERE e.task_id=t.id AND e.kind='status' ORDER BY e.at_ms DESC,e.id DESC LIMIT 1)='approx'`).bind(emp.clickup_user_id).all()).results;
  }
  return json({
    unverified_tasks: unverified, server_time: now, state: open ? 'checked_in' : 'checked_out', attendance: view(open || last),
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
  if (!d.is_complete && !d.pending) throw bad('missing_pending', 'Say what is still pending, or mark the work complete.');
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
  const { emp, env } = ctx;
  if (emp.role === 'admin') return;
  if (emp.role === 'manager' && emp.can_correct) {
    const e = await env.DB.prepare('SELECT manager_id FROM employees WHERE id=?').bind(employeeId).first();
    if (e && e.manager_id === emp.id) return;
  }
  throw forbidden('cannot_correct', 'You are not allowed to correct attendance for this person.');
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
