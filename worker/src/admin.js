import { HttpError, bad, forbidden, notFound, conflict, json, str, int, httpUrl, audit, auditStmt, getSetting, setSettingStmt } from './http.js';
import { newPasswordRecord, uuid } from './lib/crypto.js';
import { tempPassword } from './auth.js';
import { validIpRule } from './lib/net.js';
import { isYmd, localDate, localMidnightMs } from './lib/time.js';
import { rebuildEmployee, statusMap } from './engine.js';
import { classify } from './lib/timer.js';
import { rebuildLinked } from './clickup.js';
import { clientIp } from './attendance.js';
import { teamIds } from './work.js';

const ROLES = ['employee', 'manager', 'admin'];
const pub = (e) => ({ id: e.id, name: e.name, email: e.email, role: e.role, job_role: e.job_role, can_correct: !!e.can_correct, manager_id: e.manager_id, active: !!e.active, clickup_user_id: e.clickup_user_id, must_change_pw: !!e.must_change_pw });

export async function listEmployees(ctx) {
  const rows = (await ctx.env.DB.prepare('SELECT * FROM employees ORDER BY active DESC, name').all()).results;
  const sh = (await ctx.env.DB.prepare('SELECT employee_id,shift_id,effective_from,effective_to FROM employee_shifts ORDER BY effective_from').all()).results;
  const dv = (await ctx.env.DB.prepare("SELECT employee_id,status FROM devices WHERE status IN ('approved','pending')").all()).results;
  return json({ employees: rows.map((e) => ({ ...pub(e), shifts: sh.filter((s) => s.employee_id === e.id), device: dv.find((d) => d.employee_id === e.id && d.status === 'approved') ? 'approved' : dv.find((d) => d.employee_id === e.id) ? 'pending' : 'none' })) });
}

export async function createEmployee(ctx) {
  const { env, body, now, emp } = ctx;
  const name = str(body.name, 'name', { max: 100 });
  const email = str(body.email, 'email', { max: 200 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('invalid_email', 'Email is not valid.');
  const role = body.role || 'employee';
  if (!ROLES.includes(role)) throw bad('invalid_role', 'Role is not valid.');
  const pw = tempPassword();
  const rec = await newPasswordRecord(pw, +env.PBKDF2_ITER || 100000);
  const id = uuid();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO employees(id,name,email,role,job_role,manager_id,pw_hash,pw_salt,pw_iter,must_change_pw,clickup_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)')
        .bind(id, name, email, role, str(body.job_role, 'job role', { optional: true, max: 40 }), body.manager_id || null, rec.pw_hash, rec.pw_salt, rec.pw_iter, body.clickup_user_id ? String(body.clickup_user_id) : null, now),
      auditStmt(env.DB, { at: now, actor: emp.id, action: 'employee_created', entity: 'employee', entityId: id, after: { name, email, role } }),
    ]);
  } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict('duplicate', 'That email or ClickUp user is already used.'); throw e; }
  return json({ ok: true, id, temp_password: pw }); // shown once
}

