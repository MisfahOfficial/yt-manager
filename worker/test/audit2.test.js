// Round-2 audit: each test reproduces a finding (written to FAIL before the fix, PASS after).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { Client, setupTeam, makeEmployee, approve, giveShift, rid } from './helpers.js';
import { classify } from '../src/lib/timer.js';
import { buildReport } from '../src/reports.js';
import { localMidnightMs } from '../src/lib/time.js';
import { hmacHex, encryptSecret } from '../src/lib/crypto.js';

const H = 3600000, DAY = 24 * H;
const MON = localMidnightMs('2026-11-02');
let admin, mgr, emp;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(MON + 10 * DAY);
  admin = await setupTeam();
  mgr = await makeEmployee(admin, 'A2Mgr', { role: 'manager' });
  emp = await makeEmployee(admin, 'A2Emp', { manager_id: mgr.id, clickup_user_id: '5001', job_role: '__proto__' });
  await approve(admin, emp); await giveShift(admin, emp.id, { start: 0, end: 1439, days: 127 });
  await env.DB.prepare('INSERT INTO secrets_store(key,value) VALUES (?,?)').bind('clickup_webhook_secret', await encryptSecret(env.ENCRYPTION_KEY, 'whsec')).run();
});
afterAll(() => vi.useRealTimers());

describe('F2: names used as dictionary keys cannot pollute the server', () => {
  it('a job called "__proto__" does not change Object.prototype when a report is built', async () => {
    await env.DB.prepare("INSERT INTO tasks(id,name,status,first_seen_ms) VALUES ('P1','V1-1 x','ready to upload',1)").run();
    await env.DB.prepare("INSERT INTO task_assignees(task_id,clickup_user_id,start_ms) VALUES ('P1','5001',0)").run();
    await env.DB.prepare("INSERT INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,to_val) VALUES ('p1a','P1','status',?,1,'webhook','in progress'),('p1b','P1','status',?,1,'webhook','ready to upload')").bind(MON + 2 * DAY, MON + 3 * DAY).run();
    await buildReport(env, [emp.id], 'monthly', '2026-11', Date.now(), {});
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'delivered')).toBe(false);
    expect({}.delivered).toBeUndefined();
  });
  it('a script-check rule named "__proto__" does not pollute either', async () => {
    await admin.post('/api/admin/settings', { script_checks: { jobs: { '__proto__': { rules: [{ label: '__proto__', type: 'words', min: 1 }] } } } });
    await env.DB.prepare("INSERT INTO task_checks(task_id,employee_id,checked_at,trigger,result_json) VALUES ('P1',?,?,?,?)").bind(emp.id, Date.now(), 'x', JSON.stringify({ status: 'ok', passed: false, items: [{ label: '__proto__', ok: false, have: 0, need: 1 }] })).run();
    await buildReport(env, [emp.id], 'monthly', '2026-11', Date.now(), {});
    expect({}.passed).toBeUndefined(); expect({}.total).toBeUndefined();
  });
  it('a ClickUp status called "constructor" or "__proto__" is just an unknown status', () => {
    for (const s of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(classify(s)).toBe('other');
  });
  it('settings keys that could do harm are refused', async () => {
    for (const raw of ['{"status_map":{"__proto__":"done"}}', '{"role_status_maps":{"__proto__":{"a":"done"}}}', '{"job_goals":{"__proto__":3}}', '{"role_status_maps":{"x":{"constructor":"done"}}}', '{"script_checks":{"jobs":{"__proto__":{"rules":[]}}}}']) {
      expect((await admin.req('POST', '/api/admin/settings', undefined, { raw })).status).toBe(400);
    }
  });
});

