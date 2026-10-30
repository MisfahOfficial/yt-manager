// DOM helper: never uses innerHTML, so server text can't inject markup.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'href') el.setAttribute('href', /^(https?:\/\/|#|\/(?!\/))/i.test(String(v)) ? v : '#');
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);

// ---- Asia/Karachi (UTC+5, no DST) ----
const PK = 5 * 3600000;
const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(ms) { if (ms == null) return '—'; const d = new Date(ms + PK); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
export function fmtDate(ms) { const d = new Date(ms + PK); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`; }
export const fmtDateTime = (ms) => (ms == null ? '—' : `${fmtDate(ms)}, ${fmtTime(ms)}`);
export function fmtDur(ms) { const m = Math.round((ms || 0) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)} min`; }
export const toInput = (ms) => { const d = new Date(ms + PK); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
export const fromInput = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - PK : null; };
export const todayYmd = () => new Date(Date.now() + PK).toISOString().slice(0, 10);

// ---- API ----
export class ApiError extends Error { constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; } }
let onAuthLost = () => {};
export const setAuthLostHandler = (f) => { onAuthLost = f; };

export async function api(method, path, body, { sign = false } = {}) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers = { 'x-requested-with': 'ytm', 'content-type': 'application/json' };
  if (sign) Object.assign(headers, await signHeaders(method, path, text ?? '{}'));
  let res;
  try { res = await fetch(path, { method, headers, body: method === 'GET' ? undefined : (text ?? '{}'), credentials: 'same-origin' }); }
  catch { throw new ApiError(0, 'offline', "Can't reach the server. Nothing was saved. Check your internet and try again."); }
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) {
    const e = data?.error || {};
    if (res.status === 401 && e.code === 'not_logged_in') onAuthLost();
    throw new ApiError(res.status, e.code || 'error', e.message || 'Something went wrong. Nothing was saved.', e.details);
  }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b, o) => api('POST', p, b ?? {}, o);

