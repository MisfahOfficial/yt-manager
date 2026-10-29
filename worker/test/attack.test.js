// Adversarial tests: what a malicious employee, manager, outsider or script would try.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { Client, setupTeam, makeEmployee, approve, giveShift, rid, OFFICE_IP } from './helpers.js';
import { ROUTE_TABLE, handle } from '../src/index.js';
import { localMidnightMs } from '../src/lib/time.js';
import { hmacHex, encryptSecret, sha256Hex } from '../src/lib/crypto.js';

const H = 3600000;
const T0 = localMidnightMs('2026-12-07') + 10 * H;           // a Monday, 10:00 Karachi
let admin, mgrA, mgrB, empA, empB, outsider;

async function attDay(emp, i = 0) {                           // a closed attendance row for tests
  const id = 'att-' + emp.id.slice(0, 6) + i;
  await env.DB.prepare('INSERT OR REPLACE INTO attendance(id,employee_id,request_id,check_in_at,check_out_at,status) VALUES (?,?,?,?,?,?)').bind(id, emp.id, 'rq-' + id, T0 - (i + 1) * 86400000, T0 - (i + 1) * 86400000 + 6 * H, 'closed').run();
  return id;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0);
  admin = await setupTeam();
  mgrA = await makeEmployee(admin, 'MgrA', { role: 'manager' });
  mgrB = await makeEmployee(admin, 'MgrB', { role: 'manager' });
  for (const m of [mgrA, mgrB]) await admin.post(`/api/admin/employees/${m.id}`, { can_correct: true });
  empA = await makeEmployee(admin, 'EmpA', { manager_id: mgrA.id, clickup_user_id: '71', job_role: 'Editor' });
  empB = await makeEmployee(admin, 'EmpB', { manager_id: mgrB.id, clickup_user_id: '72', job_role: 'Editor' });
  for (const e of [empA, empB, mgrA]) { await approve(admin, e); await giveShift(admin, e.id, { start: 9 * 60, end: 17 * 60, days: 127 }); }
  outsider = new Client();
  await env.DB.prepare('INSERT INTO secrets_store(key,value) VALUES (?,?)').bind('clickup_webhook_secret', await encryptSecret(env.ENCRYPTION_KEY, 'whsec')).run();
  await env.DB.prepare("INSERT INTO tasks(id,name,url,status,first_seen_ms) VALUES ('TA','V1-1 A task','u','in progress',1),('TB','V1-2 B task','u','in progress',1)").run();
  await env.DB.prepare("INSERT INTO task_assignees(task_id,clickup_user_id,start_ms) VALUES ('TA','71',0),('TB','72',0)").run();
});
afterAll(() => vi.useRealTimers());

