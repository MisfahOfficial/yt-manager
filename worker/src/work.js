import { HttpError, bad, conflict, forbidden, notFound, json, str, httpUrl, audit, auditStmt, getSetting } from './http.js';
import { validateDeposit, checkDepositTarget, depositStmt } from './attendance.js';
import { rebuildEmployee, rebuildForTask, statusMap, activeState } from './engine.js';
import { classify, applicableDeadline, deliveries } from './lib/timer.js';
import { uuid } from './lib/crypto.js';
import { writeClickUpStatus, writeClickUpComment } from './clickup.js';
import { localDate, localMidnightMs } from './lib/time.js';

// Who the caller may see. Enforced here (server side) on every list/detail query.
export async function teamIds(ctx) {
  const { emp, env } = ctx;
  if (emp.role === 'admin') return (await env.DB.prepare('SELECT id FROM employees WHERE active=1').all()).results.map((r) => r.id);
  if (emp.role === 'manager') return [emp.id, ...(await env.DB.prepare('SELECT id FROM employees WHERE manager_id=? AND active=1').bind(emp.id).all()).results.map((r) => r.id)];
  return [emp.id];
}
const inList = (ids) => ids.map(() => '?').join(',') || "''";

export async function myTasks(ctx) {
  const { env, emp } = ctx;
  if (!emp.clickup_user_id) return json({ tasks: [], linked: false });
  const map = await statusMap(env.DB, emp.job_role);
  const rows = (await env.DB.prepare(
    `SELECT t.id,t.name,t.url,t.status,t.priority,t.due_ms FROM tasks t JOIN task_assignees ta ON ta.task_id=t.id
       WHERE ta.clickup_user_id=? AND ta.end_ms IS NULL AND t.deleted=0 ORDER BY t.due_ms IS NULL, t.due_ms LIMIT 200`).bind(emp.clickup_user_id).all()).results;
  const open = rows.filter((r) => !['done', 'ignore'].includes(classify(r.status, map)));
  return json({ tasks: open.map((r) => ({ ...r, class: classify(r.status, map) })), linked: true });
}

export async function createDeposit(ctx) {
  const { env, emp, now, body } = ctx;
  const requestId = str(body.request_id, 'request_id', { min: 8, max: 80 });
  const ex = await env.DB.prepare('SELECT id,attendance_id FROM deposits WHERE request_id=? AND employee_id=?').bind(requestId, emp.id).first();
  if (ex) return json({ ok: true, id: ex.id, duplicate: true });
  const open = await env.DB.prepare("SELECT id FROM attendance WHERE employee_id=? AND status='open'").bind(emp.id).first();
  if (!open) throw conflict('not_checked_in', 'Check in first, then deposit your work.');
  const d = validateDeposit(body);
  await checkDepositTarget(env.DB, emp, d);
  const { id, stmt } = depositStmt(env.DB, emp, open.id, requestId, d, now);
  try { await env.DB.batch([stmt]); }
  catch (e) {
    const again = await env.DB.prepare('SELECT id FROM deposits WHERE request_id=?').bind(requestId).first();
    if (again) return json({ ok: true, id: again.id, duplicate: true });
    throw e;
  }
  return json({ ok: true, id });
}

export async function chooseActive(ctx) {
  const { env, emp, now, body } = ctx;
  const taskId = str(body.task_id, 'task', { max: 64 });
  const ok = await env.DB.prepare('SELECT 1 FROM task_assignees WHERE task_id=? AND clickup_user_id=? AND end_ms IS NULL').bind(taskId, emp.clickup_user_id || '').first();
  if (!ok) throw forbidden('task_not_yours', 'That task is not assigned to you.');
  await env.DB.prepare('INSERT INTO active_choices(employee_id,task_id,at_ms) VALUES (?,?,?)').bind(emp.id, taskId, now).run();
  await audit(env.DB, { at: now, actor: emp.id, action: 'active_task_chosen', entity: 'task', entityId: taskId });
  const st = await activeState(env, emp.id, now);
  return json({ ok: true, active: st.active });
}

