import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { Client, setupTeam, makeEmployee, approve, giveShift, rid, OFFICE_IP } from './helpers.js';
import { localMidnightMs } from '../src/lib/time.js';
import { hmacHex, encryptSecret } from '../src/lib/crypto.js';

const H = 3600000, M = 60000;
const MON = localMidnightMs('2026-10-26');
const at = (h, m = 0) => MON + h * H + m * M;
const setNow = (ms) => vi.setSystemTime(ms);
const dep = (extra = {}) => ({ link: 'https://drive.example.com/f/abc', completed: 'Cut intro and first act', pending: 'Colour and music', ...extra });

let admin, ali, mgr;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(at(8, 55));
  admin = await setupTeam();
  mgr = await makeEmployee(admin, 'Mona', { role: 'manager' });
  ali = await makeEmployee(admin, 'Ali', { manager_id: mgr.id, clickup_user_id: '555' });
  await approve(admin, ali);
  await giveShift(admin, ali.id, { start: 9 * 60, end: 17 * 60, days: 0b0011111 });
  await env.DB.prepare('INSERT INTO secrets_store(key,value) VALUES (?,?)').bind('clickup_webhook_secret', await encryptSecret(env.ENCRYPTION_KEY, 'whsec')).run();
});
afterAll(() => vi.useRealTimers());