// ------------------------------------------------------------------------------------------------
describe('every route is protected for every role (matrix)', () => {
  const skip = new Set(['/api/logout', '/api/login', '/api/bootstrap', '/api/health', '/api/webhooks/clickup', '/api/clickup/callback']);
  const who = () => ({ anon: outsider, employee: empA, manager: mgrA, admin });
  it('anonymous callers get 401 on every protected route; wrong roles get 403; right roles never get 401/403', async () => {
    const problems = [];
    let checked = 0;
    for (const r of ROUTE_TABLE) {
      if (skip.has(r.path)) continue;
      const path = r.path.replace(/:[a-z]+/g, 'zz');
      const roles = ['employee', 'manager', 'admin'];
      for (const [name, c] of Object.entries(who())) {
        const res = await c.req(r.method, path, r.method === 'GET' ? undefined : {});
        checked++;
        if (name === 'anon') { if (res.status !== 401) problems.push(`${r.method} ${path} anon -> ${res.status}`); continue; }
        const allowed = r.who.includes(name);
        if (!allowed && res.status !== 403) problems.push(`${r.method} ${path} ${name} should be 403, got ${res.status}`);
        if (allowed && (res.status === 401 || res.status === 403) && !['device_not_approved', 'cannot_correct', 'cannot_decide', 'task_not_yours', 'not_your_team', 'bad_login'].includes(res.data?.error?.code)) problems.push(`${r.method} ${path} ${name} wrongly refused: ${res.status} ${res.data?.error?.code}`);
        if (res.status >= 500) problems.push(`${r.method} ${path} ${name} crashed (${res.status})`);
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(150);
  });
});

describe('employee data isolation (IDOR)', () => {
  let depA, corrA;
  beforeAll(async () => {
    setNow(T0);
    await env.DB.prepare("INSERT INTO attendance(id,employee_id,request_id,check_in_at,status) VALUES ('open-a',?,'rq-open-a',?, 'open')").bind(empA.id, T0 - H).run();
    await env.DB.prepare("INSERT INTO deposits(id,employee_id,attendance_id,request_id,task_id,link,completed,created_at) VALUES ('dep-a',?,?,?,?,?,?,?)").bind(empA.id, 'open-a', 'rq-dep-a', 'TA', 'https://drive.example.com/a', 'A secret progress', T0 - 1000).run();
    await env.DB.prepare("UPDATE attendance SET status='closed',check_out_at=? WHERE id='open-a'").bind(T0 - 500).run();
    depA = 'dep-a'; corrA = await attDay(empA, 3);
  });
  const setNow = (t) => vi.setSystemTime(t);
  it("another employee cannot read, note, re-check or correct A's records", async () => {
    expect((await empB.get('/api/tasks/TA')).status).toBe(403);
    expect((await empB.post(`/api/deposits/${depA}/note`, { note: 'hi' })).status).toBe(403);
    expect((await empB.post(`/api/deposits/${depA}/recheck`)).status).toBe(403);
    expect((await empB.post(`/api/attendance/${corrA}/correct`, { check_out_at: T0 - 1000, reason: 'steal time' })).status).toBe(403);
    expect((await empB.post('/api/correction-requests', { attendance_id: corrA, check_out_at: T0 - 5000, reason: 'not my record' })).status).toBe(404);
    expect((await empB.post('/api/progress', { request_id: rid(), task_id: 'TA', link: 'https://x.example/1', completed: 'hijack' })).status).toBeGreaterThanOrEqual(403);
    expect((await empB.post('/api/active-task', { task_id: 'TA' })).status).toBe(403);
    const hist = (await empB.get('/api/history?days=90')).data;
    expect(JSON.stringify(hist)).not.toContain('A secret progress');
    expect(JSON.stringify((await empB.get('/api/me/report?kind=monthly')).data)).not.toContain('EmpA');
  });
  it('a manager sees only their own team; the other manager and employees see none of it', async () => {
    expect((await mgrA.get('/api/tasks/TA')).status).toBe(200);
    expect((await mgrB.get('/api/tasks/TA')).status).toBe(403);
    expect((await mgrB.post(`/api/deposits/${depA}/note`, { note: 'x' })).status).toBe(403);
    expect((await mgrB.post(`/api/attendance/${corrA}/correct`, { check_out_at: T0 - 1000, reason: 'not my team' })).status).toBe(403);
    expect((await mgrB.post(`/api/attendance/${corrA}/ask`)).status).toBe(403);
    expect((await mgrB.post('/api/tasks/TA/changes', { notes: 'x' })).status).toBe(403);
    const team = (await mgrB.get('/api/team')).data.people.map((p) => p.name);
    expect(team).toContain('EmpB'); expect(team).not.toContain('EmpA');
    expect(JSON.stringify((await mgrB.get('/api/submissions')).data)).not.toContain('A secret progress');
    const rep = (await mgrB.get('/api/reports?kind=weekly&period=2026-12-07')).data;
    expect(rep.employees.map((e) => e.employee.name)).not.toContain('EmpA');
  });
  it("a manager cannot decide another manager's or their own correction, only their team's", async () => {
    const mine = await attDay(mgrA, 1);
    const r = await mgrA.post('/api/correction-requests', { attendance_id: mine, check_out_at: T0 - 86400000 + 8 * H, reason: 'my own time' });
    expect((await mgrA.post(`/api/correction-requests/${r.data.id}/decide`, { approve: true })).status).toBe(403);
    expect((await mgrB.post(`/api/correction-requests/${r.data.id}/decide`, { approve: true })).status).toBe(403);
    expect((await mgrA.post(`/api/attendance/${mine}/correct`, { check_out_at: T0 - 86400000 + 8 * H, reason: 'self edit' })).status).toBe(403);
  });
});

// ------------------------------------------------------------------------------------------------
describe('injection and hostile input', () => {
  const EVIL = ["' OR 1=1 --", "x'); DROP TABLE employees; --", '"; DELETE FROM tasks; --', '<script>alert(1)</script>', '${7*7}{{7*7}}', '\u0000‮', 'A'.repeat(300)];
  it('SQL injection in every text field and query parameter changes nothing and never crashes', async () => {
    const before = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM employees) e,(SELECT COUNT(*) FROM tasks) t,(SELECT COUNT(*) FROM attendance) a').first();
    const bad = [];
    for (const evil of EVIL) {
      for (const [m, p, b, c] of [
        ['POST', '/api/login', { email: evil, password: evil }, outsider],
        ['POST', '/api/admin/employees', { name: evil, email: evil + '@x.test', job_role: evil }, admin],
        ['POST', '/api/progress', { request_id: evil + 'abcdefgh', task_id: evil, link: 'https://x.example/' + encodeURIComponent(evil), completed: evil, pending: evil, taskless_reason: evil }, empA],
        ['POST', '/api/admin/channels', { channels: [{ code: evil, name: evil }] }, admin],
        ['POST', '/api/admin/settings', { office_ips: [evil], status_map: { [evil]: 'active' } }, admin],
        ['GET', `/api/reports?kind=${encodeURIComponent(evil)}&period=${encodeURIComponent(evil)}`, undefined, admin],
        ['GET', `/api/history?days=${encodeURIComponent(evil)}`, undefined, empA],
        ['GET', `/api/calendar?week=${encodeURIComponent(evil)}`, undefined, mgrA],
        ['GET', `/api/tasks/${encodeURIComponent(evil)}`, undefined, mgrA],
        ['POST', `/api/tasks/${encodeURIComponent(evil)}/changes`, { notes: evil }, mgrA],
        ['POST', '/api/correction-requests', { attendance_id: evil, reason: evil, check_out_at: evil }, empA],
      ]) {
        const r = await c.req(m, p, b);
        if (r.status >= 500) bad.push(`${m} ${p.slice(0, 40)} ${evil.slice(0, 12)} -> ${r.status}`);
      }
    }
    expect(bad).toEqual([]);
    const after = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM employees) e,(SELECT COUNT(*) FROM tasks) t,(SELECT COUNT(*) FROM attendance) a').first();
    expect(after.t).toBe(before.t); expect(after.a).toBe(before.a);
    expect(after.e).toBeGreaterThanOrEqual(before.e);   // only legitimately created accounts (employee names are data, not code)
    expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='employees'").first())).toBeTruthy();
  });
  it('hostile strings are stored and returned as inert JSON text', async () => {
    const r = await admin.post('/api/admin/employees', { name: '<img src=x onerror=alert(1)>', email: 'xss@x.test' });
    expect(r.status).toBe(200);
    const res = await SELF.fetch('https://ytm.test/api/admin/employees', { headers: { cookie: admin.cookie, 'cf-connecting-ip': OFFICE_IP } });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await res.json()).employees.some((e) => e.name === '<img src=x onerror=alert(1)>')).toBe(true);
  });
  it('links must be web links: javascript:, data: and file: are refused', async () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'vbscript:x', '//evil.example', 'ftp://x.example']) {
      const r = await empA.post('/api/progress', { request_id: rid(), task_id: 'TA', link, completed: 'x' });
      expect([400, 409]).toContain(r.status);
    }
  });
  it('oversized and malformed bodies are refused cleanly', async () => {
    expect((await empA.req('POST', '/api/progress', undefined, { raw: JSON.stringify({ completed: 'A'.repeat(70000) }) })).status).toBe(413);
    expect((await empA.req('POST', '/api/progress', undefined, { raw: '{not json' })).status).toBe(400);
    expect((await empA.req('POST', '/api/progress', undefined, { raw: '[1,2,3]' })).status).toBeLessThan(500);
    expect([400, 409]).toContain((await empA.post('/api/progress', { request_id: rid(), task_id: 'TA', link: 'https://x.example/1', completed: 'A'.repeat(4001) })).status);
  });
});

