import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { Client, setupTeam, makeEmployee, approve, giveShift, rid } from './helpers.js';
import { localMidnightMs } from '../src/lib/time.js';
import { hmacHex, encryptSecret } from '../src/lib/crypto.js';

const H = 3600000, M = 60000;
const MON = localMidnightMs('2026-11-23');
const at = (d, h, m = 0) => MON + d * 24 * H + h * H + m * M;
const setNow = (ms) => vi.setSystemTime(ms);
let admin, mgr, mgr2, ann, bob;

async function hook(p) {
  const raw = JSON.stringify(p);
  const res = await SELF.fetch('https://ytm.test/api/webhooks/clickup', { method: 'POST', headers: { 'x-signature': await hmacHex('whsec', raw), 'content-type': 'application/json' }, body: raw });
  return res.status;
}
const item = (id, field, date, before, after) => ({ id, type: 1, date: String(date), field, before, after, user: { id: 1 } });
const payload = (event, task, items) => ({ webhook_id: 'w', event, task_id: task, history_items: items });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(at(0, 9));
  admin = await setupTeam();
  mgr = await makeEmployee(admin, 'Mona', { role: 'manager' });
  mgr2 = await makeEmployee(admin, 'Moe', { role: 'manager' });
  await admin.post(`/api/admin/employees/${mgr.id}`, { can_correct: true });
  await admin.post(`/api/admin/employees/${mgr2.id}`, { can_correct: true });
  ann = await makeEmployee(admin, 'Ann', { manager_id: mgr.id, clickup_user_id: '801', job_role: 'Editor' });
  bob = await makeEmployee(admin, 'Bob', { manager_id: mgr2.id, clickup_user_id: '802', job_role: 'Editor' });
  for (const e of [ann, bob, mgr]) { await approve(admin, e); await giveShift(admin, e.id, { start: 9 * 60, end: 17 * 60, days: 0b0011111 }); }
  await env.DB.prepare('INSERT INTO secrets_store(key,value) VALUES (?,?)').bind('clickup_webhook_secret', await encryptSecret(env.ENCRYPTION_KEY, 'whsec')).run();
  await admin.post('/api/admin/settings', { job_goals: { Editor: 4 } });
  // two tasks for Ann: A1 In Progress, A2 To Do
  for (const [id, st] of [['A1', 'in progress'], ['A2', 'to do']]) {
    await hook(payload('taskAssigneeUpdated', id, [item(id + 'a', 'assignee_add', at(0, 8), null, { id: 801 })]));
    await hook(payload('taskStatusUpdated', id, [item(id + 's', 'status', at(0, 9), { status: 'to do' }, { status: st })]));
    await env.DB.prepare('UPDATE tasks SET name=? WHERE id=?').bind('Task ' + id, id).run();
  }
});
afterAll(() => vi.useRealTimers());

describe('Today: shift, My Work, multi-task check-out', () => {
  it('today returns the shift and My Work with what can be switched', async () => {
    setNow(at(0, 10));
    await ann.post('/api/checkin', { request_id: rid() }, { sign: true });
    setNow(at(0, 11));
    const t = (await ann.get('/api/today')).data;
    expect(t.shift).toMatchObject({ start_ms: at(0, 9), end_ms: at(0, 17) });
    expect(t.my_work.map((x) => [x.id, x.class, x.active, x.can_switch])).toEqual([['A1', 'active', true, false], ['A2', 'other', false, false]]);
  });
  it('Switch is refused for a task that is still To Do and allowed once it is In Progress', async () => {
    expect((await ann.post('/api/active-task', { task_id: 'A2' })).data.error.code).toBe('not_in_progress');
    await hook(payload('taskStatusUpdated', 'A2', [item('A2s2', 'status', at(0, 11, 5), { status: 'to do' }, { status: 'in progress' })]));
    setNow(at(0, 11, 10));
    const t = (await ann.get('/api/today')).data;
    expect(t.needs_task_choice.length === 0 || t.active_task).toBeTruthy(); // incumbent stays: no double counting
    expect(t.my_work.find((x) => x.id === 'A2').can_switch).toBe(true);
    expect((await ann.post('/api/active-task', { task_id: 'A2' })).status).toBe(200);
  });
  it('an update during the day, then a two-task check-out in one transaction with prefilled links', async () => {
    const up = await ann.post('/api/progress', { request_id: rid(), task_id: 'A1', link: 'https://drive.example.com/a1', completed: 'Intro cut' });
    expect(up.status).toBe(200); // pending is optional
    setNow(at(0, 16));
    const t = (await ann.get('/api/today')).data;
    const a1 = t.worked_tasks.find((x) => x.id === 'A1');
    expect(a1).toMatchObject({ has_update: true, last_link: 'https://drive.example.com/a1' });
    const reqId = rid();
    const body = { request_id: reqId, updates: [
      { task_id: 'A2', link: 'https://drive.example.com/a2', completed: 'Colour pass' },
      { taskless_reason: 'Channel art help', link: 'https://drive.example.com/art', completed: 'Banner draft', pending: 'Resize' } ] };
    const r = await ann.post('/api/checkout', body, { sign: true });
    expect(r.status).toBe(200);
    const again = await ann.post('/api/checkout', body, { sign: true });
    expect(again.data.duplicate).toBe(true);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM deposits WHERE employee_id=?').bind(ann.id).first()).n).toBe(3);
    // a bad item anywhere saves nothing at all
    setNow(at(1, 10));
    await ann.post('/api/checkin', { request_id: rid() }, { sign: true });
    const bad = await ann.post('/api/checkout', { request_id: rid(), updates: [{ task_id: 'A1', link: 'https://x.example/1', completed: 'ok' }, { task_id: 'A1', link: 'not a link', completed: 'bad' }] }, { sign: true });
    expect(bad.status).toBe(400);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM deposits WHERE employee_id=?').bind(ann.id).first()).n).toBe(3);
    expect((await ann.get('/api/today')).data.state).toBe('checked_in');
    await ann.post('/api/checkout', { request_id: rid(), exception_reason: 'Closing test day early' }, { sign: true });
  });
});

