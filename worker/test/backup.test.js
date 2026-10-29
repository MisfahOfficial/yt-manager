import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { setupTeam, makeEmployee, approve, giveShift, rid } from './helpers.js';
import { cronBackup } from '../src/backup.js';
import { toCsv } from '../src/export.js';
import { localMidnightMs } from '../src/lib/time.js';

const H = 3600000, DAY = 24 * H;
const T0 = localMidnightMs('2026-12-14') + 10 * H;
let admin, ann, mgr;

const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
async function openFile(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe('YTMB1\n');
  let o = 6; const frames = [];
  while (o < bytes.length) { const n = dv.getUint32(o); o += 4; frames.push(bytes.slice(o, o + n)); o += n; }
  const manifest = JSON.parse(new TextDecoder().decode(frames[0]));
  const key = await crypto.subtle.importKey('raw', unhex(env.ENCRYPTION_KEY), 'AES-GCM', false, ['decrypt']);
  const tables = {};
  for (const f of frames.slice(1)) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: f.slice(0, 12) }, key, f.slice(12));
    const txt = await new Response(new Blob([pt]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    for (const [t, rows] of Object.entries(JSON.parse(txt))) (tables[t] ||= []).push(...rows);
  }
  return { manifest, tables };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0);
  admin = await setupTeam();
  mgr = await makeEmployee(admin, 'Bk Mgr', { role: 'manager' });
  ann = await makeEmployee(admin, '=HYPERLINK("http://evil.example","x"),Ann', { job_role: 'Editor' });
  await approve(admin, ann); await giveShift(admin, ann.id, { start: 0, end: 1439, days: 127 });
  await ann.post('/api/checkin', { request_id: rid() }, { sign: true });
  await ann.post('/api/progress', { request_id: rid(), taskless_reason: 'Backup test', link: 'https://drive.example.com/x', completed: 'Did "quoted", comma\nnewline work' });
  vi.setSystemTime(T0 + 3 * H);
  await ann.post('/api/checkout', { request_id: rid() }, { sign: true });
});
afterAll(() => vi.useRealTimers());

