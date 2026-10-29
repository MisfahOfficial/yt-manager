#!/usr/bin/env node
// Turns a downloaded backup file (.ytmb) into SQL you can load into a NEW empty database.
//   ENCRYPTION_KEY=<your 64-hex key> node scripts/restore-from-backup.mjs ytm-backup-2026-12-14.ytmb > restore.sql
// Then (never on the live database):
//   cd worker && npx wrangler d1 create ytm-restore
//   npx wrangler d1 migrations apply ytm-restore --remote   (with that database in wrangler config)
//   npx wrangler d1 execute ytm-restore --remote --file ../restore.sql
import { readFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const [file] = process.argv.slice(2);
const KEY = process.env.ENCRYPTION_KEY;
if (!file || !/^[0-9a-f]{64}$/i.test(KEY || '')) { console.error('Usage: ENCRYPTION_KEY=<64 hex> node restore-from-backup.mjs <file.ytmb> > restore.sql'); process.exit(1); }
const buf = readFileSync(file);
if (buf.subarray(0, 6).toString() !== 'YTMB1\n') { console.error('Not a YT Manager backup file'); process.exit(1); }
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let o = 6; const frames = [];
while (o < buf.length) { const n = dv.getUint32(o); o += 4; frames.push(buf.subarray(o, o + n)); o += n; }
const manifest = JSON.parse(frames[0].toString());
const key = await crypto.subtle.importKey('raw', Buffer.from(KEY, 'hex'), 'AES-GCM', false, ['decrypt']);
const tables = {};
for (const f of frames.slice(1)) {
  let pt; try { pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: f.subarray(0, 12) }, key, f.subarray(12)); } catch { console.error('Wrong key or damaged file'); process.exit(2); }
  for (const [t, rows] of Object.entries(JSON.parse(gunzipSync(Buffer.from(pt)).toString()))) (tables[t] ||= []).push(...rows);
}
const ORDER = ['employees', 'shifts', 'employee_shifts', 'leave', 'overtime', 'devices', 'settings', 'channels', 'work_categories', 'network_exceptions', 'attendance', 'deposits', 'tasks', 'task_assignees', 'task_events', 'gaps', 'active_choices', 'task_sessions', 'revisions', 'sync_state', 'secrets_store', 'audit_log', 'report_snapshots', 'legacy_records', 'correction_requests', 'task_checks'];
const names = [...ORDER.filter((t) => tables[t]), ...Object.keys(tables).filter((t) => !ORDER.includes(t))];
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
const out = [`-- restored from backup ${manifest.date}`];
for (const t of names) for (const r of tables[t]) { const c = Object.keys(r); out.push(`INSERT OR REPLACE INTO "${t}" (${c.map((x) => `"${x}"`).join(',')}) VALUES (${c.map((x) => q(r[x])).join(',')});`); }
process.stdout.write(out.join('\n') + '\n');
console.error(`Decoded ${names.length} tables, ${out.length - 1} rows from backup ${manifest.date}.`);