// ---------- manager views ----------
export async function teamOverview(ctx) {
  const { env, now } = ctx;
  const ids = await teamIds(ctx);
  const dayStart = localMidnightMs(localDate(now));
  const maps = new Map();
  const people = (await env.DB.prepare(`SELECT id,name,role,job_role,clickup_user_id FROM employees WHERE id IN (${inList(ids)}) AND (role<>'admin' OR id=?)`).bind(...ids, ctx.emp.id).all()).results;
  const out = [];
  for (const p of people) {
    const pmap = await statusMap(env.DB, p.job_role);
    const open = await env.DB.prepare("SELECT id,check_in_at,status FROM attendance WHERE employee_id=? AND status IN ('open','missing_checkout') ORDER BY check_in_at DESC LIMIT 1").bind(p.id).first();
    const sess = await env.DB.prepare('SELECT s.task_id,s.kind,s.start_ms,t.name,t.url FROM task_sessions s LEFT JOIN tasks t ON t.id=s.task_id WHERE s.employee_id=? AND s.end_ms IS NULL').bind(p.id).first();
    const dep = await env.DB.prepare('SELECT COUNT(*) n FROM deposits WHERE employee_id=? AND created_at>=?').bind(p.id, dayStart).first();
    const todayAtt = await env.DB.prepare('SELECT COUNT(*) n FROM attendance WHERE employee_id=? AND check_in_at>=?').bind(p.id, dayStart).first();
    const blocked = p.clickup_user_id ? (await env.DB.prepare(
      `SELECT t.id,t.name,t.url,t.status FROM tasks t JOIN task_assignees ta ON ta.task_id=t.id WHERE ta.clickup_user_id=? AND ta.end_ms IS NULL AND t.deleted=0`).bind(p.clickup_user_id).all()).results.filter((t) => classify(t.status, pmap) === 'paused') : [];
    out.push({
      id: p.id, name: p.name, job_role: p.job_role,
      attendance: open ? (open.status === 'open' ? 'checked_in' : 'missing_checkout') : todayAtt.n ? 'done_for_today' : 'not_in',
      since: open?.check_in_at || null,
      active_task: sess ? { id: sess.task_id, name: sess.name, url: sess.url, kind: sess.kind, since: sess.start_ms } : null,
      blockers: blocked, deposits_today: dep.n,
      missing_submission: !!open && open.status === 'open' && dep.n === 0,
      clickup_linked: !!p.clickup_user_id,
    });
  }
  return json({ people: out, server_time: now });
}

export async function submissions(ctx) {
  const { env, url } = ctx;
  const ids = await teamIds(ctx);
  const days = Math.min(+url.searchParams.get('days') || 7, 92);
  const from = Date.now() - days * 86400000;
  const rows = (await env.DB.prepare(
    `SELECT d.id,d.employee_id,e.name employee,d.created_at,d.link,d.completed,d.pending,d.is_complete,d.taskless_reason,d.review_note,d.task_id,t.name task_name,t.url task_url,t.status task_status
       FROM deposits d JOIN employees e ON e.id=d.employee_id LEFT JOIN tasks t ON t.id=d.task_id
      WHERE d.employee_id IN (${inList(ids)}) AND d.created_at>=? ORDER BY d.created_at DESC LIMIT 300`).bind(...ids, from).all()).results;
  const rev = (await env.DB.prepare('SELECT id,task_id,notes,links,created_at,clickup_status FROM revisions ORDER BY created_at DESC LIMIT 300').all()).results;
  return json({ submissions: rows, revisions: rev.filter((r) => rows.some((x) => x.task_id === r.task_id)) });
}

export async function teamTasks(ctx) {
  const { env } = ctx;
  const ids = await teamIds(ctx);
  const cu = (await env.DB.prepare(`SELECT clickup_user_id FROM employees WHERE id IN (${inList(ids)}) AND clickup_user_id IS NOT NULL`).bind(...ids).all()).results.map((r) => r.clickup_user_id);
  if (!cu.length) return json({ tasks: [] });
  const rows = (await env.DB.prepare(
    `SELECT DISTINCT t.id,t.name,t.url,t.status,t.due_ms,e.name assignee FROM tasks t JOIN task_assignees ta ON ta.task_id=t.id JOIN employees e ON e.clickup_user_id=ta.clickup_user_id
      WHERE ta.clickup_user_id IN (${inList(cu)}) AND ta.end_ms IS NULL AND t.deleted=0 ORDER BY t.due_ms IS NULL, t.due_ms LIMIT 300`).bind(...cu).all()).results;
  return json({ tasks: rows });
}