describe('encrypted backups', () => {
  it('only the Owner can list, run, download or export', async () => {
    for (const c of [ann, mgr]) {
      expect((await c.get('/api/admin/backups')).status).toBe(403);
      expect((await c.post('/api/admin/backups/run')).status).toBe(403);
      expect((await c.get('/api/admin/backups/2026-12-14')).status).toBe(403);
      expect((await c.get('/api/admin/export/attendance')).status).toBe(403);
    }
  });
  it('"Back up now" produces an encrypted backup that decrypts to the real data and leaves out sessions and login logs', async () => {
    let r; for (let i = 0; i < 10; i++) { r = (await admin.post('/api/admin/backups/run')).data; if (r.done) break; }
    expect(r.done).toBe(true);
    const list = (await admin.get('/api/admin/backups')).data;
    expect(list.backups).toHaveLength(1);
    expect(list.backups[0]).toMatchObject({ date: '2026-12-14' });
    expect(list.running).toBeNull();
    const res = await (await import('cloudflare:test')).SELF.fetch('https://ytm.test/api/admin/backups/2026-12-14', { headers: { cookie: admin.cookie, 'cf-connecting-ip': '203.0.113.7' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('ytm-backup-2026-12-14.ytmb');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const raw = new TextDecoder('latin1').decode(bytes);
    for (const secret of ['owner@x.test', 'pw_hash', 'Backup test', 'CREATE TABLE']) expect(raw).not.toContain(secret); // ciphertext only
    const { manifest, tables } = await openFile(bytes);
    expect(manifest.tables.employees).toBeGreaterThan(2);
    expect(tables.employees.map((e) => e.email)).toContain('owner@x.test');
    expect(tables.employees[0].pw_hash).toMatch(/^[0-9a-f]{64}$/);          // restore needs the hashes (they stay encrypted inside the file)
    expect(tables.deposits.some((d) => d.completed.includes('quoted'))).toBe(true);
    for (const t of ['sessions', 'nonces', 'login_attempts', 'idempotency']) expect(tables[t]).toBeUndefined();
    const live = (await env.DB.prepare('SELECT (SELECT COUNT(*) FROM employees) e,(SELECT COUNT(*) FROM attendance) a,(SELECT COUNT(*) FROM audit_log) l').first());
    expect(tables.employees.length).toBe(live.e); expect(tables.attendance.length).toBe(live.a);
  });
  it('a wrong key cannot open it', async () => {
    const res = await (await import('cloudflare:test')).SELF.fetch('https://ytm.test/api/admin/backups/2026-12-14', { headers: { cookie: admin.cookie, 'cf-connecting-ip': '1.1.1.1' } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const dv = new DataView(bytes.buffer); let o = 6; const n0 = dv.getUint32(o); o += 4 + n0; const n1 = dv.getUint32(o); o += 4; const part = bytes.slice(o, o + n1);
    const wrong = await crypto.subtle.importKey('raw', unhex('11'.repeat(32)), 'AES-GCM', false, ['decrypt']);
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv: part.slice(0, 12) }, wrong, part.slice(12))).rejects.toBeTruthy();
  });
  it('bad or unknown dates are refused cleanly', async () => {
    expect((await admin.get('/api/admin/backups/1999-01-01')).status).toBe(404);
    expect((await admin.get('/api/admin/backups/not-a-date')).status).toBe(400);
  });
  it('the weekly cron makes one backup, then waits a week, and a large table is split into parts', async () => {
    await env.BACKUPS.delete('bkm:2026-12-14');
    vi.setSystemTime(T0 + DAY);
    for (let i = 0; i < 4; i++) await cronBackup(env, Date.now());
    let l = (await admin.get('/api/admin/backups')).data; expect(l.backups).toHaveLength(1); expect(l.backups[0].date).toBe('2026-12-15');
    vi.setSystemTime(T0 + 3 * DAY); for (let i = 0; i < 4; i++) await cronBackup(env, Date.now());
    expect((await admin.get('/api/admin/backups')).data.backups).toHaveLength(1);        // not again within a week
    vi.setSystemTime(T0 + 9 * DAY); for (let i = 0; i < 4; i++) await cronBackup(env, Date.now());
    expect((await admin.get('/api/admin/backups')).data.backups).toHaveLength(2);
    // many rows: split into several small parts so one step never does too much work
    const ins = env.DB.prepare('INSERT INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,to_val) VALUES (?,?,?,?,?,?,?)');
    for (let b = 0; b < 4; b++) await env.DB.batch(Array.from({ length: 1000 }, (_, i) => ins.bind(`bulk-${b}-${i}`, 'BULK', 'status', 1 + i, 1, 'webhook', 's')));
    vi.setSystemTime(T0 + 20 * DAY);
    await admin.post('/api/admin/backups/run');
    for (let i = 0; i < 6; i++) { const r = (await admin.post('/api/admin/backups/run')).data; if (r.done) break; }
    const m = (await admin.get('/api/admin/backups')).data.backups[0];
    expect(m.rows).toBeGreaterThan(4000);
    const file = new Uint8Array(await (await (await import('cloudflare:test')).SELF.fetch(`https://ytm.test/api/admin/backups/${m.date}`, { headers: { cookie: admin.cookie, 'cf-connecting-ip': '1.1.1.1' } })).arrayBuffer());
    const { manifest, tables } = await openFile(file);
    expect(manifest.parts.length).toBeGreaterThan(1);
    expect(tables.task_events.filter((e) => e.task_id === 'BULK').length).toBe(4000);
  });
});

describe('spreadsheet exports', () => {
  it('attendance, work updates and monthly summary download as CSV with a spreadsheet-safe format', async () => {
    const a = await admin.get('/api/admin/export/attendance?year=2026');
    expect(a.status).toBe(200);
    expect(a.data).toContain('Clock in');
    const raw = new Uint8Array(await (await (await import('cloudflare:test')).SELF.fetch('https://ytm.test/api/admin/export/attendance?year=2026', { headers: { cookie: admin.cookie, 'cf-connecting-ip': '1.1.1.1' } })).arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM so Excel/Sheets show names correctly
    expect(a.data).toContain('3');           // 3 hours on site
    const u = (await admin.get('/api/admin/export/updates?year=2026')).data;
    expect(u).toContain('"Did ""quoted"", comma\nnewline work"');   // quotes, commas and newlines escaped
    const m = (await admin.get('/api/admin/export/monthly?year=2026')).data;
    expect(m).toContain('2026-12');
    expect((await admin.get('/api/admin/export/nope')).status).toBe(400);
    expect((await admin.get('/api/admin/export/attendance?year=abc')).status).toBe(400);
  });
  it('formula-looking cells are neutralised (CSV injection)', async () => {
    const csv = toCsv(['a'], [['=HYPERLINK("http://evil.example")'], ['+1+1'], ['-2'], ['@SUM(1)'], ['normal']]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+1+1"); expect(csv).toContain("'-2"); expect(csv).toContain("'@SUM"); expect(csv).toContain('normal');
    const a = (await admin.get('/api/admin/export/attendance?year=2026')).data;
    expect(a).toContain("'=HYPERLINK");     // the person's name starting with = is neutralised
    expect(a).not.toMatch(/(^|,)=HYPERLINK/m);
  });
  it('every download is recorded in the audit history', async () => {
    const acts = (await env.DB.prepare("SELECT action FROM audit_log WHERE action IN ('backup_run','backup_downloaded','export_downloaded')").all()).results.map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(['backup_run', 'backup_downloaded', 'export_downloaded']));
  });
});