// ---- device key (ECDSA P-256, non-extractable, kept in IndexedDB) ----
const DB_NAME = 'ytm-device', STORE = 'keys';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const q = db.transaction(STORE).objectStore(STORE).get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbPut(k, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const sha256Hex = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

export async function localDevice(userId) { try { return await idbGet('device:' + userId); } catch { return null; } }
export async function createLocalDevice(userId) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const j = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: j.x, y: j.y };
  const fp = await sha256Hex(`P-256|${jwk.x}|${jwk.y}`);
  const rec = { privateKey: pair.privateKey, jwk, fp };
  await idbPut('device:' + userId, rec);
  return rec;
}
let currentUserId = null;
export const setCurrentUser = (id) => { currentUserId = id; };
async function signHeaders(method, path, bodyText) {
  const dev = await localDevice(currentUserId);
  if (!dev) throw new ApiError(0, 'no_local_device', 'This computer is not set up yet. Use "Set up this computer" first.');
  const { nonce } = await get('/api/challenge');
  const msg = `${nonce}.${method}.${path}.${await sha256Hex(bodyText)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.privateKey, new TextEncoder().encode(msg));
  return { 'x-nonce': nonce, 'x-sig': b64u(sig) };
}

// ---- small UI pieces ----
let liveEl;
export function announce(msg, kind = 'ok') {
  liveEl ||= $('#live');
  liveEl.className = 'toast ' + kind; liveEl.textContent = msg; liveEl.hidden = false;
  clearTimeout(announce.t); announce.t = setTimeout(() => { liveEl.hidden = true; }, kind === 'err' ? 9000 : 4000);
}
export function busy(btn, fn) {
  return async (...a) => {
    if (btn.disabled) return;
    btn.disabled = true; const old = btn.textContent; btn.setAttribute('aria-busy', 'true');
    try { return await fn(...a); } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = old; }
  };
}
export const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input, hint && h('span', { class: 'hint' }, hint));
export function dialog(title, bodyEl, actions) {
  const dlg = h('dialog', { class: 'dlg', 'aria-label': title }, h('h2', {}, title), bodyEl, h('div', { class: 'row end' }, actions(() => dlg.close())));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
  return dlg;
}
export const chip = (text, kind = '') => h('span', { class: 'chip ' + kind }, text);
export const empty = (t) => h('p', { class: 'empty' }, t);
export function errBox(e) { return h('div', { class: 'errbox', role: 'alert' }, e.message || String(e)); }
export const uid = () => crypto.randomUUID();
export const draft = {
  get(k) { try { return JSON.parse(localStorage.getItem('ytm-draft:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('ytm-draft:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('ytm-draft:' + k); } catch {} },
};

// Sync runs a few pages per request (free-tier CPU limit). Keep asking until the server says it is done.
export async function syncUntilDone(onProgress) {
  for (let i = 0; i < 40; i++) {
    const r = await post('/api/admin/clickup/sync');
    if (!r.ok) return r;
    if (r.done || r.skipped) return { ...r, done: true };
    onProgress?.(r.page);
  }
  return { ok: false, error: 'Still working. Press Sync now again in a minute.' };
}

const CHECK_TEXT = {
  not_a_doc: 'This link is not a Google Doc, so it could not be checked.',
  clickup: 'ClickUp could not be read. Reconnect ClickUp in Settings.',
  private: 'The Google Doc is private. Set sharing to "Anyone with the link can view", then press Re-check.',
  not_found: 'That Google Doc was not found.',
  unreachable: 'Google did not answer. Press Re-check in a minute.',
};
// Shows the script-check result for a deposit (rows come from the server as check_json or an object).
export function checkView(check, depositId, onChange, path) {
  if (!check) return null;
  const c = typeof check === 'string' ? JSON.parse(check) : check;
  const box = h('div', { class: 'checkbox' });
  if (c.status !== 'ok') box.append(h('div', { class: 'warnbox' }, CHECK_TEXT[c.status] || 'The script could not be checked.'));
  else {
    box.append(h('div', {}, h('strong', {}, c.passed ? 'Script check: passed ✓' : `Script check: ${c.items.filter((i) => !i.ok).length} item(s) missing`)));
    box.append(h('ul', { class: 'checklist' }, c.items.map((i) => h('li', { class: i.ok ? 'ok' : 'bad' }, `${i.ok ? '✓' : '✗'} ${i.label} — ${i.have} of ${i.need}`))));
  }
  if (depositId && onChange) {
    const b = h('button', { class: 'btn small', type: 'button' }, 'Re-check');
    b.addEventListener('click', busy(b, async () => { try { await post(path || `/api/deposits/${depositId}/recheck`); announce('Checked again'); onChange(); } catch (e) { announce(e.message, 'err'); } }));
    box.append(b);
  }
  return box;
}

// "Finished work checks" block: latest script/title checks (own for employees, team for managers).
export async function checksSection(title, onChange) {
  const card = h('section', { class: 'card' }, h('h2', {}, title));
  let r; try { r = await get('/api/checks?days=30'); } catch (e) { card.append(errBox(e)); return card; }
  if (!r.checks.length) { card.append(empty('Nothing checked yet. It runs when a task reaches a Finished status (for example "ready to edit").')); return card; }
  card.append(h('p', { class: 'muted' }, 'Checked automatically from the ClickUp task description and the linked Google Doc.'));
  for (const c of r.checks) {
    card.append(h('div', { class: 'item col' },
      h('div', {}, h('strong', {}, c.employee), c.job_role ? ` (${c.job_role})` : '', ' · ', h('a', { href: c.task_url || '#', target: '_blank', rel: 'noopener noreferrer' }, c.task_name || c.task_id), ' ', h('span', { class: 'muted' }, fmtDateTime(c.checked_at))),
      checkView(c.result, c.task_id, onChange, `/api/tasks/${encodeURIComponent(c.task_id)}/recheck`)));
  }
  return card;
}