export async function updateEmployee(ctx) {
  const { env, body, now, emp, params } = ctx;
  const before = await env.DB.prepare('SELECT * FROM employees WHERE id=?').bind(params.id).first();
  if (!before) throw notFound();
  const next = { ...before };
  if (body.name != null) next.name = str(body.name, 'name', { max: 100 });
  if (body.email != null) { next.email = str(body.email, 'email', { max: 200 }).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.email)) throw bad('invalid_email', 'Email is not valid.'); }
  if (body.role != null) { if (!ROLES.includes(body.role)) throw bad('invalid_role'); next.role = body.role; }
  if (body.job_role !== undefined) next.job_role = str(body.job_role, 'job role', { optional: true, max: 40 });
  if (body.can_correct != null) next.can_correct = body.can_correct ? 1 : 0;
  if (body.manager_id !== undefined) next.manager_id = body.manager_id || null;
  if (body.clickup_user_id !== undefined) next.clickup_user_id = body.clickup_user_id ? String(body.clickup_user_id) : null;
  if (body.active != null) next.active = body.active ? 1 : 0;
  if (before.id === emp.id && (next.role !== 'admin' || !next.active)) throw bad('self_lockout', 'You cannot remove your own admin access.');
  if (next.manager_id === before.id) throw bad('bad_manager', 'Someone cannot manage themselves.');
  const stmts = [
    env.DB.prepare('UPDATE employees SET name=?,email=?,role=?,job_role=?,can_correct=?,manager_id=?,clickup_user_id=?,active=? WHERE id=?').bind(next.name, next.email, next.role, next.job_role, next.can_correct, next.manager_id, next.clickup_user_id, next.active, before.id),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'employee_updated', entity: 'employee', entityId: before.id, before: pub(before), after: pub(next) }),
  ];
  if (!next.active) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE employee_id=?').bind(before.id));
  try { await env.DB.batch(stmts); } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict('duplicate', 'That ClickUp user is already mapped to someone else.'); throw e; }
  if (before.clickup_user_id !== next.clickup_user_id) await rebuildEmployee(env, before.id, now - 7 * 86400000, now);
  return json({ ok: true });
}

export async function resetPassword(ctx) {
  const { env, now, emp, params } = ctx;
  const e = await env.DB.prepare('SELECT id FROM employees WHERE id=?').bind(params.id).first();
  if (!e) throw notFound();
  const pw = tempPassword();
  const rec = await newPasswordRecord(pw, +env.PBKDF2_ITER || 100000);
  await env.DB.batch([
    env.DB.prepare('UPDATE employees SET pw_hash=?,pw_salt=?,pw_iter=?,must_change_pw=1 WHERE id=?').bind(rec.pw_hash, rec.pw_salt, rec.pw_iter, e.id),
    env.DB.prepare('DELETE FROM sessions WHERE employee_id=?').bind(e.id),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'password_reset', entity: 'employee', entityId: e.id }),
  ]);
  return json({ ok: true, temp_password: pw });
}

