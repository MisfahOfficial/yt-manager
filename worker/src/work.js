import { HttpError, bad, conflict, forbidden, notFound, json, str, httpUrl, audit, auditStmt, getSetting } from './http.js';
import { validateDeposit, checkDepositTarget, depositStmt } from './attendance.js';
import { rebuildEmployee, rebuildForTask, statusMap, activeState } from './engine.js';
import { classify, applicableDeadline, deliveries } from './lib/timer.js';
import { uuid } from './lib/crypto.js';
import { checkDeposit } from './scriptcheck.js';
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
  const check = await checkDeposit(env, { id, link: d.link }, emp.job_role, now);
  return json({ ok: true, id, check });
}

export async function chooseActive(ctx) {
  const { env, emp, now, body } = ctx;
  const taskId = str(body.task_id, 'task', { max: 64 });
  const ok = await env.DB.prepare('SELECT 1 FROM task_assignees WHERE task_id=? AND clickup_user_id=? AND end_ms IS NULL').bind(taskId, emp.clickup_user_id || '').first();
  if (!ok) throw forbidden('task_not_yours', 'That task is not assigned to you.');
  const trow = await env.DB.prepare('SELECT status FROM tasks WHERE id=?').bind(taskId).first();
  if (!['active', 'revision'].includes(classify(trow?.status, await statusMap(env.DB, emp.job_role)))) throw conflict('not_in_progress', 'Start this task in ClickUp first. You can only switch to a task that is In Progress.');
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
    const sess = await env.DB.prepare('SELECT s.task_id,s.kind,s.start_ms,t.name,t.url,t.due_ms FROM task_sessions s LEFT JOIN tasks t ON t.id=s.task_id WHERE s.employee_id=? AND s.end_ms IS NULL').bind(p.id).first();
    const dep = await env.DB.prepare('SELECT COUNT(*) n FROM deposits WHERE employee_id=? AND created_at>=?').bind(p.id, dayStart).first();
    const todayAtt = await env.DB.prepare('SELECT COUNT(*) n FROM attendance WHERE employee_id=? AND check_in_at>=?').bind(p.id, dayStart).first();
    const blocked = p.clickup_user_id ? (await env.DB.prepare(
      `SELECT t.id,t.name,t.url,t.status FROM tasks t JOIN task_assignees ta ON ta.task_id=t.id WHERE ta.clickup_user_id=? AND ta.end_ms IS NULL AND t.deleted=0`).bind(p.clickup_user_id).all()).results.filter((t) => classify(t.status, pmap) === 'paused') : [];
    out.push({
      latest_update: await env.DB.prepare('SELECT d.completed text,d.created_at at,d.review_note,t.name task_name FROM deposits d LEFT JOIN tasks t ON t.id=d.task_id WHERE d.employee_id=? ORDER BY d.created_at DESC LIMIT 1').bind(p.id).first(),
      unreviewed: (await env.DB.prepare('SELECT COUNT(*) n FROM deposits WHERE employee_id=? AND review_note IS NULL AND created_at>=?').bind(p.id, now - 7 * 86400000).first()).n,
      id: p.id, name: p.name, job_role: p.job_role,
      attendance: open ? (open.status === 'open' ? 'checked_in' : 'missing_checkout') : todayAtt.n ? 'done_for_today' : 'not_in',
      since: open?.check_in_at || null,
      active_task: sess ? { id: sess.task_id, name: sess.name, url: sess.url, due_ms: sess.due_ms, kind: sess.kind, since: sess.start_ms } : null,
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
    `SELECT d.id,d.employee_id,e.name employee,d.created_at,d.link,d.completed,d.pending,d.is_complete,d.taskless_reason,d.review_note,d.check_json,d.task_id,t.name task_name,t.url task_url,t.status task_status
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
  let visible = null; // null = all submissions; otherwise only these employees'
  if (emp.role === 'employee') {
    const mine = await env.DB.prepare('SELECT 1 FROM task_assignees WHERE task_id=? AND clickup_user_id=?').bind(t.id, emp.clickup_user_id || '').first();
    if (!mine) throw forbidden();
    visible = [emp.id];
  } else await assertManagesTask(ctx, t.id);
  const events = (await env.DB.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY at_ms,id').bind(t.id).all()).results;
  const map = await statusMap(env.DB);
  const due = events.filter((e) => e.kind === 'due');
  const dls = deliveries(events, map);
  const dl = applicableDeadline(due);
  const owner = (await env.DB.prepare('SELECT e.id,e.name,e.job_role FROM task_assignees ta JOIN employees e ON e.clickup_user_id=ta.clickup_user_id WHERE ta.task_id=? AND ta.end_ms IS NULL').bind(t.id).all()).results;
  const subs = (await env.DB.prepare('SELECT d.id,d.employee_id,e.name employee,d.created_at,d.link,d.completed,d.pending,d.review_note,d.check_json FROM deposits d JOIN employees e ON e.id=d.employee_id WHERE d.task_id=? ORDER BY d.created_at DESC LIMIT 100').bind(t.id).all()).results
    .filter((d) => !visible || visible.includes(d.employee_id));
  const ses = (await env.DB.prepare('SELECT employee_id,kind,start_ms,end_ms FROM task_sessions WHERE task_id=? ORDER BY start_ms').bind(t.id).all()).results
    .filter((s) => !visible || visible.includes(s.employee_id));
  const now = ctx.now;
  const byDay = new Map(); let orig = 0, rev = 0;
  for (const s of ses) {
    const ms = Math.max(0, (s.end_ms ?? now) - s.start_ms);
    const d = localDate(s.start_ms);
    const row = byDay.get(d) || { date: d, original_ms: 0, revision_ms: 0 };
    if (s.kind === 'revision') { row.revision_ms += ms; rev += ms; } else { row.original_ms += ms; orig += ms; }
    byDay.set(d, row);
  }
  // plain-language story, newest first
  const story = [];
  const who = new Map((await env.DB.prepare('SELECT clickup_user_id id,name FROM employees WHERE clickup_user_id IS NOT NULL').all()).results.map((r) => [r.id, r.name]));
  let dueNow = null;
  for (const e of events) {
    if (e.kind === 'assignee_add') story.push({ at: e.at_ms, text: `Assigned to ${who.get(e.to_val) || 'someone'}` });
    else if (e.kind === 'status' && e.note !== 'approx') story.push({ at: e.at_ms, text: `Moved to ${e.to_val}` });
    else if (e.kind === 'status') story.push({ at: e.at_ms, text: `Now ${e.to_val} (exact time not known)`, approx: true });
    else if (e.kind === 'due') {
      const to = e.to_val ? Number(e.to_val) : null;
      if (dueNow != null && to != null) story.push({ at: e.at_ms, text: 'Deadline moved', from_ms: dueNow, to_ms: to, before_due: e.at_ms <= dueNow });
      else if (to != null) story.push({ at: e.at_ms, text: 'Deadline set', to_ms: to });
      dueNow = to;
    }
  }
  for (const d of dls) story.push({ at: d.at, text: d.kind === 'original' ? 'Ready for Upload (first delivery)' : 'Delivered again after changes' });
  for (const r of (await env.DB.prepare('SELECT notes,created_at FROM revisions WHERE task_id=?').bind(t.id).all()).results) story.push({ at: r.created_at, text: 'Changes requested', note: r.notes });
  story.sort((a, b) => b.at - a.at);
  return json({
    task: { id: t.id, name: t.name, url: t.url, status: t.status, due_ms: t.due_ms, list_name: t.list_name },
    assignees: owner,
    facts: { deadline_ms: dl.deadline, original_deadline_ms: dl.original ?? null, first_ready_ms: dls[0]?.at ?? null, original_ms: orig, revision_ms: rev, last_update_ms: subs[0]?.created_at ?? null },
    submissions: subs, time_by_day: [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date)), story,
    deliveries: dls, deadline: dl,
    revisions: (await env.DB.prepare('SELECT id,notes,links,created_at,due_ms,clickup_status FROM revisions WHERE task_id=? ORDER BY created_at').bind(t.id).all()).results,
  });
}
