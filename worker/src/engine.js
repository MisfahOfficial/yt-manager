// Loads facts from D1, runs the pure engine, and rewrites derived task_sessions for one employee.
import { computeSessions, shiftWindows, statusTimeline, deliveries, DEFAULT_STATUS_MAP } from './lib/timer.js';
import { localDate, localMidnightMs, addDays } from './lib/time.js';
import { getSetting } from './http.js';

export const MAX_OPEN_MS = 18 * 3600000;

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
  return { ...base, ...(per[String(jobRole).toLowerCase()] || {}) };
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
    const taskIds = (await db.prepare(
      'SELECT DISTINCT task_id FROM task_assignees WHERE clickup_user_id=? AND (end_ms IS NULL OR end_ms>?)').bind(emp.clickup_user_id, since).all()).results.map((r) => r.task_id);
    for (const id of taskIds) {
      const events = (await db.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY at_ms,id').bind(id).all()).results;
      const asg = (await db.prepare('SELECT start_ms,end_ms,start_known FROM task_assignees WHERE task_id=? AND clickup_user_id=?').bind(id, emp.clickup_user_id).all()).results
        .map((a) => ({ start: a.start_known ? a.start_ms : 0, end: a.end_ms ?? Infinity }));
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
