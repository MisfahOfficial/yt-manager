// Loads facts from D1, runs the pure engine, and rewrites derived task_sessions for one employee.
import { computeSessions, shiftWindows, statusTimeline, deliveries, classify, DEFAULT_STATUS_MAP } from './lib/timer.js';
import { localDate, localMidnightMs, addDays } from './lib/time.js';
import { getSetting } from './http.js';

export const MAX_OPEN_MS = 18 * 3600000;

const IN_CHUNK = 80;
const inList = (n) => Array.from({ length: n }, () => '?').join(',');
async function inChunks(ids, run) { const out = []; for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(...(await run(ids.slice(i, i + IN_CHUNK))).results); return out; }

export async function loadTasksByIds(db, ids) {
  const rows = await inChunks(ids, (c) => db.prepare(`SELECT id,name,url,list_name,status FROM tasks WHERE id IN (${inList(c.length)})`).bind(...c).all());
  return new Map(rows.map((r) => [r.id, r]));
}
export async function loadEventsByTask(db, ids) {
  const rows = await inChunks(ids, (c) => db.prepare(`SELECT * FROM task_events WHERE task_id IN (${inList(c.length)}) ORDER BY at_ms,id`).bind(...c).all());
  const m = new Map(ids.map((i) => [i, []]));
  for (const r of rows) m.get(r.task_id)?.push(r);
  return m;
}
// Only the tasks that can matter for a time window: assigned during it, and either still open or touched inside it.
export async function relevantTasks(db, clickupId, fromMs, toMs, map) {
  const ids = (await db.prepare('SELECT DISTINCT task_id FROM task_assignees WHERE clickup_user_id=? AND start_ms<? AND (end_ms IS NULL OR end_ms>?)').bind(clickupId, toMs, fromMs).all()).results.map((r) => r.task_id);
  const tasks = await loadTasksByIds(db, ids);
  const finished = [];
  const keep = new Set();
  for (const id of ids) { const t = tasks.get(id); const cls = classify(t?.status, map); if (!t || cls === 'done' || cls === 'ignore') finished.push(id); else keep.add(id); }
  if (finished.length) for (const r of await inChunks(finished, (c) => db.prepare(`SELECT DISTINCT task_id FROM task_events WHERE task_id IN (${inList(c.length)}) AND at_ms>=? AND at_ms<?`).bind(...c, fromMs, toMs).all())) keep.add(r.task_id);
  return { ids: [...keep], tasks };
}

export async function loadShiftContext(db, employeeId, fromMs, toMs) {
  const asg = (await db.prepare(
    `SELECT es.effective_from,es.effective_to,s.start_min,s.end_min,s.days_mask,s.break_min,s.grace_min
       FROM employee_shifts es JOIN shifts s ON s.id=es.shift_id WHERE es.employee_id=?`).bind(employeeId).all()).results
    .map((r) => ({ effective_from: r.effective_from, effective_to: r.effective_to, shift: r }));
  const leaves = (await db.prepare('SELECT date_from,date_to FROM leave WHERE employee_id=?').bind(employeeId).all()).results;
  const ot = (await db.prepare('SELECT start_ms,end_ms FROM overtime WHERE employee_id=? AND end_ms>? AND start_ms<?').bind(employeeId, fromMs, toMs).all()).results;
  const windows = shiftWindows(asg, leaves, fromMs, toMs);
  return { asg, leaves, windows, overtime: ot.map((o) => ({ start: o.start_ms, end: o.end_ms })) };
}

// Effective end of an attendance row for calculations.
export function attendanceEnd(a, windows, now) {
  if (a.check_out_at != null) return a.check_out_at;
  if (a.status === 'missing_checkout') {
    const w = windows.find((x) => x.start <= a.check_in_at && a.check_in_at < x.end);
    return w ? Math.min(w.end, now) : a.check_in_at; // never invent time beyond the approved window
  }
  return now;
}

// Status meanings: built-ins < workspace-wide overrides < overrides for this person's job role.
export async function statusMap(db, jobRole = null) {
  const base = { ...DEFAULT_STATUS_MAP, ...(await getSetting(db, 'status_map', {})) };
  if (!jobRole) return base;
  const per = await getSetting(db, 'role_status_maps', {});
  const k = String(jobRole).toLowerCase();
  return { ...base, ...(Object.prototype.hasOwnProperty.call(per, k) ? per[k] : {}) };
}

