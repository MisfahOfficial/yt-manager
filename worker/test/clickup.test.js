import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { setupTeam, makeEmployee, approve, giveShift } from './helpers.js';
import { runSync, processWebhook } from '../src/clickup.js';
import { localMidnightMs } from '../src/lib/time.js';

const H = 3600000;
const MON = localMidnightMs('2026-10-26');
let admin, ali, calls;

const task = (id, status, assignees = [555], due = null) => ({ id, name: 'Video ' + id, url: 'https://app.clickup.com/t/' + id, status: { status }, assignees: assignees.map((i) => ({ id: i })), due_date: due && String(due), date_updated: String(MON), list: { name: 'Channel A' } });
function mockEnv(handler) {
  calls = [];
  return Object.assign(Object.create(env), {
    CLICKUP_TOKEN: 'pk_test_token',
    CLICKUP_FETCH: async (url, init) => { calls.push({ url, init }); return handler(url, init); },
  });
}
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MON + 12 * H);
  admin = await setupTeam();
  ali = await makeEmployee(admin, 'Ali', { clickup_user_id: '555' });
  await admin.post('/api/admin/settings', { clickup_team_id: 'T1' });
});
afterAll(() => vi.useRealTimers());

describe('reconcile', () => {
  it('imports tasks with pagination and sends the token only server-side', async () => {
    const page0 = Array.from({ length: 100 }, (_, i) => task('P' + i, 'to do', [555]));
    const e = mockEnv((url) => ok(url.includes('page=0') ? { tasks: page0, last_page: false } : { tasks: [task('P100', 'in progress')], last_page: true }));
    const r = await runSync(e, Date.now(), { manual: true });
    expect(r).toMatchObject({ ok: true, done: true, pages: 2 });
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM tasks').first()).n).toBe(101);
    expect(calls.every((c) => c.init.headers.Authorization === 'pk_test_token')).toBe(true);
    expect(calls[0].url).toContain('/team/T1/task');
    expect(calls[0].url).toContain('assignees[]=555'); // only linked people's tasks
    // personal tokens go bare; OAuth tokens need Bearer
    const oe = mockEnv(() => ok({ teams: [] })); oe.CLICKUP_TOKEN = 'oauth_abc';
    await (await import('../src/clickup.js')).cu(oe, '/team');
    expect(calls[0].init.headers.Authorization).toBe('Bearer oauth_abc');
    const st = await env.DB.prepare('SELECT * FROM sync_state').first();
    expect(st.last_ok_ms).toBe(Date.now());
    expect(st.last_error).toBeNull();
  });
  it('a status change that webhooks missed becomes an UNVERIFIED gap, never counted time', async () => {
    const t0 = Date.now();
    await processWebhook(env, { webhook_id: 'w', event: 'taskStatusUpdated', task_id: 'G1', history_items: [{ id: 'g1', field: 'status', date: String(t0 - 5 * H), before: { status: 'to do' }, after: { status: 'blocked' } }] }, t0);
    await processWebhook(env, { webhook_id: 'w', event: 'taskAssigneeUpdated', task_id: 'G1', history_items: [{ id: 'g0', field: 'assignee_add', date: String(t0 - 6 * H), after: { id: 555 } }] }, t0);
    const e = mockEnv(() => ok({ tasks: [task('G1', 'in progress')], last_page: true }));
    await runSync(e, t0, { manual: true });
    const gap = await env.DB.prepare("SELECT * FROM gaps WHERE task_id='G1'").first();
    expect(gap.reason).toContain('no webhook was received');
    const sess = (await env.DB.prepare("SELECT * FROM task_sessions WHERE task_id='G1'").all()).results;
    expect(sess).toEqual([]);
    const ev = await env.DB.prepare("SELECT note,source FROM task_events WHERE task_id='G1' AND kind='status' ORDER BY at_ms DESC").first();
    expect(ev).toEqual({ note: 'approx', source: 'reconcile' });
  });
  it('detects reassignment, closes the old assignee, and deleted tasks (404 probe)', async () => {
    const t0 = Date.now();
    const e = mockEnv((url) => {
      if (url.includes('/task/P3')) return new Response('{}', { status: 404 });
      if (url.includes('/task/')) return ok(task('x', 'to do'));
      return ok({ tasks: [task('P1', 'to do', [777])], last_page: true });
    });
    await env.DB.prepare('UPDATE sync_state SET last_ok_ms=NULL').run(); // force a full pass (deletions are only probed on full passes)
    await runSync(e, t0 + 1000, { manual: true });
    const open = (await env.DB.prepare("SELECT clickup_user_id FROM task_assignees WHERE task_id='P1' AND end_ms IS NULL").all()).results.map((r) => r.clickup_user_id);
    expect(open).toEqual(['777']);
    const closed = await env.DB.prepare("SELECT end_ms FROM task_assignees WHERE task_id='P1' AND clickup_user_id='555'").first();
    expect(closed.end_ms).toBeGreaterThan(0);
    expect((await env.DB.prepare("SELECT deleted FROM tasks WHERE id='P3'").first()).deleted).toBe(1);
    expect((await env.DB.prepare("SELECT deleted FROM tasks WHERE id='P1'").first()).deleted).toBe(0);
  });
  it('rate limit: keeps going next tick and reports a friendly message', async () => {
    const e = mockEnv(() => new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': '9999999999' } }));
    const r = await runSync(e, Date.now() + 5000, { manual: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rate limit/i);
    expect((await env.DB.prepare('SELECT running FROM sync_state').first()).running).toBe(0);
  });
  it('revoked access is reported as such, not as a raw error', async () => {
    const e = mockEnv(() => new Response('{"err":"Token invalid"}', { status: 401 }));
    const r = await runSync(e, Date.now() + 9000, { manual: true });
    expect(r.error).toMatch(/revoked/i);
    const h = await admin.get('/api/admin/clickup/health');
    expect(h.data.last_error).toMatch(/Reconnect ClickUp/);
    expect(JSON.stringify(h.data)).not.toContain('pk_test_token');
  });
  it('5xx is retried then succeeds', async () => {
    let n = 0;
    const e = mockEnv((url) => (url.includes('/team/') ? (++n < 2 ? new Response('x', { status: 503 }) : ok({ tasks: [], last_page: true })) : ok(task('x', 'to do'))));
    const r = await runSync(e, Date.now() + 20000, { manual: true });
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
  });
  it('missing workspace / token produce clear errors', async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key='clickup_team_id'").run();
    const r = await runSync(mockEnv(() => ok({})), Date.now() + 30000, { manual: true });
    expect(r.error).toMatch(/workspace/i);
  });
});

describe('chunked sync', () => {
  beforeAll(async () => { await env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('clickup_team_id','\"T1\"')").run(); });
  it('large workspaces are processed a couple of pages per request and resume from a saved cursor', async () => {
    await env.DB.prepare('UPDATE sync_state SET last_ok_ms=NULL,cursor=NULL,running=0').run();
    const pageOf = (n) => Array.from({ length: n === 3 ? 20 : 100 }, (_, i) => task(`C${n}-${i}`, 'to do', [555]));
    const e = mockEnv((url) => { const pg = +/page=(\d+)/.exec(url)[1]; return ok({ tasks: pageOf(pg), last_page: pg === 3 }); });
    const t = Date.now() + 100000;
    const r1 = await runSync(e, t, { manual: true });
    expect(r1).toMatchObject({ ok: true, done: false, pages: 2 });
    expect(JSON.parse((await env.DB.prepare('SELECT cursor FROM sync_state').first()).cursor).page).toBe(2);
    const r2 = await runSync(e, t + 1000, { manual: true });
    expect(r2).toMatchObject({ ok: true, done: true, pages: 2 });
    const st = await env.DB.prepare('SELECT last_ok_ms,cursor,running,last_error FROM sync_state').first();
    expect(st).toMatchObject({ cursor: null, running: 0, last_error: null });
    expect(st.last_ok_ms).toBe(t + 1000);
  });
  it('after a good sync the next one is incremental (date_updated_gt, closed tasks included) and does not re-list everything', async () => {
    const e = mockEnv(() => ok({ tasks: [], last_page: true }));
    await runSync(e, Date.now() + 200000, { manual: true });
    expect(calls[0].url).toContain('date_updated_gt=');
    expect(calls[0].url).toContain('include_closed=true');
  });
});

describe('request changes', () => {
  it('records notes, writes the mapped Revisions status to ClickUp, and does not touch task_events (no sync loop)', async () => {
    await admin.post('/api/admin/settings', { revisions_status: 'revisions', clickup_team_id: 'T1' });
    await env.DB.prepare("INSERT OR IGNORE INTO tasks(id,name,first_seen_ms) VALUES ('R1','Rev video',1)").run();
    await env.DB.prepare("INSERT INTO task_assignees(task_id,clickup_user_id,start_ms) VALUES ('R1','555',1)").run();
    const before = (await env.DB.prepare('SELECT COUNT(*) n FROM task_events').first()).n;
    const e = mockEnv(() => ok({}));
    const owner = await env.DB.prepare("SELECT * FROM employees WHERE role='admin'").first();
    const { requestChanges } = await import('../src/work.js');
    const resp = await requestChanges({ env: e, emp: owner, now: Date.now(), body: { notes: 'Fix audio at 2:10', links: ['https://drive.example.com/ref'] }, params: { id: 'R1' } });
    const r = { data: await resp.json() };
    const seen = calls.map((c) => [c.url, c.init.method]);
    expect(r.data).toMatchObject({ ok: true, clickup: 'written' });
    expect(seen.map((s) => s[1])).toEqual(['PUT', 'POST']);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM task_events').first()).n).toBe(before);
    expect((await env.DB.prepare('SELECT notes FROM revisions').first()).notes).toBe('Fix audio at 2:10');
    const bad = await admin.post('/api/tasks/R1/changes', { notes: 'x', links: ['javascript:alert(1)'] });
    expect(bad.status).toBe(400);
    expect((await ali.post('/api/tasks/R1/changes', { notes: 'x' })).status).toBe(403);
  });
});

describe('OAuth connect', () => {
  it('needs a server-side OAuth app; state is single use and expires; token stored encrypted', async () => {
    const e0 = await admin.post('/api/admin/clickup/oauth', {});
    expect(e0.data.error.code).toBe('oauth_not_configured');
    const { oauthStart, oauthCallback } = await import('../src/clickup.js');
    const owner = await env.DB.prepare("SELECT * FROM employees WHERE role='admin'").first();
    const e = mockEnv(() => ok({ access_token: 'oauth_secret_token' }));
    e.CLICKUP_CLIENT_ID = 'cid'; e.CLICKUP_CLIENT_SECRET = 'csec';
    const started = await (await oauthStart({ env: e, req: new Request('https://ytm.test/api/admin/clickup/oauth'), emp: owner, now: Date.now() })).json();
    const state = new URL(started.url).searchParams.get('state');
    expect(started.url).toContain('client_id=cid');
    expect(started.url).not.toContain('csec');
    const cb = (st) => oauthCallback({ env: e, url: new URL(`https://ytm.test/api/clickup/callback?code=abc&state=${st}`), now: Date.now() });
    await expect(cb('wrong')).rejects.toMatchObject({ code: 'oauth_state' });
    const good = await cb(state);
    expect(good.status).toBe(302);
    const stored = await env.DB.prepare("SELECT value FROM secrets_store WHERE key='clickup_token'").first();
    expect(stored.value).not.toContain('oauth_secret_token');
    await expect(cb(state)).rejects.toMatchObject({ code: 'oauth_state' }); // replay
  });
});

describe('scheduled sync discipline', { timeout: 30000 }, () => {
  it('only fires after the configured Karachi time, once per day, and retries failures at most every 2 hours', async () => {
    const { cronTick } = await import('../src/clickup.js');
    await env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('clickup_team_id','\"T1\"'),('sync_time_min','1110')").run();
    await env.DB.prepare('UPDATE sync_state SET last_run_day=NULL,last_attempt_ms=NULL,cursor=NULL,running=0').run();
    const day = localMidnightMs('2026-11-02');
    const e = mockEnv(() => ok({ tasks: [], last_page: true }));
    await cronTick(e, day + 10 * H);            // 10:00 PKT: too early
    expect(calls.length).toBe(0);
    await cronTick(e, day + 19 * H);            // 19:00 PKT: due
    expect(calls.length).toBeGreaterThan(0);
    const n = calls.length;
    await cronTick(e, day + 19.25 * H);         // next 15-min tick: already done today
    expect(calls.length).toBe(n);
    const bad = mockEnv(() => new Response('{}', { status: 401 }));
    await env.DB.prepare('UPDATE sync_state SET last_run_day=NULL,last_attempt_ms=?').bind(day + 19 * H).run();
    await cronTick(bad, day + 19.5 * H);        // failed earlier 30 min ago: wait
    expect(calls.length).toBe(0);
    await cronTick(bad, day + 21.5 * H);        // 2.5 h later: one retry
    expect(calls.length).toBe(1);
    expect((await env.DB.prepare('SELECT cursor FROM sync_state').first()).cursor).toBeNull();
  });
});

describe('titles: counting tasks a person creates (title finder)', () => {
  let tf2;
  const mk = (id, name, by, at) => ({ id, name, url: 'https://app.clickup.com/t/' + id, status: { status: 'to do' }, assignees: [], creator: { id: by }, date_created: String(at), date_updated: String(at), list: { name: 'V3 & V4' } });
  beforeAll(async () => {
    tf2 = await makeEmployee(admin, 'Tina', { job_role: 'Title finder', clickup_user_id: '4242' });
    await env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('clickup_team_id','\"T1\"')").run();
    await admin.post('/api/admin/settings', { created_tracking_jobs: ['Title finder'] });
  });
  it('created pass stores only tasks made by tracked people, with no assignee needed', async () => {
    const { createdPass } = await import('../src/clickup.js');
    const t = Date.now();
    const e = mockEnv(() => ok({ last_page: true, tasks: [
      mk('N1', 'V4--30 Forgotten $1 Meals for Two Seniors', '4242', t - 3600000),
      mk('N2', 'V3--12 Britain\'s lost school dinners', '4242', t - 7200000),
      mk('N3', 'Fix thumbnail for video 9', '4242', t - 1000),        // no channel code
      mk('N4', 'V4--31 forgotten $1 meals for two seniors', '4242', t - 500), // repeats N1
      mk('X1', 'V1--5 Someone elses task', '9999', t - 100),            // not tracked
    ] }));
    await createdPass(e, t);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM tasks WHERE id IN ('N1','N2','N3','N4','X1')").first()).n).toBe(4);
    expect((await env.DB.prepare("SELECT 1 FROM tasks WHERE id='X1'").first())).toBeNull();
  });
  it('reports count per channel code, flag missing codes and repeats; Today shows the person their own count', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const rep = (await admin.get(`/api/reports?kind=monthly&period=${period}`)).data;
    const r = rep.employees.find((x) => x.employee.id === tf2.id);
    expect(r.created.total).toBe(4);
    expect(r.created.by_code).toEqual({ V4: 2, V3: 1 });
    expect(r.created.no_code.map((x) => x.name)).toEqual(['Fix thumbnail for video 9']);
    expect(r.created.duplicates.length).toBe(2); // N1 and N4 repeat each other
    expect(r.attention.join(' ')).toMatch(/without a channel code/);
    expect(rep.totals.created).toBeGreaterThanOrEqual(4);
    const today = (await tf2.get('/api/today')).data;
    expect(today.created.week).toBeGreaterThan(0);
    expect(today.created.by_code.V4).toBe(2);
  });
  it('webhook taskCreated records who created it', async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO secrets_store(key,value) VALUES ('clickup_webhook_secret',?)").bind(await (await import('../src/lib/crypto.js')).encryptSecret(env.ENCRYPTION_KEY, 'whsec')).run();
    const { processWebhook } = await import('../src/clickup.js');
    const at = Date.now();
    const r = await processWebhook(env, { webhook_id: 'w', event: 'taskCreated', task_id: 'NEW1', history_items: [{ id: 'c1', field: 'status', date: String(at), before: null, after: { status: 'to do' }, user: { id: 4242 } }] }, at);
    expect(r.changed).toBe(true);
    const row = await env.DB.prepare("SELECT creator_id,created_ms FROM tasks WHERE id='NEW1'").first();
    expect(row).toEqual({ creator_id: '4242', created_ms: at });
  });
  it('the people who are not tracked get no title block', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const rep = (await admin.get(`/api/reports?kind=monthly&period=${period}`)).data;
    expect(rep.employees.filter((x) => x.employee.id !== tf2.id).every((x) => x.created === null)).toBe(true);
  });
});