// ---- shifts / leave / overtime ----
export async function listShifts(ctx) { return json({ shifts: (await ctx.env.DB.prepare('SELECT * FROM shifts ORDER BY name').all()).results }); }
export async function saveShift(ctx) {
  const { env, body, now, emp } = ctx;
  const id = body.id ? String(body.id) : uuid();
  const s = { name: str(body.name, 'name', { max: 60 }), start_min: int(body.start_min, 'start', { min: 0, max: 1439 }), end_min: int(body.end_min, 'end', { min: 0, max: 1439 }),
    days_mask: int(body.days_mask, 'days', { min: 1, max: 127 }), break_min: int(body.break_min ?? 0, 'break', { min: 0, max: 240 }), grace_min: int(body.grace_min ?? 10, 'grace', { min: 0, max: 120 }) };
  if (s.start_min === s.end_min) throw bad('bad_shift', 'Start and end cannot be the same.');
  const before = await env.DB.prepare('SELECT * FROM shifts WHERE id=?').bind(id).first();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO shifts(id,name,start_min,end_min,days_mask,break_min,grace_min) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,start_min=excluded.start_min,end_min=excluded.end_min,days_mask=excluded.days_mask,break_min=excluded.break_min,grace_min=excluded.grace_min')
      .bind(id, s.name, s.start_min, s.end_min, s.days_mask, s.break_min, s.grace_min),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'shift_saved', entity: 'shift', entityId: id, before, after: s }),
  ]);
  return json({ ok: true, id });
}
export async function assignShift(ctx) {
  const { env, body, now, emp, params } = ctx;
  if (!isYmd(body.effective_from)) throw bad('bad_date', 'Start date is not valid.');
  const shift = await env.DB.prepare('SELECT id FROM shifts WHERE id=?').bind(body.shift_id).first();
  if (!shift) throw bad('no_shift', 'Pick a shift.');
  const from = body.effective_from;
  await env.DB.batch([
    // close the currently open assignment the day before the new one starts
    env.DB.prepare("UPDATE employee_shifts SET effective_to=date(?, '-1 day') WHERE employee_id=? AND effective_to IS NULL AND effective_from<?").bind(from, params.id, from),
    env.DB.prepare('INSERT INTO employee_shifts(employee_id,shift_id,effective_from,effective_to) VALUES (?,?,?,NULL)').bind(params.id, shift.id, from),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'shift_assigned', entity: 'employee', entityId: params.id, after: { shift_id: shift.id, effective_from: from } }),
  ]);
  await rebuildEmployee(env, params.id, localMidnightMs(from), now);
  return json({ ok: true });
}
export async function addLeave(ctx) {
  const { env, body, now, emp, params } = ctx;
  if (!isYmd(body.date_from) || !isYmd(body.date_to) || body.date_to < body.date_from) throw bad('bad_date', 'Dates are not valid.');
  const reason = str(body.reason, 'reason', { optional: true, max: 200 });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO leave(employee_id,date_from,date_to,reason,created_by,created_at) VALUES (?,?,?,?,?,?)').bind(params.id, body.date_from, body.date_to, reason, emp.id, now),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'leave_added', entity: 'employee', entityId: params.id, after: { from: body.date_from, to: body.date_to, reason } }),
  ]);
  await rebuildEmployee(env, params.id, localMidnightMs(body.date_from), now);
  return json({ ok: true });
}
export async function addOvertime(ctx) {
  const { env, body, now, emp, params } = ctx;
  const s = int(body.start_ms, 'start', { min: 1e12 }), e = int(body.end_ms, 'end', { min: 1e12 });
  if (e <= s || e - s > 12 * 3600000) throw bad('bad_range', 'Overtime must be under 12 hours.');
  const reason = str(body.reason, 'reason', { min: 5, max: 200 });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO overtime(employee_id,start_ms,end_ms,reason,created_by,created_at) VALUES (?,?,?,?,?,?)').bind(params.id, s, e, reason, emp.id, now),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'overtime_authorised', entity: 'employee', entityId: params.id, after: { s, e }, reason }),
  ]);
  await rebuildEmployee(env, params.id, s, now);
  return json({ ok: true });
}

// ---- devices ----
export async function listDevices(ctx) {
  const rows = (await ctx.env.DB.prepare('SELECT d.id,d.employee_id,e.name employee,d.label,d.status,d.created_at,d.decided_at FROM devices d JOIN employees e ON e.id=d.employee_id ORDER BY CASE d.status WHEN \'pending\' THEN 0 WHEN \'approved\' THEN 1 ELSE 2 END, d.created_at DESC LIMIT 200').all()).results;
  return json({ devices: rows });
}
export async function approveDevice(ctx) {
  const { env, now, emp, params, body } = ctx;
  const d = await env.DB.prepare('SELECT * FROM devices WHERE id=?').bind(params.id).first();
  if (!d || d.status !== 'pending') throw notFound('No pending request found.');
  const reason = str(body.reason, 'reason', { optional: true, max: 200 });
  const prev = await env.DB.prepare("SELECT id FROM devices WHERE employee_id=? AND status='approved'").bind(d.employee_id).first();
  if (prev && !body.replace) throw conflict('has_device', 'This person already has an approved device. Confirm replacing it.', { current: prev.id });
  await env.DB.batch([
    env.DB.prepare("UPDATE devices SET status='revoked',decided_by=?,decided_at=? WHERE employee_id=? AND status='approved'").bind(emp.id, now, d.employee_id),
    env.DB.prepare("UPDATE devices SET status='approved',decided_by=?,decided_at=? WHERE id=?").bind(emp.id, now, d.id),
    auditStmt(env.DB, { at: now, actor: emp.id, action: prev ? 'device_replaced' : 'device_approved', entity: 'device', entityId: d.id, before: prev ? { revoked: prev.id } : null, after: { employee_id: d.employee_id }, reason }),
  ]);
  return json({ ok: true });
}
export async function revokeDevice(ctx) {
  const { env, now, emp, params, body } = ctx;
  const d = await env.DB.prepare('SELECT * FROM devices WHERE id=?').bind(params.id).first();
  if (!d) throw notFound();
  const reason = str(body.reason, 'reason', { min: 3, max: 200 });
  await env.DB.batch([
    env.DB.prepare("UPDATE devices SET status='revoked',decided_by=?,decided_at=? WHERE id=?").bind(emp.id, now, d.id),
    auditStmt(env.DB, { at: now, actor: emp.id, action: 'device_revoked', entity: 'device', entityId: d.id, before: { status: d.status }, reason }),
  ]);
  return json({ ok: true });
}

