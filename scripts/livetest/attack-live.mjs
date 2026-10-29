// Live attack + behaviour test against a STAGING copy on real Cloudflare (fake data only).
// node attack-live.mjs <base-url> <bootstrap-token> <enc-key-hex>
import { webcrypto as crypto } from 'node:crypto';
const [BASE, BOOT, KEY] = process.argv.slice(2);
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const results = []; let fails = 0;
const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

class C {
  constructor() { this.cookie = ''; }
  async req(method, path, body, { headers = {}, raw, sign } = {}) {
    const text = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const h = { 'x-requested-with': 'ytm', 'content-type': 'application/json', ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (sign) Object.assign(h, await this.sig(method, path, text ?? '{}'));
    const t0 = performance.now();
    const res = await fetch(BASE + path, { method, headers: h, body: method === 'GET' ? undefined : (text ?? '{}'), redirect: 'manual' });
    const ms = performance.now() - t0;
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let data = null; const txt = await res.text(); try { data = JSON.parse(txt); } catch { data = txt; }
    return { status: res.status, data, ms, headers: res.headers };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b = {}, o) { return this.req('POST', p, b, o); }
  async sig(method, path, bodyText) {
    const ch = (await this.get('/api/challenge')).data;
    const msg = `${ch.nonce}.${method}.${path}.${await sha(bodyText)}`;
    const s = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, enc.encode(msg));
    return { 'x-nonce': ch.nonce, 'x-sig': b64u(s) };
  }
  async genKeys() { this.keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']); const j = await crypto.subtle.exportKey('jwk', this.keys.publicKey); this.jwk = { kty: 'EC', crv: 'P-256', x: j.x, y: j.y }; }
}
const rid = () => crypto.randomUUID();
const OWNER_PW = 'live-test-owner-password-1';

// ---------- A. basics over real HTTPS
const admin = new C();
let r = await admin.get('/api/health');
ok('health reachable over HTTPS', r.status === 200 && r.data.needs_setup === true);
const root = await fetch(BASE + '/');
ok('site sends CSP + HSTS + frame protection', /default-src 'self'/.test(root.headers.get('content-security-policy') || '') && /max-age/.test(root.headers.get('strict-transport-security') || '') && /DENY/i.test(root.headers.get('x-frame-options') || ''), `csp=${!!root.headers.get('content-security-policy')} hsts=${root.headers.get('strict-transport-security')}`);
const http = await fetch(BASE.replace('https', 'http') + '/', { redirect: 'manual' });
ok('plain http is redirected to https (passwords never travel in clear)', http.status === 301 && (http.headers.get('location') || '').startsWith('https://'), `status ${http.status}`);
r = await admin.post('/api/bootstrap', { token: 'wrong', name: 'x', email: 'x@x.test', password: 'password-123456' });
ok('bootstrap with a wrong setup code is refused', r.status === 403);
r = await admin.post('/api/bootstrap', { token: BOOT, name: 'Owner', email: 'owner@live.test', password: OWNER_PW });
ok('bootstrap with the right code works once', r.status === 200);
r = await admin.post('/api/bootstrap', { token: BOOT, name: 'Evil', email: 'evil@live.test', password: 'password-123456' });
ok('bootstrap cannot be repeated', r.status === 403);
r = await admin.post('/api/login', { email: 'owner@live.test', password: OWNER_PW });
ok('owner login works on the free CPU limit (PBKDF2 100k)', r.status === 200, `${r.ms.toFixed(0)} ms`);
const sc = r.headers.get('set-cookie') || '';
ok('session cookie is HttpOnly + Secure + SameSite=Strict', /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Strict/.test(sc));

// ---------- B. CPU / latency: 15 logins in a row
const lat = [];
for (let i = 0; i < 15; i++) { const x = await new C().post('/api/login', { email: 'owner@live.test', password: OWNER_PW }); lat.push([x.status, x.ms]); }
ok('15 consecutive logins: no CPU-limit errors', lat.every(([s]) => s === 200), `status set ${[...new Set(lat.map((l) => l[0]))]} avg ${(lat.reduce((a, l) => a + l[1], 0) / lat.length).toFixed(0)} ms, max ${Math.max(...lat.map((l) => l[1])).toFixed(0)} ms`);

// ---------- C. office network: spoofing from outside
await admin.post('/api/admin/settings', { office_ips: ['203.0.113.7'] });
const mk = async (name, extra = {}) => {
  const email = name.toLowerCase() + '@live.test';
  const c1 = await admin.post('/api/admin/employees', { name, email, ...extra });
  const c = new C(); await c.post('/api/login', { email, password: c1.data.temp_password });
  const pw = 'Strong-' + name + '-pass-1'; await c.post('/api/password', { current: c1.data.temp_password, next: pw });
  await c.genKeys(); const d = await c.post('/api/device', { jwk: c.jwk, label: name });
  await admin.post(`/api/admin/devices/${d.data.id}/approve`, {});
  const s = await admin.post('/api/admin/shifts', { name: 'AllDay' + name, start_min: 0, end_min: 1439, days_mask: 127 });
  await admin.post(`/api/admin/employees/${c1.data.id}/shift`, { shift_id: s.data.id, effective_from: '2020-01-01' });
  c.id = c1.data.id; c.email = email; c.pw = pw; return c;
};
const sara = await mk('Sara');
const variants = [['none', {}], ['x-forwarded-for', { 'x-forwarded-for': '203.0.113.7' }], ['x-real-ip', { 'x-real-ip': '203.0.113.7' }], ['cf-connecting-ip', { 'cf-connecting-ip': '203.0.113.7' }], ['true-client-ip', { 'true-client-ip': '203.0.113.7' }], ['forwarded', { forwarded: 'for=203.0.113.7' }], ['cf-connecting-ipv6', { 'cf-connecting-ipv6': '203.0.113.7' }], ['all at once', { 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.7', 'cf-connecting-ip': '203.0.113.7', 'true-client-ip': '203.0.113.7' }]];
let seen = '';
for (const [name, hdr] of variants) {
  const x = await sara.post('/api/checkin', { request_id: rid(), ip: '203.0.113.7' }, { sign: true, headers: hdr });
  seen = /as ([0-9a-f:.]+)\./i.exec(x.data?.error?.message || '')?.[1] || seen;
  const edge = x.status === 403 && typeof x.data === 'string'; // Cloudflare itself rejects a client-supplied CF-Connecting-IP before the app sees it
  ok(`spoofed network claim refused (${name})`, x.status === 403 && (x.data?.error?.code === 'not_office_network' || edge), edge ? 'blocked by Cloudflare edge (403)' : `server saw ${seen}`);
}
// ---------- D. legitimate: add the address the server really sees
const rule = seen.includes(':') ? seen.split(':').slice(0, 4).join(':') + '::/64' : seen;
await admin.post('/api/admin/settings', { office_ips: ['203.0.113.7', rule] });
r = await sara.post('/api/checkin', { request_id: rid() }, { sign: true });
ok('check-in works once the real address is allowed', r.status === 200, `rule ${rule}`);
const dup = await sara.post('/api/checkin', { request_id: rid() }, { sign: true });
ok('a second check-in is refused (no duplicate attendance)', dup.status === 409);

// ---------- E. 8 people at once
const people = [sara];
for (const n of ['Omar', 'Huda', 'Zayn', 'Ali', 'Noor', 'Bilal', 'Hira']) people.push(await mk(n));
const t0 = performance.now();
const ins = await Promise.all(people.slice(1).map((p) => p.post('/api/checkin', { request_id: rid() }, { sign: true })));
ok('7 people check in at the same moment', ins.every((x) => x.status === 200), `${(performance.now() - t0).toFixed(0)} ms total, statuses ${[...new Set(ins.map((x) => x.status))]}`);
const ups = await Promise.all(people.map((p) => p.post('/api/progress', { request_id: rid(), taskless_reason: 'Live test work', link: 'https://drive.example.com/live', completed: 'Did things ' + p.email })));
ok('8 people save an update at the same moment', ups.every((x) => x.status === 200), `statuses ${[...new Set(ups.map((x) => x.status))]}`);
const outs = await Promise.all(people.map((p) => p.post('/api/checkout', { request_id: rid() }, { sign: true })));
ok('8 people clock out at the same moment', outs.every((x) => x.status === 200), `statuses ${[...new Set(outs.map((x) => x.status))]}`);
const att = (await admin.get('/api/attendance?days=1')).data.attendance;
ok('exactly one attendance row per person, all closed', att.length === 8 && att.every((a) => a.status === 'closed'), `rows ${att.length}`);
// isolation between real sessions
const peek = await people[1].get('/api/history?days=1');
ok("a person only sees their own updates", JSON.stringify(peek.data).includes(people[1].email) && !people.filter((p) => p !== people[1]).some((p) => JSON.stringify(peek.data).includes(p.email)));
ok('employees are refused every manager/admin route', (await Promise.all(['/api/team', '/api/reports', '/api/admin/employees', '/api/admin/audit', '/api/calendar', '/api/admin/settings'].map((u) => people[2].get(u)))).every((x) => x.status === 403));

// ---------- F. ClickUp webhook: forged vs real, burst, duplicates, out of order (secret pre-loaded into staging)
const hmac = async (sec, body) => { const k = await crypto.subtle.importKey('raw', enc.encode(sec), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return hex(await crypto.subtle.sign('HMAC', k, enc.encode(body))); };
const hook = async (p, secret = 'live-webhook-secret', sigOverride) => { const raw = typeof p === 'string' ? p : JSON.stringify(p); const t = performance.now(); const x = await fetch(BASE + '/api/webhooks/clickup', { method: 'POST', headers: { 'x-signature': sigOverride ?? await hmac(secret, raw), 'content-type': 'application/json' }, body: raw }); return { status: x.status, ms: performance.now() - t }; };
const ev = (task, id, field, at, before, after) => ({ webhook_id: 'wl', event: field === 'status' ? 'taskStatusUpdated' : 'taskAssigneeUpdated', task_id: task, history_items: [{ id, field, date: String(at), before, after, user: { id: 1 } }] });
ok('forged webhook (wrong secret) is refused', (await hook(ev('X1', 'f1', 'status', Date.now(), { status: 'a' }, { status: 'b' }), 'not-the-secret')).status === 401);
ok('webhook with no signature is refused', (await hook(ev('X1', 'f2', 'status', Date.now(), { status: 'a' }, { status: 'b' }), 'x', '')).status === 401);
ok('webhook garbage/oversize refused without a crash', [(await hook('not json')).status, (await hook('x'.repeat(600000))).status].every((s) => s === 400 || s === 413 || s === 401));
const base = Date.now() - 3600000;
const batch = [];
for (let t = 0; t < 10; t++) { for (let k = 0; k < 8; k++) batch.push(ev('LT' + t, `e${t}-${k}`, 'status', base + k * 1000, { status: 'x' }, { status: 's' + k })); }
const dups = batch.slice(0, 20); const all = [...batch, ...dups];
for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
const t1 = performance.now(); const outs2 = [];
for (let i = 0; i < all.length; i += 10) outs2.push(...await Promise.all(all.slice(i, i + 10).map((p) => hook(p))));
ok('100 shuffled webhook events (20 duplicates) all accepted, none crashed', outs2.every((x) => x.status === 200), `${outs2.length} in ${(performance.now() - t1).toFixed(0)} ms; max ${Math.max(...outs2.map((x) => x.ms)).toFixed(0)} ms; statuses ${[...new Set(outs2.map((x) => x.status))]}`);
await new Promise((r) => setTimeout(r, 2500));
let good = 0;
for (let t = 0; t < 10; t++) { const d = (await admin.get('/api/tasks/LT' + t)).data; const stories = (d.story || []).filter((x) => /Moved to/.test(x.text)); if (stories.length === 8 && stories[0].text === 'Moved to s7') good++; }
ok('every task ends in its true latest status, no duplicate events, despite shuffled delivery', good === 10, `${good}/10 tasks correct`);

// ---------- G. brute force and flood
const victim = people[3]; let codes = [];
for (let i = 0; i < 8; i++) codes.push((await new C().post('/api/login', { email: victim.email, password: 'guess' + i })).status);
ok('brute-force on one account is locked after 5 tries', codes.slice(0, 5).every((c) => c === 401) && codes.slice(5).every((c) => c === 429), codes.join(','));
const flood = []; for (let i = 0; i < 30; i++) flood.push((await new C().post('/api/login', { email: 'ghost' + i + '@live.test', password: 'x' })).status);
ok('a flood of logins from one address is throttled', flood.includes(429), `${flood.filter((s) => s === 429).length} of 30 throttled`);
console.log('waiting 65 s for the per-address throttle window...'); await new Promise((r) => setTimeout(r, 65000));
const admin2 = new C(); await admin2.post('/api/login', { email: 'owner@live.test', password: OWNER_PW });
ok('owner can sign in again once the throttle window passes', (await admin2.get('/api/me')).status === 200);

// ---------- H. stored XSS / injection round trip
const xss = await admin2.post('/api/admin/employees', { name: '<img src=x onerror="window.__xss=1">', email: 'xss@live.test', job_role: '"><script>window.__xss=2</script>' });
ok('hostile name accepted as plain data', xss.status === 200);
const sqli = await new C().post('/api/login', { email: "' OR '1'='1' --", password: "' OR '1'='1" });
ok('SQL injection on login is refused', sqli.status === 401 || sqli.status === 400);
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
