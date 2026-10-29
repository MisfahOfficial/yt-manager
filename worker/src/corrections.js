// Corrections workflow. Rule: nobody changes their own record. People ask; the right person decides.
//   employee's request   -> their manager (if the manager may correct) or the Owner
//   manager's own request -> the Owner only
import { HttpError, bad, conflict, forbidden, notFound, json, str, int, auditStmt } from './http.js';
import { uuid } from './lib/crypto.js';
import { rebuildEmployee } from './engine.js';
import { teamIds } from './work.js';

// Who may decide a correction about `subjectId`?
export async function canDecide(ctx, subjectId) {
  const { emp, env } = ctx;
  if (emp.role === 'admin') return true;                       // the Owner decides anything
  if (emp.id === subjectId) return false;                      // nobody edits their own record
  if (emp.role !== 'manager' || !emp.can_correct) return false;
  const s = await env.DB.prepare('SELECT manager_id,role FROM employees WHERE id=?').bind(subjectId).first();
  return !!s && s.manager_id === emp.id && s.role === 'employee'; // managers decide only for their own team members, never for other managers
}

export async function createRequest(ctx) {
  const { env, emp, now, body } = ctx;
  const att = await env.DB.prepare('SELECT * FROM attendance WHERE id=?').bind(str(body.attendance_id, 'record', { max: 64 })).first();
  if (!att || att.employee_id !== emp.id) throw notFound('That record is not yours.');
  const reason = str(body.reason, 'reason', { min: 5, max: 500 });
  const ci = body.check_in_at == null ? null : int(body.check_in_at, 'check-in time', { min: 1e12 });
  const co = body.check_out_at == null ? null : int(body.check_out_at, 'check-out time', { min: 1e12 });
  if (ci == null && co == null) throw bad('nothing', 'Say which time should change.');
  if ((co ?? att.check_out_at ?? now) <= (ci ?? att.check_in_at)) throw bad('bad_times', 'Check-out must be after check-in.');
  if ((ci ?? 0) > now || (co ?? 0) > now) throw bad('future_time', 'Times cannot be in the future.');
  const dup = await env.DB.prepare("SELECT id FROM correction_requests WHERE attendance_id=? AND status='pending'").bind(att.id).first();
  if (dup) throw conflict('already_asked', 'You already sent a request for this day.');
  const id = uuid();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO correction_requests(id,employee_id,attendance_id,req_check_in,req_check_out,reason,status,created_at) VALUES (?,?,?,?,?,?, 'pending', ?)").bind(id, emp.id, att.id, ci, co, reason, now),
    env.DB.prepare('UPDATE attendance SET asked_at=NULL WHERE id=?').bind(att.id),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'correction_requested', entity: 'attendance', entityId: att.id, after: { check_in_at: ci, check_out_at: co }, reason }),
  ]);
  return json({ ok: true, id });
}

// Employees: their own. Managers: their team's requests they may decide (never their own, never other managers'). Owner: everything.
export async function listRequests(ctx) {
  const { env, emp } = ctx;
  const status = ctx.url.searchParams.get('status') || 'pending';
  let where = 'c.employee_id=?', binds = [emp.id];
  if (emp.role === 'admin') { where = '1=1'; binds = []; }
  else if (emp.role === 'manager' && emp.can_correct) {
    const mates = (await env.DB.prepare("SELECT id FROM employees WHERE manager_id=? AND role='employee' AND active=1").bind(emp.id).all()).results.map((r) => r.id);
    where = `(c.employee_id=? OR c.employee_id IN (${mates.map(() => '?').join(',') || "''"}))`; binds = [emp.id, ...mates];
  }
  const rows = (await env.DB.prepare(
    `SELECT c.id,c.employee_id,e.name employee,e.role employee_role,c.attendance_id,c.req_check_in,c.req_check_out,c.reason,c.status,c.created_at,c.decided_at,c.decision_note,
            a.check_in_at,a.check_out_at,a.status att_status
       FROM correction_requests c JOIN employees e ON e.id=c.employee_id JOIN attendance a ON a.id=c.attendance_id
      WHERE ${where} AND (?='all' OR c.status=?) ORDER BY c.created_at DESC LIMIT 100`).bind(...binds, status, status).all()).results;
  const out = [];
  for (const r of rows) out.push({ ...r, can_decide: await canDecide(ctx, r.employee_id) });
  return json({ requests: out });
}