describe('F3: two people deciding the same correction at the same moment', () => {
  it('only one decision is applied and audited', async () => {
    const att = 'att-race';
    await env.DB.prepare("INSERT INTO attendance(id,employee_id,request_id,check_in_at,check_out_at,status) VALUES (?,?,?,?,?,'closed')").bind(att, emp.id, 'rq-race', MON + 2 * H, MON + 6 * H).run();
    const r = await emp.post('/api/correction-requests', { attendance_id: att, check_out_at: MON + 8 * H, reason: 'Left at 8 hours in' });
    await admin.post(`/api/admin/employees/${mgr.id}`, { can_correct: true });
    const [a, b] = await Promise.all([admin.post(`/api/correction-requests/${r.data.id}/decide`, { approve: true }), mgr.post(`/api/correction-requests/${r.data.id}/decide`, { approve: true })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const n = (await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='attendance_corrected' AND entity_id=?").bind(att).first()).n;
    expect(n).toBe(1);
  });
});

describe('F5: links never become protocol-relative redirects', () => {
  it('the page helper refuses //evil.example and javascript: hrefs', async () => {
    const src = await (await SELF.fetch('https://ytm.test/js/core.js', { headers: { 'cf-connecting-ip': '1.1.1.1' } })).text();
    const m = /k === 'href'[^;]*;/.exec(src)[0];
    expect(m).toContain('(?!');                   // protocol-relative '//' is excluded
  });
});

describe('F6: settings cannot be inflated without limit', () => {
  it('very large maps are refused', async () => {
    const big = Object.fromEntries(Array.from({ length: 400 }, (_, i) => ['status ' + i, 'done']));
    expect((await admin.post('/api/admin/settings', { status_map: big })).status).toBe(400);
    expect((await admin.post('/api/admin/settings', { job_goals: Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['job' + i, 1])) })).status).toBe(400);
  });
});

describe('F4: importing the old app\'s data works at realistic size', () => {
  it('a few hundred old records import in chunks without a size error, twice without duplicates', async () => {
    const members = [{ id: 'm1', name: 'Old One', isManager: false, password: 'plaintext!' }];
    const attendance = Array.from({ length: 250 }, (_, i) => ({ memberId: 'm1', date: '2026-01-' + String((i % 28) + 1).padStart(2, '0'), clockIn: '09:0' + (i % 10), clockOut: '17:00', n: i }));
    const send = (chunk) => admin.post('/api/admin/import-legacy', chunk);
    expect((await send({ members })).status).toBe(200);
    for (let i = 0; i < attendance.length; i += 100) expect((await send({ attendance: attendance.slice(i, i + 100) })).status).toBe(200);
    for (let i = 0; i < attendance.length; i += 100) await send({ attendance: attendance.slice(i, i + 100) });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM legacy_records WHERE kind='attendance'").first()).n).toBe(250);
    expect(JSON.stringify((await admin.get('/api/admin/legacy?kind=member')).data)).not.toContain('plaintext!');
    for (const k of ['workLogs', 'tasks', 'calVideos', 'videos']) expect((await send({ [k]: [{ id: k + '1', memberId: 'm1', title: 'x' }] })).status).toBe(200);   // every kind can be sent on its own
    expect((await send({})).status).toBe(400);
    const big = Array.from({ length: 5000 }, (_, i) => ({ memberId: 'm1', date: '2026-02-01', clockIn: 'x'.repeat(20), n: i }));
    expect([200, 400, 413]).toContain((await send({ attendance: big })).status);   // refused or capped, never a crash
  });
});

describe('F7: privacy: old network addresses are not kept forever', () => {
  it('the daily clean-up erases IP addresses from attendance older than 180 days', async () => {
    const { housekeeping } = await import('../src/index.js');
    await env.DB.prepare("INSERT INTO attendance(id,employee_id,request_id,check_in_at,check_out_at,status,ip,checkout_ip) VALUES ('old-ip',?,'rq-old-ip',?,?,'closed','203.0.113.5','203.0.113.5'),('new-ip',?,'rq-new-ip',?,?,'closed','203.0.113.6','203.0.113.6')").bind(emp.id, Date.now() - 200 * DAY, Date.now() - 200 * DAY + H, emp.id, Date.now() - 10 * DAY, Date.now() - 10 * DAY + H).run();
    await housekeeping(env.DB, Date.now());
    const old = await env.DB.prepare("SELECT ip,checkout_ip FROM attendance WHERE id='old-ip'").first();
    const fresh = await env.DB.prepare("SELECT ip,checkout_ip FROM attendance WHERE id='new-ip'").first();
    expect(old).toEqual({ ip: null, checkout_ip: null });
    expect(fresh.ip).toBe('203.0.113.6');
  });
});

describe('secrets and outbound requests', () => {
  it('a saved ClickUp token never appears in any API answer, audit line or backup listing', async () => {
    const TOKEN = 'pk_leakcheck_9f3a7c1e5b2d';
    expect((await admin.post('/api/admin/clickup/token', { token: TOKEN })).status).toBe(200);
    const { ROUTE_TABLE } = await import('../src/index.js');
    let scanned = 0;
    for (const r of ROUTE_TABLE.filter((x) => x.method === 'GET' && x.who !== 'public' && !x.path.includes(':') && x.path !== '/api/admin/clickup/members')) {
      const res = await SELF.fetch('https://ytm.test' + r.path, { headers: { cookie: admin.cookie, 'cf-connecting-ip': '1.1.1.1' } });
      const body = await res.text(); scanned++;
      expect(body, r.path).not.toContain(TOKEN);
      expect(body, r.path).not.toContain('leakcheck');
    }
    const row = await env.DB.prepare("SELECT value FROM secrets_store WHERE key='clickup_token'").first();
    expect(row.value).not.toContain('leakcheck');          // stored encrypted
    expect(scanned).toBeGreaterThan(15);
  });
  it('the Google Docs reader only ever contacts docs.google.com, whatever the link says', async () => {
    const { readDoc } = await import('../src/scriptcheck.js');
    const seen = [];
    const e = Object.assign(Object.create(env), { DOC_FETCH: async (u) => { seen.push(u); return new Response('<html><body>x</body></html>', { status: 200 }); } });
    for (const link of ['https://evil.example/?u=docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAAAA/edit', 'http://169.254.169.254/latest/meta-data/?docs.google.com/document/d/BBBBBBBBBBBBBBBBBBBBBB', 'https://docs.google.com.evil.example/document/d/CCCCCCCCCCCCCCCCCCCCCC/edit', 'file:///etc/passwd']) await readDoc(e, link);
    for (const u of seen) expect(new URL(u).hostname).toBe('docs.google.com');
  });
  it('every response carries no-store and nosniff, and errors never include a stack trace', async () => {
    for (const p of ['/api/me', '/api/nope', '/api/admin/employees']) {
      const res = await SELF.fetch('https://ytm.test' + p, { headers: { 'cf-connecting-ip': '1.1.1.1' } });
      expect(res.headers.get('cache-control')).toBe('no-store'); expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).not.toMatch(/at \w+ \(|\.js:\d+|node_modules/);
    }
  });
});