// ---- settings ----
const SETTING_KEYS = {
  office_ips: (v) => { if (!Array.isArray(v) || v.length > 20 || !v.every((x) => typeof x === 'string' && validIpRule(x))) throw bad('bad_ips', 'Enter valid IP addresses or ranges.'); return v.map((x) => x.trim()); },
  sync_time_min: (v) => int(v, 'sync time', { min: 0, max: 1439 }),
  clickup_team_id: (v) => str(String(v), 'workspace', { max: 40 }),
  revisions_status: (v) => (v ? str(v, 'status', { max: 60 }) : null),
  status_map: (v) => { if (!v || typeof v !== 'object') throw bad('bad_map'); const ok = ['active', 'revision', 'paused', 'done', 'other', 'ignore']; for (const [k, c] of Object.entries(v)) if (!ok.includes(c) || k.length > 60) throw bad('bad_map', 'Status mapping is not valid.'); return Object.fromEntries(Object.entries(v).map(([k, c]) => [k.toLowerCase().trim(), c])); },
  auto_reports: (v) => !!v,
  created_tracking_jobs: (v) => { if (!Array.isArray(v) || v.length > 10) throw bad('bad_jobs', 'Job list is not valid.'); return v.map((x) => str(x, 'job', { max: 40 })); },
  script_checks: (v) => {
    if (!v || typeof v !== 'object' || !v.jobs || typeof v.jobs !== 'object') throw bad('bad_checks', 'Script check settings are not valid.');
    const types = ['ref_images', 'links', 'images', 'text', 'words', 'desc_links', 'desc_items', 'desc_words'];
    const jobs = {};
    for (const [job, cfg] of Object.entries(v.jobs)) {
      if (job.length > 40 || !Array.isArray(cfg.rules) || cfg.rules.length > 12) throw bad('bad_checks', 'Script check settings are not valid.');
      jobs[job.toLowerCase().trim()] = { rules: cfg.rules.map((r, i) => {
        if (!types.includes(r.type)) throw bad('bad_checks', 'Unknown check type.');
        const min = r.type === 'text' ? null : int(r.min ?? 1, 'minimum', { min: 1, max: 100000 });
        if (r.type === 'text' && !String(r.value || '').trim()) throw bad('bad_checks', 'Type the words that must appear.');
        return { id: String(r.id || 'r' + (i + 1)).slice(0, 20), label: str(r.label, 'check name', { max: 80 }), type: r.type, min, value: str(r.value, 'words', { optional: true, max: 300 }) };
      }) };
    }
    return { jobs };
  },
  role_status_maps: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('bad_map');
    const out = {};
    for (const [role, m] of Object.entries(v)) { if (role.length > 40) throw bad('bad_map'); out[role.toLowerCase().trim()] = SETTING_KEYS.status_map(m); }
    return out;
  },
};
export async function getSettings(ctx) {
  const out = {};
  for (const k of Object.keys(SETTING_KEYS)) out[k] = await getSetting(ctx.env.DB, k, k === 'sync_time_min' ? 1110 : k === 'office_ips' ? [] : k === 'status_map' ? {} : k === 'auto_reports' ? true : k === 'role_status_maps' ? {} : k === 'script_checks' ? { jobs: {} } : k === 'created_tracking_jobs' ? [] : null);
  return json({ settings: out, detected_ip: clientIp(ctx.req) });
}
export async function putSettings(ctx) {
  const { env, body, now, emp } = ctx;
  const stmts = []; const changed = {};
  for (const [k, v] of Object.entries(body)) {
    if (!SETTING_KEYS[k]) throw bad('unknown_setting', `Unknown setting ${k}.`);
    const val = SETTING_KEYS[k](v);
    changed[k] = { before: await getSetting(env.DB, k, null), after: val };
    stmts.push(setSettingStmt(env.DB, k, val));
  }
  if (!stmts.length) throw bad('nothing', 'Nothing to save.');
  stmts.push(auditStmt(env.DB, { at: now, actor: emp.id, action: 'settings_changed', entity: 'settings', before: Object.fromEntries(Object.entries(changed).map(([k, c]) => [k, c.before])), after: Object.fromEntries(Object.entries(changed).map(([k, c]) => [k, c.after])) }));
  await env.DB.batch(stmts);
  if (changed.status_map || changed.role_status_maps) await rebuildLinked(env, now); // new status meanings change recorded time
  return json({ ok: true });
}