export async function decide(ctx) {
  const { env, emp, now, body, params } = ctx;
  const r = await env.DB.prepare('SELECT * FROM correction_requests WHERE id=?').bind(params.id).first();
  if (!r) throw notFound();
  if (r.status !== 'pending') throw conflict('decided', 'That request was already decided.');
  if (!(await canDecide(ctx, r.employee_id))) throw forbidden('cannot_decide', r.employee_id === emp.id ? 'You cannot decide on your own record. The Owner does that.' : 'You are not allowed to decide this.');
  const note = str(body.note, 'note', { optional: true, max: 500 });
  const att = await env.DB.prepare('SELECT * FROM attendance WHERE id=?').bind(r.attendance_id).first();
  if (!body.approve) {
    await env.DB.batch([
      env.DB.prepare("UPDATE correction_requests SET status='declined',decided_by=?,decided_at=?,decision_note=? WHERE id=?").bind(emp.id, now, note, r.id),
      auditStmt(env.DB, { at: now, actor: emp.id, action: 'correction_declined', entity: 'attendance', entityId: att.id, reason: note }),
    ]);
    return json({ ok: true, status: 'declined' });
  }
  const ci = r.req_check_in ?? att.check_in_at, co = r.req_check_out ?? att.check_out_at;
  if (co != null && co <= ci) throw bad('bad_times', 'Check-out must be after check-in.');
  const overlap = await env.DB.prepare('SELECT id FROM attendance WHERE employee_id=? AND id<>? AND check_in_at<? AND COALESCE(check_out_at,?)>?').bind(att.employee_id, att.id, co ?? now, now, ci).first();
  if (overlap) throw conflict('overlap', 'That overlaps another attendance record.');
  const status = co == null ? att.status : 'closed';
  await env.DB.batch([
    env.DB.prepare('UPDATE attendance SET check_in_at=?,check_out_at=?,status=?,corrected=1,asked_at=NULL WHERE id=?').bind(ci, co, status, att.id),
    env.DB.prepare("UPDATE correction_requests SET status='approved',decided_by=?,decided_at=?,decision_note=? WHERE id=?").bind(emp.id, now, note, r.id),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'attendance_corrected', entity: 'attendance', entityId: att.id,
      before: { check_in_at: att.check_in_at, check_out_at: att.check_out_at, status: att.status }, after: { check_in_at: ci, check_out_at: co, status }, reason: `Approved request: ${r.reason}` }),
  ]);
  await rebuildEmployee(env, att.employee_id, Math.min(ci, att.check_in_at), now);
  return json({ ok: true, status: 'approved' });
}

// "Ask Ali": a manager/owner asks the person to confirm a missing check-out. The person sees it on Today.
export async function askEmployee(ctx) {
  const { env, emp, now, params } = ctx;
  const att = await env.DB.prepare('SELECT * FROM attendance WHERE id=?').bind(params.id).first();
  if (!att) throw notFound();
  const allowed = emp.role === 'admin' || (att.employee_id !== emp.id && (await teamIds(ctx)).includes(att.employee_id));
  if (!allowed) throw forbidden();
  await env.DB.batch([
    env.DB.prepare('UPDATE attendance SET asked_at=?,asked_by=? WHERE id=?').bind(now, emp.id, att.id),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'asked_to_confirm', entity: 'attendance', entityId: att.id }),
  ]);
  return json({ ok: true });
}
