// Automatic encrypted backups kept in Workers KV (free, same Cloudflare account) + owner downloads and CSV exports.
// A backup is split into small "parts" so every request/cron tick stays far below the free 10 ms CPU limit.
import { HttpError, bad, notFound, json, int, audit, getSetting } from './http.js';
import { unhex, hex } from './lib/crypto.js';
import { localDate } from './lib/time.js';

const SKIP = new Set(['sessions', 'nonces', 'login_attempts', 'idempotency', 'sqlite_sequence']);
const PART_ROWS = 3000;           // row budget per step
const WEEK = 7 * 86400000;
const enc = new TextEncoder();

async function gzip(bytes) { const cs = new CompressionStream('gzip'); const w = cs.writable.getWriter(); w.write(bytes); w.close(); return new Uint8Array(await new Response(cs.readable).arrayBuffer()); }
async function aesKey(keyHex) { return crypto.subtle.importKey('raw', unhex(keyHex), 'AES-GCM', false, ['encrypt']); }
async function seal(keyHex, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyHex), bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
}

async function listTables(db) {
  return (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all()).results.map((r) => r.name).filter((n) => !SKIP.has(n));
}

// Starts a run if none is in progress and the last finished backup is older than a week (or force).
export async function startRun(env, now, { force = false } = {}) {
  const cur = await env.BACKUPS.get('bk:current', 'json');
  if (cur) return cur;
  if (!force) {
    const last = await lastBackupAt(env);
    if (last && now - last < WEEK) return null;
  }
  const db = env.DB;
  const queue = [];
  for (const t of await listTables(db)) {
    const n = (await db.prepare(`SELECT COUNT(*) n FROM "${t}"`).first()).n;
    for (let off = 0; off < Math.max(n, 1); off += PART_ROWS) queue.push({ t, off, n });
  }
  const run = { date: localDate(now), started: now, queue, parts: [], tables: Object.fromEntries(queue.map((q) => [q.t, q.n])) };
  await env.BACKUPS.put('bk:current', JSON.stringify(run));
  return run;
}

// Does a small slice of work. Returns { done, remaining }.
export async function stepRun(env, now) {
  const run = await env.BACKUPS.get('bk:current', 'json');
  if (!run) return { done: true, remaining: 0, idle: true };
  const db = env.DB;
  const part = {}; let rows = 0;
  while (run.queue.length && rows < PART_ROWS) {
    const q = run.queue[0];
    const data = (await db.prepare(`SELECT * FROM "${q.t}" ORDER BY rowid LIMIT ? OFFSET ?`).bind(PART_ROWS, q.off).all()).results;
    (part[q.t] ||= []).push(...data); rows += data.length; run.queue.shift();
  }
  if (rows || Object.keys(part).length) {
    const name = `bk:${run.date}:p${run.parts.length}`;
    const bytes = await seal(env.ENCRYPTION_KEY, await gzip(enc.encode(JSON.stringify(part))));
    await env.BACKUPS.put(name, bytes);
    run.parts.push({ key: name, tables: Object.keys(part), rows, bytes: bytes.length });
  }
  if (run.queue.length) { await env.BACKUPS.put('bk:current', JSON.stringify(run)); return { done: false, remaining: run.queue.length }; }
  const manifest = { date: run.date, started: run.started, finished: now, tables: run.tables, parts: run.parts, version: 1 };
  await env.BACKUPS.put('bkm:' + run.date, JSON.stringify(manifest));
  await env.BACKUPS.delete('bk:current');
  return { done: true, remaining: 0, manifest };
}

async function lastBackupAt(env) {
  const l = await env.BACKUPS.list({ prefix: 'bkm:' });
  if (!l.keys.length) return 0;
  const newest = l.keys.map((k) => k.name).sort().pop();
  const m = await env.BACKUPS.get(newest, 'json');
  return m?.finished || 0;
}

// cron: weekly automatic backup; each tick does one small step
export async function cronBackup(env, now) {
  if (!env.BACKUPS || !env.ENCRYPTION_KEY) return;
  await startRun(env, now);
  await stepRun(env, now);
}

export async function listBackups(ctx) {
  const l = await ctx.env.BACKUPS.list({ prefix: 'bkm:' });
  const out = [];
  for (const k of l.keys.sort((a, b) => b.name.localeCompare(a.name))) { const m = await ctx.env.BACKUPS.get(k.name, 'json'); if (m) out.push({ date: m.date, finished: m.finished, tables: Object.keys(m.tables).length, rows: m.parts.reduce((n, p) => n + p.rows, 0), bytes: m.parts.reduce((n, p) => n + p.bytes, 0) }); }
  const cur = await ctx.env.BACKUPS.get('bk:current', 'json');
  return json({ backups: out, running: cur ? { date: cur.date, remaining: cur.queue.length } : null, newest_age_days: out.length ? Math.floor((ctx.now - out[0].finished) / 86400000) : null });
}

export async function runBackupNow(ctx) {
  const { env, now, emp } = ctx;
  const run = await startRun(env, now, { force: true });
  let r = { done: false, remaining: run.queue.length };
  for (let i = 0; i < 3 && !r.done; i++) r = await stepRun(env, now);
  if (r.done) await audit(env.DB, { at: now, actor: emp.id, action: 'backup_run', entity: 'backup', entityId: run.date });
  return json({ ok: true, done: r.done, remaining: r.remaining });
}

// One file with the manifest plus every encrypted part, so it can be saved to Drive and restored later with scripts/decrypt-backup.mjs
export async function downloadBackup(ctx) {
  const { env, params, emp, now } = ctx;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) throw bad('bad_date', 'Not a backup date.');
  const m = await env.BACKUPS.get('bkm:' + params.date, 'json');
  if (!m) throw notFound('No backup for that date.');
  const chunks = [enc.encode('YTMB1\n')];
  const frame = (b) => { const h = new Uint8Array(4); new DataView(h.buffer).setUint32(0, b.length); chunks.push(h, b); };
  frame(enc.encode(JSON.stringify(m)));
  for (const p of m.parts) { const v = await env.BACKUPS.get(p.key, 'arrayBuffer'); if (!v) throw new HttpError(500, 'backup_part_missing', 'A part of that backup is missing.'); frame(new Uint8Array(v)); }
  await audit(env.DB, { at: now, actor: emp.id, action: 'backup_downloaded', entity: 'backup', entityId: params.date });
  const total = chunks.reduce((n, c) => n + c.length, 0); const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return new Response(out, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="ytm-backup-${params.date}.ytmb"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