export async function statusList(ctx) {
  const role = ctx.url.searchParams.get('role') || null;
  const map = await statusMap(ctx.env.DB, role);
  const rows = (await ctx.env.DB.prepare('SELECT lower(status) s, COUNT(*) n FROM tasks WHERE status IS NOT NULL AND deleted=0 GROUP BY lower(status) ORDER BY n DESC').all()).results;
  const roles = (await ctx.env.DB.prepare("SELECT DISTINCT job_role r FROM employees WHERE job_role IS NOT NULL AND job_role<>'' ORDER BY 1").all()).results.map((x) => x.r);
  return json({ statuses: rows.map((r) => ({ status: r.s, count: r.n, class: classify(r.s, map) })), roles });
}

// ---- network outage exception (time-boxed, audited, never silent) ----
export async function createNetworkException(ctx) {
  const { env, body, now, emp } = ctx;
  const reason = str(body.reason, 'reason', { min: 10, max: 300 });
  const hours = int(body.hours ?? 4, 'hours', { min: 1, max: 24 });
  const employeeId = body.employee_id ? String(body.employee_id) : null;
  const r = await env.DB.prepare('INSERT INTO network_exceptions(employee_id,reason,starts_at,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?)').bind(employeeId, reason, now, now + hours * 3600000, emp.id, now).run();
  await audit(env.DB, { at: now, actor: emp.id, action: 'network_exception_created', entity: 'network_exception', entityId: r.meta.last_row_id, after: { employee_id: employeeId, hours }, reason });
  return json({ ok: true, id: r.meta.last_row_id });
}
export async function listNetworkExceptions(ctx) {
  return json({ exceptions: (await ctx.env.DB.prepare('SELECT * FROM network_exceptions ORDER BY id DESC LIMIT 30').all()).results });
}
export async function revokeNetworkException(ctx) {
  const { env, now, emp, params } = ctx;
  await env.DB.prepare('UPDATE network_exceptions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(now, params.id).run();
  await audit(env.DB, { at: now, actor: emp.id, action: 'network_exception_revoked', entity: 'network_exception', entityId: params.id });
  return json({ ok: true });
}

export async function auditList(ctx) {
  const limit = Math.min(+ctx.url.searchParams.get('limit') || 100, 500);
  const rows = (await ctx.env.DB.prepare('SELECT a.*, e.name actor_name FROM audit_log a LEFT JOIN employees e ON e.id=a.actor_id ORDER BY a.id DESC LIMIT ?').bind(limit).all()).results;
  return json({ audit: rows });
}

// Attendance list for corrections (manager/admin; team-scoped)
export async function attendanceList(ctx) {
  const ids = await teamIds(ctx);
  const days = Math.min(+ctx.url.searchParams.get('days') || 14, 92);
  const rows = (await ctx.env.DB.prepare(
    `SELECT a.id,a.employee_id,e.name employee,a.check_in_at,a.check_out_at,a.status,a.corrected,a.checkout_exception FROM attendance a JOIN employees e ON e.id=a.employee_id
      WHERE a.employee_id IN (${ids.map(() => '?').join(',') || "''"}) AND a.check_in_at>=? ORDER BY a.check_in_at DESC LIMIT 400`).bind(...ids, Date.now() - days * 86400000).all()).results;
  return json({ attendance: rows });
}

// ---- legacy import (v1 getAll JSON shape). Old plaintext passwords are NEVER imported. ----
export async function importLegacy(ctx) {
  const { env, body, now, emp } = ctx;
  const members = Array.isArray(body.members) ? body.members : [];
  if (!members.length && !Array.isArray(body.attendance)) throw bad('empty', 'Nothing to import.');
  const out = { employees: [], temp_passwords: [], archived: 0 };
  const idMap = new Map();
  for (const m of members.slice(0, 200)) {
    const lid = String(m.id);
    const existing = await env.DB.prepare('SELECT id FROM employees WHERE legacy_id=?').bind(lid).first();
    if (existing) { idMap.set(lid, existing.id); continue; }
    const slug = String(m.name || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') || 'user';
    const email = `${slug}.${lid.replace(/[^a-z0-9]/gi, '')}@import.invalid`;
    const pw = tempPassword();
    const rec = await newPasswordRecord(pw, +env.PBKDF2_ITER || 100000);
    const id = uuid();
    await env.DB.prepare('INSERT INTO employees(id,legacy_id,name,email,role,pw_hash,pw_salt,pw_iter,must_change_pw,active,created_at) VALUES (?,?,?,?,?,?,?,?,1,1,?)')
      .bind(id, lid, String(m.name || 'Unnamed').slice(0, 100), email, m.isManager ? 'manager' : 'employee', rec.pw_hash, rec.pw_salt, rec.pw_iter, now).run();
    idMap.set(lid, id);
    out.employees.push({ id, name: m.name, email });
    out.temp_passwords.push({ name: m.name, email, temp_password: pw });
  }
  const arch = async (kind, rec, lidKey = 'id') => {
    const lid = rec[lidKey] != null ? String(rec[lidKey]) : (kind + ':' + (rec.memberId ?? '') + ':' + (rec.date ?? '') + ':' + (rec.clockIn ?? ''));
    const clean = { ...rec }; delete clean.password; delete clean.sheetPassword;
    const r = await env.DB.prepare('INSERT OR IGNORE INTO legacy_records(kind,legacy_id,employee_id,data_json,imported_at) VALUES (?,?,?,?,?)')
      .bind(kind, lid, idMap.get(String(rec.memberId ?? rec.id)) || null, JSON.stringify(clean), now).run();
    out.archived += r.meta.changes;
  };
  for (const m of members) await arch('member', m);
  for (const a of (body.attendance || []).slice(0, 20000)) await arch('attendance', a, '_none');
  for (const w of (body.workLogs || []).slice(0, 20000)) await arch('workLog', w);
  for (const t of (body.tasks || []).slice(0, 5000)) await arch('task', t);
  for (const v of (body.calVideos || body.videos || []).slice(0, 5000)) await arch('video', v);
  await audit(env.DB, { at: now, actor: emp.id, action: 'legacy_import', after: { employees: out.employees.length, archived: out.archived } });
  return json({ ok: true, ...out });
}
export async function legacyList(ctx) {
  const kind = ctx.url.searchParams.get('kind') || 'attendance';
  const rows = (await ctx.env.DB.prepare('SELECT legacy_id,employee_id,data_json FROM legacy_records WHERE kind=? ORDER BY id DESC LIMIT 500').bind(kind).all()).results;
  return json({ records: rows.map((r) => ({ ...JSON.parse(r.data_json), employee_id: r.employee_id })) });
}