// ------------------------------------------------------------------------------------------------
describe('browser-origin attacks (CSRF, cookie flags)', () => {
  it('state-changing calls need the custom header; a foreign Origin is refused even with it', async () => {
    expect((await empA.req('POST', '/api/logout', {}, { headers: { 'x-requested-with': '' } })).status).toBe(403);
    expect((await empA.req('POST', '/api/progress', {}, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await empA.req('POST', '/api/progress', {}, { headers: { origin: 'https://ytm.test' } })).status).not.toBe(403);
  });
  it('the session cookie is HttpOnly, Secure, SameSite=Strict and the token is random 256-bit', async () => {
    const res = await SELF.fetch('https://ytm.test/api/login', { method: 'POST', headers: { 'x-requested-with': 'ytm', 'content-type': 'application/json', 'cf-connecting-ip': OFFICE_IP }, body: JSON.stringify({ email: 'empa@x.test', password: empA.password }) });
    const sc = res.headers.get('set-cookie');
    expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/Secure/); expect(sc).toMatch(/SameSite=Strict/);
    expect(/ytm_s=([0-9a-f]{64});/.test(sc)).toBe(true);
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age/);
  });
  it('the database never stores the raw session token', async () => {
    const c = new Client(); await c.post('/api/login', { email: 'empa@x.test', password: empA.password });
    const tok = c.cookie.split('=')[1];
    expect(await env.DB.prepare('SELECT 1 FROM sessions WHERE token_hash=?').bind(tok).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM sessions WHERE token_hash=?').bind(await sha256Hex(tok)).first()).toBeTruthy();
  });
});