describe('own report with a goal, and the Owner-only comparison', () => {
  it('employee sees goal %, tasks and days; nothing about earlier periods or other people', async () => {
    setNow(at(4, 18));
    const r = (await ann.get('/api/me/report?kind=weekly')).data;
    expect(r.goal).toMatchObject({ per_week: 4, target: 4, metric: 'tasks delivered' });
    expect(Object.keys(r)).not.toContain('previous');
    expect(JSON.stringify(r)).not.toMatch(/comparison|Bob/);
    expect(r.attendance.length).toBeGreaterThan(0);
  });
  it('the Owner gets the comparison; managers and employees never do', async () => {
    setNow(at(7, 10)); // next Monday
    const period = '2026-11-23';
    const owner = (await admin.get(`/api/reports?kind=weekly&period=${period}`)).data;
    expect(owner.previous).toBeTruthy();
    expect(owner.employees.every((e) => e.comparison)).toBe(true);
    const m = (await mgr.get(`/api/reports?kind=weekly&period=${period}`)).data;
    expect(m.previous).toBeUndefined();
    expect(m.employees.every((e) => e.comparison === undefined)).toBe(true);
    expect(m.layout.compare.enabled).toBe(false);
    expect((await ann.get(`/api/reports?kind=weekly&period=${period}`)).status).toBe(403);
    expect((await mgr.post('/api/admin/settings', { report_layout: { columns: { goal: true }, compare: { enabled: true } } })).status).toBe(403);
  });
  it('the Owner customises columns and the comparison; managers see the columns, not the comparison', async () => {
    const ok = await admin.post('/api/admin/settings', { report_layout: { columns: { goal: true, time: true, titles: true }, compare: { enabled: true, against: 'same_week_last_month' } }, job_goals: { Editor: 5, Writer: 2 } });
    expect(ok.status).toBe(200);
    const o = (await admin.get('/api/reports?kind=weekly&period=2026-11-23')).data;
    expect(o.layout.columns).toMatchObject({ goal: true, time: true, titles: true, delivered: false });
    expect(o.layout.compare.against).toBe('same_week_last_month');
    const m = (await mgr.get('/api/reports?kind=weekly&period=2026-11-23')).data;
    expect(m.layout.columns.time).toBe(true);
    expect(m.previous).toBeUndefined();
    await admin.post('/api/admin/settings', { report_layout: { columns: { goal: true, delivered: true, days: true }, compare: { enabled: false } } });
    expect((await admin.get('/api/reports?kind=weekly&period=2026-11-23')).data.previous).toBeUndefined();
  });
});