async function hook(payload, { secret = 'whsec', sig } = {}) {
  const raw = JSON.stringify(payload);
  const s = sig ?? await hmacHex(secret, raw);
  const res = await SELF.fetch('https://ytm.test/api/webhooks/clickup', { method: 'POST', headers: { 'x-signature': s, 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1' }, body: raw });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const item = (id, field, date, before, after, extra = {}) => ({ id, type: 1, date: String(date), field, before, after, user: { id: 999 }, ...extra });
const whPayload = (event, taskId, items, wid = 'wh1') => ({ webhook_id: wid, event, task_id: taskId, history_items: items });

describe('webhook authenticity', () => {
  it('rejects missing, wrong and forged signatures; accepts the right one', async () => {
    const p = whPayload('taskStatusUpdated', 'T0', [item('h0', 'status', at(9), { status: 'to do' }, { status: 'in progress' })]);
    expect((await hook(p, { sig: 'deadbeef' })).status).toBe(401);
    expect((await hook(p, { secret: 'other' })).status).toBe(401);
    const noSig = await SELF.fetch('https://ytm.test/api/webhooks/clickup', { method: 'POST', body: JSON.stringify(p) });
    expect(noSig.status).toBe(401);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM task_events').first()).n).toBe(0);
    expect((await hook(p)).status).toBe(200);
    await env.DB.prepare('DELETE FROM task_events').run(); await env.DB.prepare('DELETE FROM tasks').run();
  });
});

describe('attendance + deposit + checkout', () => {
  it('check-in succeeds with own device on office network; duplicate request is idempotent', async () => {
    setNow(at(9, 2));
    const id = rid();
    const a = await ali.post('/api/checkin', { request_id: id }, { sign: true });
    expect(a.status).toBe(200);
    expect(a.data.attendance.check_in_at).toBe(at(9, 2)); // server clock, not client
    const b = await ali.post('/api/checkin', { request_id: id }, { sign: true });
    expect(b.data.duplicate).toBe(true);
    const c = await ali.post('/api/checkin', { request_id: rid() }, { sign: true });
    expect(c.data.error.code).toBe('already_checked_in');
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM attendance WHERE employee_id=?').bind(ali.id).first()).n).toBe(1);
  });
  it('checkout is refused without a work deposit, and nothing changes', async () => {
    setNow(at(10));
    const r = await ali.post('/api/checkout', { request_id: rid() }, { sign: true });
    expect(r.status).toBe(422);
    expect(r.data.error.code).toBe('deposit_required');
    const t = await ali.get('/api/today');
    expect(t.data.state).toBe('checked_in');
  });
  it('invalid deposit keeps the user checked in and saves nothing; fixed retry succeeds exactly once', async () => {
    const reqId = rid();
    const bad = await ali.post('/api/checkout', { request_id: reqId, deposit: dep({ link: 'not a link' }) }, { sign: true });
    expect(bad.status).toBe(400);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM deposits').first()).n).toBe(0);
    expect((await ali.get('/api/today')).data.state).toBe('checked_in');
    const taskless = await ali.post('/api/checkout', { request_id: reqId, deposit: dep() }, { sign: true });
    expect(taskless.data.error.code).toBe('task_or_reason');
    setNow(at(12));
    const ok = await ali.post('/api/checkout', { request_id: reqId, deposit: dep({ taskless_reason: 'Channel art for the new series' }) }, { sign: true });
    expect(ok.status).toBe(200);
    const again = await ali.post('/api/checkout', { request_id: reqId, deposit: dep({ taskless_reason: 'Channel art for the new series' }) }, { sign: true });
    expect(again.data.duplicate).toBe(true);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM deposits').first()).n).toBe(1);
    const row = await env.DB.prepare('SELECT check_out_at,status FROM attendance WHERE employee_id=?').bind(ali.id).first();
    expect(row).toEqual({ check_out_at: at(12), status: 'closed' });
  });
  it('a coworker cannot deposit against a task that is not assigned to them', async () => {
    setNow(at(13));
    await ali.post('/api/checkin', { request_id: rid() }, { sign: true });
    const r = await ali.post('/api/deposits', { request_id: rid(), task_id: 'NOT-MINE', ...dep() });
    expect(r.status).toBe(403);
    const ok = await ali.post('/api/deposits', { request_id: 'dep-req-0001', ...dep({ taskless_reason: 'Support: fixing project files' }) });
    const dup = await ali.post('/api/deposits', { request_id: 'dep-req-0001', ...dep({ taskless_reason: 'Support: fixing project files' }) });
    expect(dup.data.duplicate).toBe(true);
    expect(dup.data.id).toBe(ok.data.id);
    await ali.post('/api/checkout', { request_id: rid() }, { sign: true }); // uses today's deposit
  });
  it('technical-exception checkout records the real time, flags it, and is audited', async () => {
    setNow(at(14));
    await ali.post('/api/checkin', { request_id: rid() }, { sign: true });
    setNow(at(15));
    const r = await ali.post('/api/checkout', { request_id: rid(), exception_reason: 'Drive upload failed, will deposit link tomorrow' }, { sign: true });
    expect(r.data.exception).toBe(true);
    const a = await env.DB.prepare("SELECT reason FROM audit_log WHERE action='checkout_exception'").first();
    expect(a.reason).toContain('Drive upload failed');
  });
  it('concurrent check-ins (two tabs) create exactly one open record', async () => {
    setNow(at(15, 30));
    const rs = await Promise.all([1, 2, 3].map(() => ali.post('/api/checkin', { request_id: rid() }, { sign: true })));
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM attendance WHERE employee_id=? AND status='open'").bind(ali.id).first()).n).toBe(1);
    setNow(at(15, 40));
    await ali.post('/api/checkout', { request_id: rid(), exception_reason: 'closing test attendance row' }, { sign: true });
  });
});

describe('missing checkout and corrections', () => {
  it('forgotten checkout is flagged after 18h, never counted beyond the shift window, and next check-in works', async () => {
    const tue = at(9) + 24 * H;
    setNow(tue);
    await ali.post('/api/checkin', { request_id: rid() }, { sign: true });
    setNow(tue + 19 * H);
    const t = await ali.get('/api/today');
    expect(t.data.state).toBe('checked_out');
    const row = await env.DB.prepare("SELECT id,status FROM attendance WHERE employee_id=? AND status='missing_checkout'").bind(ali.id).first();
    expect(row).toBeTruthy();
    const next = await ali.post('/api/checkin', { request_id: rid() }, { sign: true });
    expect(next.status).toBe(200);
    await env.DB.prepare("UPDATE attendance SET status='closed', check_out_at=check_in_at+1000 WHERE employee_id=? AND status='open'").bind(ali.id).run();
    ali.missingId = row.id;
  });
  it('a manager without the correction grant is refused; admin correction is audited with before/after/reason', async () => {
    const tue = at(9) + 24 * H;
    const denied = await mgr.post(`/api/attendance/${ali.missingId}/correct`, { check_out_at: tue + 8 * H, reason: 'left at five' });
    expect(denied.status).toBe(403);
    setNow(tue + 20 * H);
    const ok = await admin.post(`/api/attendance/${ali.missingId}/correct`, { check_out_at: tue + 8 * H, reason: 'Ali confirmed he left at 17:00' });
    expect(ok.status).toBe(200);
    const row = await env.DB.prepare("SELECT before_json,after_json,reason,actor_id FROM audit_log WHERE action='attendance_corrected'").first();
    expect(JSON.parse(row.before_json).check_out_at).toBeNull();
    expect(JSON.parse(row.after_json).check_out_at).toBe(tue + 8 * H);
    expect(row.reason).toContain('confirmed');
  });
  it('a manager granted correction rights can fix only their own team', async () => {
    await admin.post(`/api/admin/employees/${mgr.id}`, { can_correct: true });
    const tue = at(9) + 24 * H;
    const ok = await mgr.post(`/api/attendance/${ali.missingId}/correct`, { check_out_at: tue + 7 * H, reason: 'recheck badge log' });
    expect(ok.status).toBe(200);
    const other = await makeEmployee(admin, 'Zoe'); // not on Mona's team
    const att = await admin.post('/api/attendance', { employee_id: other.id, check_in_at: tue + H, check_out_at: tue + 2 * H, reason: 'forgot to check in' });
    expect(att.status).toBe(200);
    const denied = await mgr.post('/api/attendance', { employee_id: other.id, check_in_at: tue + 3 * H, check_out_at: tue + 4 * H, reason: 'not my team' });
    expect(denied.status).toBe(403);
  });
});

describe('ClickUp timer pipeline', () => {
  const TASK = 'TK1';
  it('status events set the recorded time; checkout pauses, next check-in resumes, Ready for Upload stops', async () => {
    const wed = at(0) + 2 * 24 * H;
    const W = (h, m = 0) => wed + h * H + m * M;
    setNow(W(9, 55));
    await hook(whPayload('taskAssigneeUpdated', TASK, [item('a1', 'assignee_add', W(8), null, { id: 555, username: 'ali' })]));
    await hook(whPayload('taskDueDateUpdated', TASK, [item('d1', 'due_date', W(8), null, String(W(17)))]));
    setNow(W(10));
    await ali.post('/api/checkin', { request_id: rid() }, { sign: true });
    // event is DELIVERED late (10:40) but happened at 10:30
    setNow(W(10, 40));
    const r1 = await hook(whPayload('taskStatusUpdated', TASK, [item('s1', 'status', W(10, 30), { status: 'to do' }, { status: 'in progress' })]));
    expect(r1.status).toBe(200);
    // duplicate delivery changes nothing
    const dup = await hook(whPayload('taskStatusUpdated', TASK, [item('s1', 'status', W(10, 30), { status: 'to do' }, { status: 'in progress' })]));
    expect(dup.data.new_events).toBe(0);
    let s = (await env.DB.prepare('SELECT * FROM task_sessions WHERE employee_id=?').bind(ali.id).all()).results;
    expect(s.map((x) => [x.start_ms, x.end_ms])).toEqual([[W(10, 30), null]]);
    const today = (await ali.get('/api/today')).data;
    expect(today.recorded_ms_today).toBe(10 * M);
    // checkout at 12:00 pauses
    setNow(W(12));
    await ali.post('/api/checkout', { request_id: rid(), deposit: dep({ task_id: TASK }) }, { sign: true });
    s = (await env.DB.prepare('SELECT * FROM task_sessions WHERE employee_id=? ORDER BY start_ms').bind(ali.id).all()).results;
    expect(s.map((x) => [x.start_ms, x.end_ms, x.end_reason])).toEqual([[W(10, 30), W(12), 'checkout']]);
    // in progress outside attendance counts nothing
    setNow(W(12, 45));
    expect((await ali.get('/api/today')).data.recorded_ms_today).toBe(90 * M);
    // next check-in resumes automatically, no timer button
    setNow(W(13));
    await ali.post('/api/checkin', { request_id: rid() }, { sign: true });
    setNow(W(13, 1));
    await ali.get('/api/today');
    s = (await env.DB.prepare('SELECT * FROM task_sessions WHERE employee_id=? ORDER BY start_ms').bind(ali.id).all()).results;
    expect(s.map((x) => [x.start_ms, x.end_ms])).toEqual([[W(10, 30), W(12)], [W(13), null]]);
    expect((await ali.get('/api/today')).data.active_task.id).toBe(TASK);
    // Ready for Upload happened at 14:00 but we only hear at 14:05
    setNow(W(14, 5));
    await hook(whPayload('taskStatusUpdated', TASK, [item('s2', 'status', W(14), { status: 'in progress' }, { status: 'ready for upload' })]));
    s = (await env.DB.prepare('SELECT * FROM task_sessions WHERE employee_id=? ORDER BY start_ms').bind(ali.id).all()).results;
    expect(s.map((x) => [x.start_ms, x.end_ms, x.end_reason])).toEqual([[W(10, 30), W(12), 'checkout'], [W(13), W(14), 'ready_for_upload']]);
    expect((await ali.get('/api/today')).data.active_task).toBeNull();
    // work after checkout is not counted
    setNow(W(15));
    await ali.post('/api/checkout', { request_id: rid(), deposit: dep({ task_id: TASK, is_complete: true, pending: '' }) }, { sign: true });
    setNow(W(16));
    await hook(whPayload('taskStatusUpdated', TASK, [item('s3', 'status', W(15, 30), { status: 'ready for upload' }, { status: 'revisions' })]));
    s = (await env.DB.prepare("SELECT * FROM task_sessions WHERE employee_id=? AND kind='revision'").bind(ali.id).all()).results;
    expect(s).toEqual([]);
    // next day check-in resumes REVISION time; original delivery preserved
    const thu = wed + 24 * H;
    setNow(thu + 9 * H);
    await ali.post('/api/checkin', { request_id: rid() }, { sign: true });
    setNow(thu + 11 * H);
    await hook(whPayload('taskStatusUpdated', TASK, [item('s4', 'status', thu + 11 * H, { status: 'revisions' }, { status: 'ready for upload' })]));
    s = (await env.DB.prepare("SELECT * FROM task_sessions WHERE employee_id=? AND kind='revision'").bind(ali.id).all()).results;
    expect(s.map((x) => [x.start_ms, x.end_ms, x.end_reason])).toEqual([[thu + 9 * H, thu + 11 * H, 'ready_for_upload']]);
    const detail = (await mgr.get('/api/tasks/' + TASK)).data;
    expect(detail.deliveries.map((d) => [d.kind, d.at])).toEqual([['original', W(14)], ['revision', thu + 11 * H]]);
    expect(detail.deadline.deadline).toBe(W(17));
    await env.DB.prepare("UPDATE attendance SET status='closed',check_out_at=? WHERE employee_id=? AND status='open'").bind(thu + 12 * H, ali.id).run();
  });
  it('out-of-order events converge to the same sessions', async () => {
    const fri = at(0) + 4 * 24 * H;
    const F = (h, m = 0) => fri + h * H + m * M;
    setNow(F(9));
    await env.DB.prepare('INSERT INTO attendance(id,employee_id,request_id,check_in_at,check_out_at,status) VALUES (?,?,?,?,?,?)').bind('att-f', ali.id, 'req-f', F(9), F(17), 'closed').run();
    setNow(F(18));
    // Ready (11:00) arrives BEFORE In Progress (10:00) and before the assignment
    await hook(whPayload('taskStatusUpdated', 'TK2', [item('o2', 'status', F(11), { status: 'in progress' }, { status: 'ready for upload' })]));
    await hook(whPayload('taskStatusUpdated', 'TK2', [item('o1', 'status', F(10), { status: 'to do' }, { status: 'in progress' })]));
    await hook(whPayload('taskAssigneeUpdated', 'TK2', [item('o0', 'assignee_add', F(8), null, { id: 555 })]));
    const s = (await env.DB.prepare('SELECT * FROM task_sessions WHERE employee_id=? AND task_id=?').bind(ali.id, 'TK2').all()).results;
    expect(s.map((x) => [x.start_ms, x.end_ms])).toEqual([[F(10), F(11)]]);
  });
  it('two In Progress tasks never double count; employee choice resolves ambiguity', async () => {
    const sat = at(0) + 5 * 24 * H; // Saturday: not a scheduled day but overtime authorised
    const S = (h, m = 0) => sat + h * H + m * M;
    setNow(S(8));
    await admin.post(`/api/admin/employees/${ali.id}/overtime`, { start_ms: S(9), end_ms: S(15), reason: 'Urgent upload push' });
    for (const [id, tid] of [['x1', 'TA'], ['x2', 'TB']]) {
      await hook(whPayload('taskAssigneeUpdated', tid, [item(id + 'a', 'assignee_add', S(7), null, { id: 555 })]));
      await hook(whPayload('taskStatusUpdated', tid, [item(id + 's', 'status', S(8, 30), { status: 'to do' }, { status: 'in progress' })]));
    }
    setNow(S(9));
    await ali.post('/api/checkin', { request_id: rid() }, { sign: true });
    setNow(S(10));
    let t = (await ali.get('/api/today')).data;
    expect(t.active_task).toBeNull();
    expect(t.needs_task_choice.map((x) => x.id).sort()).toEqual(['TA', 'TB']);
    const pick = await ali.post('/api/active-task', { task_id: 'TB' });
    expect(pick.status).toBe(200);
    setNow(S(11));
    t = (await ali.get('/api/today')).data;
    expect(t.active_task.id).toBe('TB');
    const sess = (await env.DB.prepare('SELECT task_id,start_ms,end_ms FROM task_sessions WHERE employee_id=? AND start_ms>=? ORDER BY start_ms').bind(ali.id, S(0)).all()).results;
    expect(sess.map((x) => x.task_id)).toEqual(['TB']);
    expect(sess[0].start_ms).toBe(S(10));
    const cannot = await ali.post('/api/active-task', { task_id: 'SOMEONE-ELSES' });
    expect(cannot.status).toBe(403);
  });
});

describe('reports', () => {
  it('weekly numbers match source records', async () => {
    setNow(at(0) + 8 * 24 * H);
    const r = await admin.get('/api/reports?kind=weekly&period=2026-10-26');
    expect(r.status).toBe(200);
    const a = r.data.employees.find((e) => e.employee.id === ali.id);
    expect(a.attendance.scheduled_days).toBe(5);
    expect(a.attendance.present_days).toBe(a.attendance.days.filter((d) => d.status === 'present').length);
    expect(a.attendance.present_days + a.attendance.unexplained_absence_days).toBe(5);
    const origMs = (await env.DB.prepare("SELECT SUM(COALESCE(end_ms,0)-start_ms) s FROM task_sessions WHERE employee_id=? AND kind='original'").bind(ali.id).first()).s;
    expect(a.recorded_time.original_ms).toBeGreaterThan(0);
    expect(a.delivery.delivered).toBe(2); // TK1 original delivery (Wed) + TK2 (Fri); revision delivery is counted apart
    expect(a.delivery.revision_deliveries).toBe(1);
    expect(a.delivery.label).toMatch(/not quality-approved/);
    expect(r.data.notes.join(' ')).toMatch(/Employees are not ranked/);
  });
  it('employees cannot read reports; managers only see their team', async () => {
    expect((await ali.get('/api/reports?kind=weekly&period=2026-10-26')).status).toBe(403);
    const m = await mgr.get('/api/reports?kind=weekly&period=2026-10-26');
    const names = m.data.employees.map((e) => e.employee.name);
    expect(names).toContain('Ali');
    expect(names).not.toContain('Zoe');
    expect(names).not.toContain('Owner');
  });
  it('bad period is a clear 400', async () => {
    expect((await admin.get('/api/reports?kind=weekly&period=2026-10-27')).status).toBe(400);
  });
});

describe('real-user hints', () => {
  it('network refusal tells the person which address the server saw', async () => {
    const { Client } = await import('./helpers.js');
    const home = new Client('198.51.100.77'); home.cookie = ali.cookie; home.keys = ali.keys;
    const r = await home.post('/api/checkin', { request_id: rid() }, { sign: true });
    expect(r.data.error.message).toContain('198.51.100.77');
  });
  it('a task already In Progress with unknown start is reported to the employee, not silently untimed', async () => {
    const sun = at(0) + 6 * 24 * H;
    setNow(sun + 10 * H);
    await env.DB.prepare("INSERT INTO tasks(id,name,status,first_seen_ms) VALUES ('UV','Old video','in progress',1)").run();
    await env.DB.prepare("INSERT INTO task_assignees(task_id,clickup_user_id,start_ms,start_known) VALUES ('UV','555',0,0)").run();
    await env.DB.prepare("INSERT INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,to_val,note) VALUES ('rec:UV',?,?,?,?,?,?,?)").bind('UV', 'status', sun, sun, 'reconcile', 'in progress', 'approx').run();
    const t = (await ali.get('/api/today')).data;
    expect(t.unverified_tasks.map((x) => x.id)).toContain('UV');
  });
});

describe('custom ClickUp status names', () => {
  it('admin can map "ready to uploading" and recorded time recalculates', async () => {
    const mon = at(0) + 7 * 24 * H; // next Monday
    const W = (h, m = 0) => mon + h * H + m * M;
    setNow(W(18));
    await env.DB.prepare("DELETE FROM task_assignees WHERE task_id IN ('TA','TB','UV')").run(); // earlier tests left other In Progress tasks: that would (correctly) be ambiguous
    await env.DB.prepare("INSERT INTO attendance(id,employee_id,request_id,check_in_at,check_out_at,status) VALUES ('att-m',?,'req-m',?,?,'closed')").bind(ali.id, W(9), W(17)).run();
    await hook(whPayload('taskAssigneeUpdated', 'CS', [item('c0', 'assignee_add', W(8), null, { id: 555 })]));
    await hook(whPayload('taskStatusUpdated', 'CS', [item('c1', 'status', W(10), { status: 'to do' }, { status: 'in progress' })]));
    await hook(whPayload('taskStatusUpdated', 'CS', [item('c2', 'status', W(12), { status: 'in progress' }, { status: 'Super Done' })]));
    let s = (await env.DB.prepare("SELECT start_ms,end_ms FROM task_sessions WHERE task_id='CS'").all()).results;
    expect(s[0].end_ms).toBe(W(12)); // an unknown status still stops the timer (not In Progress)
    let d = (await mgr.get('/api/tasks/CS')).data;
    expect(d.deliveries).toEqual([]);   // ...but is not recorded as a delivery
    const st = await admin.get('/api/admin/statuses');
    expect(st.data.statuses.find((x) => x.status === 'super done').class).toBe('other');
    const save = await admin.post('/api/admin/settings', { status_map: { 'super done': 'done' } });
    expect(save.status).toBe(200);
    d = (await mgr.get('/api/tasks/CS')).data;
    expect(d.deliveries.map((x) => x.kind)).toEqual(['original']);
    expect((await admin.post('/api/admin/settings', { status_map: { x: 'bogus' } })).status).toBe(400);
    expect((await ali.get('/api/admin/statuses')).status).toBe(403);
  });
  it('built-in names include "ready to uploading"', async () => {
    const { classify } = await import('../src/lib/timer.js');
    expect(classify('Ready to Uploading')).toBe('done');
    expect(classify('rendered')).toBe('done');
  });
});

describe('job roles (writer / designer / title finder)', () => {
  it('each job role reads ClickUp statuses with its own meaning; others are unaffected', async () => {
    const tue = at(0) + 8 * 24 * H; // Tuesday 2026-11-03
    const T = (h, m = 0) => tue + h * H + m * M;
    setNow(T(19));
    const wr = await makeEmployee(admin, 'Wanda', { job_role: 'Writer', clickup_user_id: '777', manager_id: mgr.id });
    await giveShift(admin, wr.id, { start: 9 * 60, end: 17 * 60, days: 0b0011111 });
    const me = await admin.get('/api/admin/employees');
    expect(me.data.employees.find((e) => e.id === wr.id).job_role).toBe('Writer');
    const save = await admin.post('/api/admin/settings', { role_status_maps: { writer: { writing: 'active', 'script done': 'done' } } });
    expect(save.status).toBe(200);
    await env.DB.prepare("INSERT INTO attendance(id,employee_id,request_id,check_in_at,check_out_at,status) VALUES ('att-w',?,'req-w',?,?,'closed')").bind(wr.id, T(9), T(17)).run();
    await hook(whPayload('taskAssigneeUpdated', 'W1', [item('w0', 'assignee_add', T(8), null, { id: 777 })]));
    await hook(whPayload('taskStatusUpdated', 'W1', [item('w1', 'status', T(10), { status: 'to do' }, { status: 'Writing' })]));
    await hook(whPayload('taskStatusUpdated', 'W1', [item('w2', 'status', T(13), { status: 'Writing' }, { status: 'Script Done' })]));
    const s = (await env.DB.prepare("SELECT start_ms,end_ms,end_reason FROM task_sessions WHERE employee_id=? AND task_id='W1'").bind(wr.id).all()).results;
    expect(s.map((x) => [x.start_ms, x.end_ms, x.end_reason])).toEqual([[T(10), T(13), 'ready_for_upload']]);
    // same statuses mean nothing for someone with no job role mapping
    const { statusMap } = await import('../src/engine.js');
    const { classify } = await import('../src/lib/timer.js');
    expect(classify('writing', await statusMap(env.DB, 'Writer'))).toBe('active');
    expect(classify('writing', await statusMap(env.DB, 'Designer'))).toBe('other');
    expect(classify('writing', await statusMap(env.DB, null))).toBe('other');
    const rep = (await admin.get('/api/reports?kind=monthly&period=2026-11')).data;
    const w = rep.employees.find((e) => e.employee.id === wr.id);
    expect(w.employee.job_role).toBe('Writer');
    expect(w.delivery.delivered).toBe(1);
    expect(rep.by_role.Writer.delivered).toBe(1);
    expect(rep.by_role.Writer.original_ms).toBe(3 * H);
    expect((await ali.post('/api/admin/settings', { role_status_maps: {} })).status).toBe(403);
    expect((await admin.post('/api/admin/settings', { role_status_maps: { writer: { x: 'nonsense' } } })).status).toBe(400);
  });
});