// ------------------------------------------------------------------------------------------------
describe('sessions and passwords', () => {
  it('tampered, malformed, expired and logged-out cookies are all refused', async () => {
    const c = new Client(); await c.post('/api/login', { email: 'empa@x.test', password: empA.password });
    const good = c.cookie;
    for (const cookie of ['ytm_s=' + 'a'.repeat(64), 'ytm_s=', 'ytm_s=' + good.split('=')[1].toUpperCase(), 'ytm_s=../../etc/passwd', good + 'x']) {
      const x = new Client(); x.cookie = cookie; expect((await x.get('/api/me')).status).toBe(401);
    }
    await env.DB.prepare('UPDATE sessions SET expires_at=1').run();
    expect((await c.get('/api/me')).status).toBe(401);
    // fresh login, then logout kills it for real
    const d = new Client(); await d.post('/api/login', { email: 'empa@x.test', password: empA.password });
    const copy = d.cookie; await d.post('/api/logout');
    const replay = new Client(); replay.cookie = copy; expect((await replay.get('/api/me')).status).toBe(401);
    // restore sessions of the shared clients
    for (const [cl, mail] of [[empA, 'empa@x.test'], [empB, 'empb@x.test'], [mgrA, 'mgra@x.test'], [mgrB, 'mgrb@x.test'], [admin, 'owner@x.test']]) await cl.post('/api/login', { email: mail, password: cl === admin ? 'owner-password-1' : cl.password });
  });
  it('changing a password signs out every other session; a reset signs out all; a deactivated person is locked out at once', async () => {
    const e = await makeEmployee(admin, 'Temp1');
    const other = new Client(); await other.post('/api/login', { email: e.email, password: e.password });
    expect((await other.get('/api/me')).status).toBe(200);
    expect((await e.post('/api/password', { current: e.password, next: 'another-password-9' })).status).toBe(200);
    expect((await other.get('/api/me')).status).toBe(401);
    expect((await e.get('/api/me')).status).toBe(200);
    const fresh = new Client(); await fresh.post('/api/login', { email: e.email, password: 'another-password-9' });
    expect((await admin.post(`/api/admin/employees/${e.id}/reset-password`)).status).toBe(200);
    expect((await fresh.get('/api/me')).status).toBe(401);
    const f = await makeEmployee(admin, 'Temp2');
    await admin.post(`/api/admin/employees/${f.id}`, { active: false });
    expect((await f.get('/api/me')).status).toBe(401);
    expect((await new Client().post('/api/login', { email: f.email, password: f.password })).status).toBe(401);
  });
  it('weak passwords and wrong current passwords are refused; bootstrap cannot be replayed', async () => {
    const e = await makeEmployee(admin, 'Temp3');
    expect((await e.post('/api/password', { current: e.password, next: 'short' })).status).toBe(400);
    expect((await e.post('/api/password', { current: 'wrong-wrong-wrong', next: 'a-new-strong-pass-1' })).status).toBe(401);
    expect((await outsider.post('/api/bootstrap', { token: 'test-bootstrap-token', name: 'x', email: 'x@x.test', password: 'password-123456' })).status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM employees WHERE role='admin'").first()).n).toBe(1);
  });
  it('a stored password hash is never returned by any API', async () => {
    const dump = JSON.stringify([(await admin.get('/api/admin/employees')).data, (await admin.get('/api/admin/audit?limit=500')).data, (await admin.get('/api/admin/settings')).data, (await admin.get('/api/me')).data, (await admin.get('/api/admin/legacy')).data, (await admin.get('/api/admin/clickup/health')).data]);
    for (const needle of ['pw_hash', 'pw_salt', 'ENCRYPTION_KEY', 'test-bootstrap-token', 'secrets_store', 'whsec', 'owner-password-1']) expect(dump).not.toContain(needle);
  });
});

// ------------------------------------------------------------------------------------------------
describe('device binding attacks', () => {
  it('the same signed request cannot be replayed, even when fired twice at the same instant', async () => {
    vi.setSystemTime(T0 + 3 * H);
    const body = JSON.stringify({ request_id: rid() });
    const hdr = await empB.signHeaders('POST', '/api/checkin', body);
    const [a, b] = await Promise.all([1, 2].map(() => empB.req('POST', '/api/checkin', undefined, { raw: body, headers: hdr })));
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    await env.DB.prepare("UPDATE attendance SET status='closed',check_out_at=check_in_at+1000 WHERE employee_id=? AND status='open'").bind(empB.id).run();
  });
  it('a signature is bound to its own path and method (a check-in signature cannot clock someone out)', async () => {
    vi.setSystemTime(T0 + 4 * H);
    await empA.post('/api/checkin', { request_id: rid() }, { sign: true });
    const body = JSON.stringify({ request_id: rid(), exception_reason: 'stolen signature attempt' });
    const hdr = await empA.signHeaders('POST', '/api/checkin', JSON.stringify({ request_id: 'zzzzzzzz' }));
    expect((await empA.req('POST', '/api/checkout', undefined, { raw: body, headers: hdr })).data.error.code).toBe('device_mismatch');
  });
  it("a nonce issued to one person cannot be used by another; expired nonces fail", async () => {
    const n = (await empA.get('/api/challenge')).data.nonce;
    expect((await empB.req('POST', '/api/checkin', { request_id: rid() }, { headers: { 'x-nonce': n, 'x-sig': 'AAAA' } })).data.error.code).toBe('device_nonce_invalid');
    vi.setSystemTime(T0 + 4 * H + 61000);
    const m = (await empA.get('/api/challenge')).data.nonce;
    vi.setSystemTime(T0 + 4 * H + 130000);
    expect((await empA.req('POST', '/api/checkout', { request_id: rid(), exception_reason: 'late nonce attempt' }, { headers: { 'x-nonce': m, 'x-sig': 'AAAA' } })).data.error.code).toBe('device_nonce_invalid');
  });
  it('a revoked or still-pending computer cannot sign anything; the client cannot choose its own time', async () => {
    const e = await makeEmployee(admin, 'Revo');
    await giveShift(admin, e.id, { start: 0, end: 1439, days: 127 });
    expect((await e.post('/api/checkin', { request_id: rid() }, { sign: true })).data.error.code).toBe('device_not_approved');
    await approve(admin, e); await admin.post(`/api/admin/devices/${e.deviceId}/revoke`, { reason: 'lost laptop' });
    expect((await e.post('/api/checkin', { request_id: rid() }, { sign: true })).data.error.code).toBe('device_not_approved');
    vi.setSystemTime(T0 + 5 * H);
    const r = await empB.post('/api/checkin', { request_id: rid(), check_in_at: 1000, now: 5, time: 'yesterday' }, { sign: true });
    expect(r.data.attendance.check_in_at).toBe(T0 + 5 * H); // server clock only
    await env.DB.prepare("UPDATE attendance SET status='closed',check_out_at=check_in_at+1000 WHERE employee_id=? AND status='open'").bind(empB.id).run();
  });
});

// ------------------------------------------------------------------------------------------------
describe('ClickUp webhook as an attack surface', () => {
  const post = async (raw, sig) => (await SELF.fetch('https://ytm.test/api/webhooks/clickup', { method: 'POST', headers: { 'x-signature': sig ?? (await hmacHex('whsec', raw)), 'content-type': 'application/json' }, body: raw })).status;
  it('unsigned, wrongly signed, tampered-body and oversized requests are refused before any work', async () => {
    const raw = JSON.stringify({ webhook_id: 'w', event: 'taskStatusUpdated', task_id: 'TA', history_items: [{ id: 'h1', field: 'status', date: String(T0), before: { status: 'a' }, after: { status: 'done' } }] });
    const sig = await hmacHex('whsec', raw);
    expect(await post(raw, 'deadbeef')).toBe(401);
    expect(await post(raw, sig.toUpperCase())).toBe(200);
    expect(await post(raw.replace('done', 'DONE'), sig)).toBe(401);   // body changed after signing
    expect(await post(raw, '')).toBe(401);
    expect(await post('x'.repeat(600000))).toBe(413);
    const before = (await env.DB.prepare('SELECT COUNT(*) n FROM task_events').first()).n;
    expect(await post(raw, 'ff'.repeat(32))).toBe(401);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM task_events').first()).n).toBe(before);
  });
  it('malformed but correctly signed payloads cannot crash the server or plant bad data', async () => {
    for (const p of [{}, { event: 'taskStatusUpdated' }, { event: 'taskStatusUpdated', task_id: 'TA', history_items: 'no' }, { event: 'taskStatusUpdated', task_id: 'TA', history_items: [null, 5, 'x', { field: 'status' }] },
      { event: 'taskStatusUpdated', task_id: "x'; DROP TABLE tasks;--", history_items: [{ id: 'q', field: 'status', date: 'NaN', after: { status: '<b>x</b>' } }] }, { event: 'taskDeleted', task_id: 'NOPE' }, { event: 'listCreated', task_id: 'TA' }]) {
      const code = await post(JSON.stringify(p));
      expect(code).toBeLessThan(500);
    }
    expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").first())).toBeTruthy();
  });
});

// ------------------------------------------------------------------------------------------------
describe('flood guards and quotas', () => {
  it('one client hammering the API, or one address hammering login, gets 429 (free-tier write quota protection)', async () => {
    const small = Object.assign(Object.create(env), { LOGIN_PER_MIN: '5', USER_PER_10S: '8' });
    const mk = (path, cookie, method = 'GET', ip = '9.9.9.9') => new Request('https://ytm.test' + path, { method, headers: { cookie: cookie || '', 'x-requested-with': 'ytm', 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: method === 'GET' ? undefined : JSON.stringify({ email: 'nobody@x.test', password: 'x' }) });
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await handle(mk('/api/login', '', 'POST', '8.8.4.4'), small, { waitUntil() {} })).status);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]); expect(codes.slice(5)).toEqual([429, 429, 429]);
    const hits = [];
    for (let i = 0; i < 14; i++) hits.push((await handle(mk('/api/me', admin.cookie), small, { waitUntil() {} })).status);
    expect(hits.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(hits[0]).toBe(200);
  });
  it('repeated page loads write nothing to the database (no write-quota burn)', async () => {
    vi.setSystemTime(T0 + 8 * H);
    await empA.get('/api/today');
    const count = async () => (await env.DB.prepare('SELECT (SELECT COUNT(*) FROM task_sessions) s,(SELECT MAX(id) FROM task_sessions) m,(SELECT COUNT(*) FROM audit_log) a').first());
    const a = await count();
    for (let i = 0; i < 6; i++) await empA.get('/api/today');
    const b = await count();
    expect(b).toEqual(a);
  });
});