describe('corrections: nobody edits their own record', () => {
  let annAtt, monaAtt;
  beforeAll(async () => {
    annAtt = (await env.DB.prepare('SELECT id,check_in_at FROM attendance WHERE employee_id=? ORDER BY check_in_at LIMIT 1').bind(ann.id).first());
    await env.DB.prepare("INSERT INTO attendance(id,employee_id,request_id,check_in_at,check_out_at,status) VALUES ('mona-1',?,'req-mona-1',?,?,'closed')").bind(mgr.id, at(0, 9), at(0, 16, 15)).run();
    monaAtt = { id: 'mona-1', check_in_at: at(0, 9) };
  });
  it('employee asks; their manager decides; the change is audited with before/after', async () => {
    const r = await ann.post('/api/correction-requests', { attendance_id: annAtt.id, check_out_at: at(0, 17), reason: 'Forgot to clock out at 16:00, left at 17:00' });
    expect(r.status).toBe(200);
    expect((await ann.post('/api/correction-requests', { attendance_id: annAtt.id, check_out_at: at(0, 17), reason: 'again please' })).data.error.code).toBe('already_asked');
    expect((await bob.post('/api/correction-requests', { attendance_id: annAtt.id, check_out_at: at(0, 17), reason: 'not my record' })).status).toBe(404);
    expect((await ann.post(`/api/correction-requests/${r.data.id}/decide`, { approve: true })).status).toBe(403); // employees cannot decide
    expect((await mgr2.post(`/api/correction-requests/${r.data.id}/decide`, { approve: true })).status).toBe(403); // another manager's team
    const list = (await mgr.get('/api/correction-requests')).data.requests;
    expect(list.find((x) => x.id === r.data.id).can_decide).toBe(true);
    expect((await mgr.post(`/api/correction-requests/${r.data.id}/decide`, { approve: true, note: 'ok' })).status).toBe(200);
    const row = await env.DB.prepare("SELECT before_json,after_json FROM audit_log WHERE action='attendance_corrected' AND entity_id=? ORDER BY id DESC").bind(annAtt.id).first();
    expect(JSON.parse(row.after_json).check_out_at).toBe(at(0, 17));
    expect((await mgr.post(`/api/correction-requests/${r.data.id}/decide`, { approve: true })).status).toBe(409); // once
  });
  it("a manager cannot change or approve their OWN record; only the Owner can", async () => {
    expect((await mgr.post(`/api/attendance/${monaAtt.id}/correct`, { check_out_at: at(0, 17), reason: 'fix my own time' })).data.error.code).toBe('cannot_correct');
    const r = await mgr.post('/api/correction-requests', { attendance_id: monaAtt.id, check_out_at: at(0, 17), reason: 'Left at 17:00' });
    expect(r.status).toBe(200);
    expect((await mgr.post(`/api/correction-requests/${r.data.id}/decide`, { approve: true })).data.error.code).toBe('cannot_decide');
    expect((await mgr2.post(`/api/correction-requests/${r.data.id}/decide`, { approve: true })).status).toBe(403); // not another manager either
    expect((await mgr.get('/api/correction-requests')).data.requests.find((x) => x.id === r.data.id).can_decide).toBe(false);
    expect((await admin.get('/api/correction-requests')).data.requests.some((x) => x.id === r.data.id)).toBe(true);
    expect((await admin.post(`/api/correction-requests/${r.data.id}/decide`, { approve: true })).status).toBe(200);
    expect((await env.DB.prepare('SELECT check_out_at FROM attendance WHERE id=?').bind(monaAtt.id).first()).check_out_at).toBe(at(0, 17));
  });
  it('"Ask" shows the employee a prompt on Today; a request clears it', async () => {
    await env.DB.prepare("INSERT INTO attendance(id,employee_id,request_id,check_in_at,status) VALUES ('bob-miss',?,'req-bob-m',?,'missing_checkout')").bind(bob.id, at(0, 9, 5)).run();
    expect((await mgr.post('/api/attendance/bob-miss/ask')).status).toBe(403); // not Mona's team
    expect((await mgr2.post('/api/attendance/bob-miss/ask')).status).toBe(200);
    expect((await bob.get('/api/today')).data.asked.map((x) => x.id)).toEqual(['bob-miss']);
    await bob.post('/api/correction-requests', { attendance_id: 'bob-miss', check_out_at: at(0, 16, 30), reason: 'Left at 16:30' });
    expect((await bob.get('/api/today')).data.asked).toEqual([]);
  });
});

describe('manager task detail', () => {
  it('shows facts, submissions, time by day and a plain-language story; employees only see their own', async () => {
    const d = (await mgr.get('/api/tasks/A1')).data;
    expect(d.task.name).toBe('Task A1');
    expect(d.submissions.length).toBeGreaterThan(0);
    expect(d.submissions[0]).toHaveProperty('review_note');
    expect(d.facts).toHaveProperty('original_ms');
    expect(d.story.some((s) => /Assigned to Ann/.test(s.text))).toBe(true);
    expect(d.story.some((s) => /Moved to in progress/i.test(s.text))).toBe(true);
    expect((await ann.get('/api/tasks/A1')).status).toBe(200);
    expect((await bob.get('/api/tasks/A1')).status).toBe(403);
    expect((await mgr2.get('/api/tasks/A1')).status).toBe(403); // not their team
  });
});
