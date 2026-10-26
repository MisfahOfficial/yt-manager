export class HttpError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra; }
}
export const bad = (code, msg, extra) => new HttpError(400, code, msg, extra);
export const forbidden = (code = 'forbidden', msg) => new HttpError(403, code, msg || 'You do not have access to this.');
export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const conflict = (code, msg, extra) => new HttpError(409, code, msg, extra);

const SEC = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};
export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...SEC, ...headers } });

export async function readJson(req, max = 64 * 1024) {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, 'too_large', 'Request too large.');
  if (!text) return { body: {}, text };
  try { return { body: JSON.parse(text), text }; } catch { throw bad('bad_json', 'Request was not valid JSON.'); }
}

export const str = (v, name, { min = 1, max = 500, optional = false } = {}) => {
  if (v == null || v === '') { if (optional) return null; throw bad('missing_' + name, `Please fill in ${name}.`); }
  if (typeof v !== 'string') throw bad('invalid_' + name, `${name} is not valid.`);
  const t = v.trim();
  if (t.length < min) throw bad('short_' + name, `${name} is too short.`);
  if (t.length > max) throw bad('long_' + name, `${name} is too long.`);
  return t;
};
export const httpUrl = (v, name, optional = false) => {
  const s = str(v, name, { max: 2000, optional });
  if (s == null) return null;
  let u; try { u = new URL(s); } catch { throw bad('invalid_' + name, `${name} must be a full web link.`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('invalid_' + name, `${name} must be a web link.`);
  return u.toString();
};
export const int = (v, name, { min = -Infinity, max = Infinity, optional = false } = {}) => {
  if (v == null || v === '') { if (optional) return null; throw bad('missing_' + name, `${name} is required.`); }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad('invalid_' + name, `${name} is not valid.`);
  return n;
};

export async function audit(db, a) {
  await auditStmt(db, a).run();
}
export function auditStmt(db, { at, actor, action, entity, entityId, before, after, reason }) {
  return db.prepare('INSERT INTO audit_log(at_ms,actor_id,action,entity,entity_id,before_json,after_json,reason) VALUES (?,?,?,?,?,?,?,?)')
    .bind(at ?? Date.now(), actor ?? null, action, entity ?? null, entityId == null ? null : String(entityId),
      before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), reason ?? null);
}
export async function getSetting(db, key, fallback = null) {
  const r = await db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return fallback; }
}
export const setSettingStmt = (db, key, val) =>
  db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, JSON.stringify(val));
