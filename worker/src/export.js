// Spreadsheet exports (CSV opens directly in Google Sheets / Excel). Owner only.
import { bad, audit, int } from './http.js';
import { localDate, localMidnightMs, PK_OFFSET_MS } from './lib/time.js';
import { channelOf, firstToken } from './lib/titles.js';
import { loadChannels } from './calendar.js';

// CSV-injection guard: a cell that starts with = + - @ or a control char is prefixed with an apostrophe so a spreadsheet never runs it as a formula.
const cell = (v) => {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const toCsv = (header, rows) => '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
const fmt = (ms) => (ms == null ? '' : new Date(ms + PK_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16));
const hours = (ms) => (Math.round((ms / 3600000) * 100) / 100).toString();

export async function exportCsv(ctx) {
  const { env, params, url, emp, now } = ctx;
  const year = int(url.searchParams.get('year') || localDate(now).slice(0, 4), 'year', { min: 2020, max: 2100 });
  const from = localMidnightMs(`${year}-01-01`), to = localMidnightMs(`${year + 1}-01-01`);
  const db = env.DB;
  let name, csv;
  if (params.what === 'attendance') {
    const rows = (await db.prepare('SELECT a.check_in_at,a.check_out_at,a.status,a.corrected,a.checkout_exception,e.name,e.job_role FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.check_in_at>=? AND a.check_in_at<? ORDER BY a.check_in_at LIMIT 50000').bind(from, to).all()).results;
    csv = toCsv(['Date', 'Person', 'Job', 'Clock in', 'Clock out', 'Hours on site', 'Status', 'Corrected', 'Technical exception'],
      rows.map((r) => [localDate(r.check_in_at), r.name, r.job_role, fmt(r.check_in_at), fmt(r.check_out_at), r.check_out_at ? hours(r.check_out_at - r.check_in_at) : '', r.status, r.corrected ? 'yes' : '', r.checkout_exception || '']));
    name = `attendance-${year}`;
  } else if (params.what === 'updates') {
    const ch = await loadChannels(db, false);
    const rows = (await db.prepare('SELECT d.created_at,d.link,d.completed,d.pending,d.review_note,d.taskless_reason,e.name person,e.job_role,t.name task FROM deposits d JOIN employees e ON e.id=d.employee_id LEFT JOIN tasks t ON t.id=d.task_id WHERE d.created_at>=? AND d.created_at<? ORDER BY d.created_at LIMIT 50000').bind(from, to).all()).results;
    csv = toCsv(['Date', 'Time', 'Person', 'Job', 'Channel', 'Task', 'What was done', 'Pending', 'Link', 'Manager note'],
      rows.map((r) => [localDate(r.created_at), fmt(r.created_at).slice(11), r.person, r.job_role, channelOf(r.task, ch)?.name || '', r.task || r.taskless_reason || '', r.completed, r.pending, r.link, r.review_note]));
    name = `work-updates-${year}`;
  } else if (params.what === 'monthly') {
    // light SQL summary per month and person (exact counts from source records; no heavy report engine needed)
    const att = (await db.prepare('SELECT a.employee_id,a.check_in_at,a.check_out_at FROM attendance a WHERE a.check_in_at>=? AND a.check_in_at<? AND a.check_out_at IS NOT NULL').bind(from, to).all()).results;
    const dep = (await db.prepare('SELECT employee_id,created_at FROM deposits WHERE created_at>=? AND created_at<?').bind(from, to).all()).results;
    const ses = (await db.prepare('SELECT employee_id,kind,start_ms,end_ms FROM task_sessions WHERE start_ms>=? AND start_ms<? AND end_ms IS NOT NULL').bind(from, to).all()).results;
    const emps = (await db.prepare('SELECT id,name,job_role,clickup_user_id FROM employees').all()).results;
    const made = (await db.prepare('SELECT creator_id,created_ms FROM tasks WHERE created_ms>=? AND created_ms<? AND deleted=0 AND creator_id IS NOT NULL').bind(from, to).all()).results;
    const key = (ms) => localDate(ms).slice(0, 7);
    const agg = new Map();
    const get = (id, m) => { const k = id + '|' + m; if (!agg.has(k)) agg.set(k, { days: new Set(), site: 0, upd: 0, orig: 0, rev: 0, made: 0 }); return agg.get(k); };
    for (const a of att) { const g = get(a.employee_id, key(a.check_in_at)); g.days.add(localDate(a.check_in_at)); g.site += a.check_out_at - a.check_in_at; }
    for (const d of dep) get(d.employee_id, key(d.created_at)).upd++;
    for (const s of ses) { const g = get(s.employee_id, key(s.start_ms)); if (s.kind === 'revision') g.rev += s.end_ms - s.start_ms; else g.orig += s.end_ms - s.start_ms; }
    const byCu = new Map(emps.filter((e) => e.clickup_user_id).map((e) => [e.clickup_user_id, e.id]));
    for (const t of made) { const id = byCu.get(t.creator_id); if (id) get(id, key(t.created_ms)).made++; }
    const nm = new Map(emps.map((e) => [e.id, e]));
    const rows = [...agg.entries()].map(([k, g]) => { const [id, m] = k.split('|'); const e = nm.get(id) || {}; return [m, e.name || id, e.job_role || '', g.days.size, hours(g.site), g.upd, hours(g.orig), hours(g.rev), g.made]; }).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    csv = toCsv(['Month', 'Person', 'Job', 'Days present', 'Hours on site', 'Work updates', 'Recorded task hours (original)', 'Recorded task hours (revision)', 'Tasks created'], rows);
    name = `monthly-summary-${year}`;
  } else throw bad('unknown_export', 'Unknown export.');
  await audit(env.DB, { at: now, actor: emp.id, action: 'export_downloaded', entity: 'export', entityId: name });
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