export async function rebuildEmployee(env, employeeId, sinceMs, now = Date.now()) {
  const db = env.DB;
  const emp = await db.prepare('SELECT id,clickup_user_id,job_role FROM employees WHERE id=?').bind(employeeId).first();
  if (!emp) return;
  const since = localMidnightMs(addDays(localDate(Math.min(sinceMs, now)), -1));
  const ctxShift = await loadShiftContext(db, employeeId, since, now + 86400000);
  const attRows = (await db.prepare(
    `SELECT * FROM attendance WHERE employee_id=? AND (check_out_at IS NULL OR check_out_at>?) AND check_in_at<=?`).bind(employeeId, since, now).all()).results;
  const attendance = attRows.map((a) => ({ start: a.check_in_at, end: attendanceEnd(a, ctxShift.windows, now), open: a.status === 'open' }));
  const windows = [...ctxShift.windows, ...ctxShift.overtime];
  const map = await statusMap(db, emp.job_role);

  const tasks = [];
  if (emp.clickup_user_id) {
    const { ids } = await relevantTasks(db, emp.clickup_user_id, since - 86400000, now + 1, map);
    const evMap = await loadEventsByTask(db, ids);
    const asgRows = await inChunks(ids, (c) => db.prepare(`SELECT task_id,start_ms,end_ms,start_known FROM task_assignees WHERE clickup_user_id=? AND task_id IN (${inList(c.length)})`).bind(emp.clickup_user_id, ...c).all());
    for (const id of ids) {
      const events = evMap.get(id) || [];
      const asg = asgRows.filter((a) => a.task_id === id).map((a) => ({ start: a.start_known ? a.start_ms : 0, end: a.end_ms ?? Infinity }));
      tasks.push({ id, timeline: statusTimeline(events, map), assigned: asg, deliveredAt: deliveries(events, map).map((d) => d.at) });
    }
  }
  const choices = (await db.prepare('SELECT task_id,at_ms FROM active_choices WHERE employee_id=? AND at_ms>=?').bind(employeeId, since).all()).results;
  const out = computeSessions({ attendance, windows, tasks, choices, now });
  const existing = (await db.prepare('SELECT task_id,kind,start_ms,end_ms,end_reason FROM task_sessions WHERE employee_id=? AND (end_ms IS NULL OR end_ms>?) ORDER BY start_ms,task_id').bind(employeeId, since).all()).results;
  const same = (a, b) => a.length === b.length && a.every((x, i) => x.task_id === b[i].task_id && x.kind === b[i].kind && x.start_ms === b[i].start && (x.end_ms ?? null) === (b[i].end ?? null) && (x.end_reason ?? null) === (b[i].reason ?? null));
  const fresh = out.sessions.slice().sort((a, b) => a.start - b.start || String(a.task_id).localeCompare(String(b.task_id)));
  if (same(existing, fresh)) return out; // nothing changed: write nothing
  const stmts = [
    db.prepare('DELETE FROM task_sessions WHERE employee_id=? AND (end_ms IS NULL OR end_ms>?)').bind(employeeId, since),
    ...out.sessions.map((s) => db.prepare('INSERT INTO task_sessions(employee_id,task_id,kind,start_ms,end_ms,end_reason) VALUES (?,?,?,?,?,?)')
      .bind(employeeId, s.task_id, s.kind, s.start, s.end, s.reason)),
  ];
  await db.batch(stmts);
  return out;
}

export async function rebuildForTask(env, taskId, sinceMs, now = Date.now()) {
  const rows = (await env.DB.prepare(
    'SELECT DISTINCT e.id FROM task_assignees ta JOIN employees e ON e.clickup_user_id=ta.clickup_user_id WHERE ta.task_id=?').bind(taskId).all()).results;
  for (const r of rows) await rebuildEmployee(env, r.id, sinceMs, now);
}

// Flags forgotten check-outs. Runs from cron and before every check-in.
export async function sweepMissingCheckouts(db, now) {
  await db.prepare("UPDATE attendance SET status='missing_checkout' WHERE status='open' AND check_in_at<?").bind(now - MAX_OPEN_MS).run();
}

// The employee-facing "what is running now" view.
export async function activeState(env, employeeId, now = Date.now()) {
  const out = await rebuildEmployee(env, employeeId, now, now);
  const open = out?.sessions.find((s) => s.end == null);
  const amb = out?.ambiguous.find((a) => a.end >= now);
  return { active: open || null, ambiguous: amb || null };
}
