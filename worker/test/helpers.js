import { SELF, env } from 'cloudflare:test';
import { sha256Hex, b64u } from '../src/lib/crypto.js';
import { localMidnightMs } from '../src/lib/time.js';

export const OFFICE_IP = '203.0.113.7';
export const HOME_IP = '198.51.100.9';
const ORIGIN = 'https://ytm.test';

export class Client {
  constructor(ip = OFFICE_IP) { this.cookie = ''; this.ip = ip; this.keys = null; }
  async req(method, path, body, { sign = false, headers = {}, raw } = {}) {
    const text = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const h = { 'x-requested-with': 'ytm', 'cf-connecting-ip': this.ip, 'content-type': 'application/json', ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (sign) Object.assign(h, await this.signHeaders(method, path, text ?? ''));
    const res = await SELF.fetch(ORIGIN + path, { method, headers: h, body: method === 'GET' ? undefined : (text ?? '{}') });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const text2 = await res.text(); let data = null; try { data = JSON.parse(text2); } catch { data = text2 || null; }
    return { status: res.status, data };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b = {}, o) { return this.req('POST', p, b, o); }
  async signHeaders(method, path, bodyText, keys = this.keys) {
    const ch = await (await this.get('/api/challenge')).data;
    const msg = `${ch.nonce}.${method}.${path}.${await sha256Hex(bodyText)}`;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(msg));
    return { 'x-nonce': ch.nonce, 'x-sig': b64u(sig) };
  }
  async genKeys() {
    this.keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    this.jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    return this.jwk;
  }
}

export async function resetDb() {
  for (const t of ['task_sessions', 'task_events', 'task_assignees', 'tasks', 'deposits', 'idempotency', 'attendance', 'active_choices', 'gaps', 'revisions',
    'devices', 'nonces', 'sessions', 'login_attempts', 'employee_shifts', 'shifts', 'leave', 'overtime', 'network_exceptions', 'audit_log', 'settings', 'secrets_store',
    'report_snapshots', 'legacy_records', 'employees']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare('UPDATE sync_state SET last_ok_ms=NULL,last_attempt_ms=NULL,last_error=NULL,cursor=NULL,running=0,last_run_day=NULL').run();
}

export async function setupTeam() {
  await resetDb();
  const admin = new Client();
  let r = await admin.post('/api/bootstrap', { token: 'test-bootstrap-token', name: 'Owner', email: 'owner@x.test', password: 'owner-password-1' });
  if (r.status !== 200) throw new Error('bootstrap ' + JSON.stringify(r));
  await admin.post('/api/login', { email: 'owner@x.test', password: 'owner-password-1' });
  await admin.post('/api/admin/settings', { office_ips: [OFFICE_IP] });
  return admin;
}

// creates an employee, completes first-login password change, registers+approves a device
export async function makeEmployee(admin, name, extra = {}) {
  const email = name.toLowerCase().replace(/\W/g, '') + '@x.test';
  const c = await admin.post('/api/admin/employees', { name, email, ...extra });
  if (c.status !== 200) throw new Error('create ' + JSON.stringify(c));
  const cl = new Client();
  const l = await cl.post('/api/login', { email, password: c.data.temp_password });
  if (!l.data.must_change_pw) throw new Error('expected must_change_pw');
  await cl.post('/api/password', { current: c.data.temp_password, next: 'new-password-' + name });
  cl.id = c.data.id; cl.email = email; cl.password = 'new-password-' + name;
  await cl.genKeys();
  const d = await cl.post('/api/device', { jwk: cl.jwk, label: name + ' laptop' });
  cl.deviceId = d.data.id;
  return cl;
}
export async function approve(admin, cl) {
  const r = await admin.post(`/api/admin/devices/${cl.deviceId}/approve`, {});
  if (r.status !== 200) throw new Error('approve ' + JSON.stringify(r));
}
export const ALLDAYS = 127;
export async function giveShift(admin, empId, { start = 0, end = 1439, days = ALLDAYS, from = '2020-01-01' } = {}) {
  const s = await admin.post('/api/admin/shifts', { name: 'S' + start + '-' + end, start_min: start, end_min: end, days_mask: days, grace_min: 10 });
  const a = await admin.post(`/api/admin/employees/${empId}/shift`, { shift_id: s.data.id, effective_from: from });
  if (a.status !== 200) throw new Error('shift ' + JSON.stringify(a));
}
export const rid = () => crypto.randomUUID();
