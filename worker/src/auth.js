import { HttpError, bad, forbidden, json, str, audit, getSetting } from './http.js';
import { hashPassword, newPasswordRecord, checkPassword, randomToken, sha256Hex, timingSafeEqual, jwkFingerprint, verifyDeviceSig, normalizeJwk, uuid } from './lib/crypto.js';

export const COOKIE = 'ytm_s';
const MAX_FAILS = 5, FAIL_WINDOW = 15 * 60000;

export function readCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
const cookieHeader = (val, maxAgeSec) => `${COOKIE}=${val}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;

export function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(14));
  return [...b].map((x) => alphabet[x % alphabet.length]).join('');
}
export function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw bad('weak_password', 'Password must be at least 10 characters.');
  if (pw.length > 200) throw bad('weak_password', 'Password is too long.');
}

export async function loadSession(ctx) {
  const tok = readCookie(ctx.req, COOKIE);
  if (!tok || !/^[0-9a-f]{64}$/.test(tok)) return null;
  const h = await sha256Hex(tok);
  const row = await ctx.env.DB.prepare(
    `SELECT e.id,e.name,e.email,e.role,e.job_role,e.can_correct,e.manager_id,e.must_change_pw,e.clickup_user_id,e.active,s.expires_at
       FROM sessions s JOIN employees e ON e.id=s.employee_id WHERE s.token_hash=?`).bind(h).first();
  if (!row || row.expires_at < ctx.now || !row.active) return null;
  return row;
}

export async function bootstrap(ctx) {
  const { body, env } = ctx;
  const any = await env.DB.prepare("SELECT 1 FROM employees WHERE role='admin'").first();
  if (any) throw forbidden('already_bootstrapped', 'Setup is already done.');
  if (!env.BOOTSTRAP_TOKEN || typeof body.token !== 'string' || !timingSafeEqual(body.token, env.BOOTSTRAP_TOKEN)) throw forbidden('bad_bootstrap', 'Setup code is wrong.');
  const name = str(body.name, 'name', { max: 100 });
  const email = str(body.email, 'email', { max: 200 }).toLowerCase();
  checkPasswordPolicy(body.password);
  const rec = await newPasswordRecord(body.password, +env.PBKDF2_ITER || 100000);
  const id = uuid();
  await env.DB.prepare(`INSERT INTO employees(id,name,email,role,can_correct,pw_hash,pw_salt,pw_iter,must_change_pw,created_at) VALUES (?,?,?,?,1,?,?,?,0,?)`)
    .bind(id, name, email, 'admin', rec.pw_hash, rec.pw_salt, rec.pw_iter, ctx.now).run();
  await audit(env.DB, { at: ctx.now, actor: id, action: 'bootstrap_admin', entity: 'employee', entityId: id });
  return json({ ok: true });
}

export async function login(ctx) {
  const { env, body } = ctx;
  const email = str(body.email, 'email', { max: 200 }).toLowerCase();
  if (typeof body.password !== 'string' || !body.password || body.password.length > 200) throw bad('missing_password', 'Please enter your password.');
  const fails = await env.DB.prepare('SELECT COUNT(*) n FROM login_attempts WHERE email=? AND ok=0 AND at>?').bind(email, ctx.now - FAIL_WINDOW).first();
  if (fails.n >= MAX_FAILS) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again in 15 minutes.');
  const emp = await env.DB.prepare('SELECT * FROM employees WHERE email=?').bind(email).first();
  let ok = false;
  if (emp && emp.active) ok = await checkPassword(body.password, emp);
  else await hashPassword(body.password, '00'.repeat(16), +env.PBKDF2_ITER || 100000); // equalise timing
  await env.DB.prepare('INSERT INTO login_attempts(email,at,ok) VALUES (?,?,?)').bind(email, ctx.now, ok ? 1 : 0).run();
  if (!ok) throw new HttpError(401, 'bad_login', 'Email or password is wrong. Use exactly the email your admin entered for you.');
  const tok = randomToken(32);
  const ttl = (+env.SESSION_HOURS || 12) * 3600000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(ctx.now),
    env.DB.prepare('INSERT INTO sessions(token_hash,employee_id,created_at,expires_at) VALUES (?,?,?,?)').bind(await sha256Hex(tok), emp.id, ctx.now, ctx.now + ttl),
  ]);
  return json({ ok: true, must_change_pw: !!emp.must_change_pw }, 200, { 'set-cookie': cookieHeader(tok, Math.floor(ttl / 1000)) });
}

export async function logout(ctx) {
  const tok = readCookie(ctx.req, COOKIE);
  if (tok) await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256Hex(tok)).run();
  return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0) });
}

export async function changePassword(ctx) {
  const { env, body, emp } = ctx;
  const row = await env.DB.prepare('SELECT * FROM employees WHERE id=?').bind(emp.id).first();
  if (!(await checkPassword(String(body.current || ''), row))) throw new HttpError(401, 'bad_login', 'Current password is wrong.');
  checkPasswordPolicy(body.next);
  if (body.next === body.current) throw bad('same_password', 'Choose a different password.');
  const rec = await newPasswordRecord(body.next, +env.PBKDF2_ITER || 100000);
  const keep = await sha256Hex(readCookie(ctx.req, COOKIE));
  await env.DB.batch([
    env.DB.prepare('UPDATE employees SET pw_hash=?,pw_salt=?,pw_iter=?,must_change_pw=0 WHERE id=?').bind(rec.pw_hash, rec.pw_salt, rec.pw_iter, emp.id),
    env.DB.prepare('DELETE FROM sessions WHERE employee_id=? AND token_hash<>?').bind(emp.id, keep),
  ]);
  await audit(env.DB, { at: ctx.now, actor: emp.id, action: 'password_changed', entity: 'employee', entityId: emp.id });
  return json({ ok: true });
}

// ---------- device binding ----------
const NONCE_TTL = 60000;
export async function issueChallenge(ctx) {
  const nonce = randomToken(24);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM nonces WHERE expires_at<?').bind(ctx.now),
    ctx.env.DB.prepare('INSERT INTO nonces(nonce,employee_id,expires_at) VALUES (?,?,?)').bind(nonce, ctx.emp.id, ctx.now + NONCE_TTL),
  ]);
  return json({ nonce, expires_in: NONCE_TTL / 1000 });
}

// Proves the request was signed by THIS employee's approved device key. Single-use nonce prevents replay.
export async function requireDevice(ctx) {
  const nonce = ctx.req.headers.get('x-nonce');
  const sig = ctx.req.headers.get('x-sig');
  if (!nonce || !sig) throw new HttpError(401, 'device_signature_missing', 'This device must be approved before you can do this.');
  const used = await ctx.env.DB.prepare('DELETE FROM nonces WHERE nonce=? AND employee_id=? AND expires_at>=? RETURNING nonce')
    .bind(nonce, ctx.emp.id, ctx.now).first();
  if (!used) throw new HttpError(401, 'device_nonce_invalid', 'Request expired. Please try again.');
  const dev = await ctx.env.DB.prepare("SELECT id,pubkey_jwk FROM devices WHERE employee_id=? AND status='approved'").bind(ctx.emp.id).first();
  if (!dev) throw new HttpError(403, 'device_not_approved', 'This device is not approved yet. Ask your admin.');
  const path = new URL(ctx.req.url).pathname;
  const msg = `${nonce}.${ctx.req.method}.${path}.${await sha256Hex(ctx.rawBody || '')}`;
  if (!(await verifyDeviceSig(JSON.parse(dev.pubkey_jwk), msg, sig))) throw new HttpError(403, 'device_mismatch', 'This is not your approved device.');
  return dev.id;
}

export async function registerDevice(ctx) {
  const { env, body, emp } = ctx;
  let jwk;
  try { jwk = normalizeJwk(body.jwk); } catch { throw bad('bad_key', 'Device key is not valid.'); }
  const fp = await jwkFingerprint(jwk);
  const label = str(body.label, 'label', { optional: true, max: 80 });
  const dup = await env.DB.prepare('SELECT employee_id,status FROM devices WHERE pubkey_fp=?').bind(fp).first();
  if (dup) {
    if (dup.employee_id === emp.id) return json({ ok: true, status: dup.status });
    throw new HttpError(409, 'device_taken', 'This device is already registered to someone else.');
  }
  const pend = await env.DB.prepare("SELECT COUNT(*) n FROM devices WHERE employee_id=? AND status='pending'").bind(emp.id).first();
  if (pend.n >= 3) throw new HttpError(429, 'too_many_pending', 'You already have requests waiting for the admin.');
  const id = uuid();
  await env.DB.prepare("INSERT INTO devices(id,employee_id,pubkey_jwk,pubkey_fp,label,status,created_at) VALUES (?,?,?,?,?,'pending',?)")
    .bind(id, emp.id, JSON.stringify(jwk), fp, label, ctx.now).run();
  await audit(env.DB, { at: ctx.now, actor: emp.id, action: 'device_requested', entity: 'device', entityId: id, after: { label } });
  return json({ ok: true, status: 'pending', id });
}

export async function myDeviceStatus(ctx) {
  const fp = ctx.url.searchParams.get('fp');
  const rows = (await ctx.env.DB.prepare('SELECT id,label,status,created_at,pubkey_fp FROM devices WHERE employee_id=? ORDER BY created_at DESC LIMIT 5').bind(ctx.emp.id).all()).results;
  return json({ devices: rows.map((r) => ({ id: r.id, label: r.label, status: r.status, created_at: r.created_at, this_device: fp ? r.pubkey_fp === fp : undefined })) });
}
