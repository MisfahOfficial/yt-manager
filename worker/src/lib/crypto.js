const enc = new TextEncoder();
export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));
export const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export const randomToken = (bytes = 32) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
export const uuid = () => crypto.randomUUID();
export async function sha256Hex(str) { return hex(await crypto.subtle.digest('SHA-256', typeof str === 'string' ? enc.encode(str) : str)); }

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function hashPassword(password, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: iter }, key, 256);
  return hex(bits);
}
export async function newPasswordRecord(password, iter) {
  const salt = randomToken(16);
  return { pw_salt: salt, pw_iter: iter, pw_hash: await hashPassword(password, salt, iter) };
}
export async function checkPassword(password, rec) {
  const h = await hashPassword(password, rec.pw_salt, rec.pw_iter);
  return timingSafeEqual(h, rec.pw_hash);
}

export async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, typeof body === 'string' ? enc.encode(body) : body));
}

// ---- device keys: ECDSA P-256, signature in IEEE-P1363 (r||s) form as produced by WebCrypto.
const EC = { name: 'ECDSA', namedCurve: 'P-256' };
export function normalizeJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('bad_key');
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}
export const jwkFingerprint = async (jwk) => { const j = normalizeJwk(jwk); return sha256Hex(`${j.crv}|${j.x}|${j.y}`); };
export async function verifyDeviceSig(jwk, message, sigB64u) {
  try {
    const key = await crypto.subtle.importKey('jwk', normalizeJwk(jwk), EC, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(sigB64u), enc.encode(message));
  } catch { return false; }
}

// ---- AES-GCM for tokens at rest (ENCRYPTION_KEY secret = 64 hex chars)
async function aesKey(secretHex) { return crypto.subtle.importKey('raw', unhex(secretHex), 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function encryptSecret(secretHex, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secretHex), enc.encode(plain));
  return hex(iv) + ':' + hex(ct);
}
export async function decryptSecret(secretHex, blob) {
  const [iv, ct] = blob.split(':');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(iv) }, await aesKey(secretHex), unhex(ct));
  return new TextDecoder().decode(pt);
}