async function assertManagesTask(ctx, taskId) {
  if (ctx.emp.role === 'admin') return;
  const ids = await teamIds(ctx);
  const cu = (await ctx.env.DB.prepare(`SELECT clickup_user_id FROM employees WHERE id IN (${inList(ids)}) AND clickup_user_id IS NOT NULL`).bind(...ids).all()).results.map((r) => r.clickup_user_id);
  if (!cu.length) throw forbidden();
  const ok = await ctx.env.DB.prepare(`SELECT 1 FROM task_assignees WHERE task_id=? AND clickup_user_id IN (${inList(cu)})`).bind(taskId, ...cu).first();
  if (!ok) throw forbidden('not_your_team', 'That task is not on your team.');
}

// Optional "Request changes": records notes, optionally moves the ClickUp task to the mapped Revisions status.
// The returning webhook is deduplicated by event_key, so no sync loop: we never write to task_events ourselves.
export async function requestChanges(ctx) {
  const { env, emp, now, body, params } = ctx;
  const taskId = params.id;
  const t = await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(taskId).first();
  if (!t) throw notFound('Task not found.');
  await assertManagesTask(ctx, taskId);
  const notes = str(body.notes, 'notes', { max: 4000 });
  const links = Array.isArray(body.links) ? body.links.slice(0, 5).map((l) => httpUrl(l, 'reference link')) : [];
  const due = body.due_ms == null ? null : Number(body.due_ms);
  const id = uuid();
  const revStatus = await getSetting(env.DB, 'revisions_status', null);
  let cu = 'skipped';
  if (revStatus) {
    try {
      await writeClickUpStatus(env, taskId, revStatus);
      await writeClickUpComment(env, taskId, `Changes requested via YT Manager:\n${notes}${links.length ? '\n' + links.join('\n') : ''}`);
      cu = 'written';
    } catch (e) { cu = 'failed:' + String(e.message).slice(0, 120); }
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO revisions(id,task_id,requested_by,notes,links,created_at,clickup_status,due_ms) VALUES (?,?,?,?,?,?,?,?)').bind(id, taskId, emp.id, notes, JSON.stringify(links), now, cu, due),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'changes_requested', entity: 'task', entityId: taskId, after: { notes, clickup: cu } }),
  ]);
  return json({ ok: true, id, clickup: cu });
}

export async function reviewNote(ctx) {
  const { env, emp, now, body, params } = ctx;
  const d = await env.DB.prepare('SELECT employee_id FROM deposits WHERE id=?').bind(params.id).first();
  if (!d) throw notFound();
  const ids = await teamIds(ctx);
  if (!ids.includes(d.employee_id)) throw forbidden();
  const note = str(body.note, 'note', { max: 1000 });
  await env.DB.batch([
    env.DB.prepare('UPDATE deposits SET review_note=? WHERE id=?').bind(note, params.id),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'deposit_note', entity: 'deposit', entityId: params.id, after: { note } }),
  ]);
  return json({ ok: true });
}

export async function taskDetail(ctx) {
  const { env, emp, params } = ctx;
  const t = await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(params.id).first();
  if (!t) throw notFound();
  if (emp.role === 'employee') {
    const mine = await env.DB.prepare('SELECT 1 FROM task_assignees WHERE task_id=? AND clickup_user_id=?').bind(t.id, emp.clickup_user_id || '').first();
    if (!mine) throw forbidden();
  } else await assertManagesTask(ctx, t.id);
  const events = (await env.DB.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY at_ms,id').bind(t.id).all()).results;
  const map = await statusMap(env.DB);
  const due = events.filter((e) => e.kind === 'due');
  return json({
    task: t, deliveries: deliveries(events, map), deadline: applicableDeadline(due),
    history: events.filter((e) => e.kind === 'status').map((e) => ({ at: e.at_ms, from: e.from_val, to: e.to_val, source: e.source, approx: e.note === 'approx' })),
    revisions: (await env.DB.prepare('SELECT id,notes,links,created_at,due_ms,clickup_status FROM revisions WHERE task_id=? ORDER BY created_at').bind(t.id).all()).results,
  });
}
