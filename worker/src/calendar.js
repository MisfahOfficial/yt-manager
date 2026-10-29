import { HttpError, bad, forbidden, json, str, int, auditStmt } from './http.js';
import { statusMap } from './engine.js';
import { classify } from './lib/timer.js';
import { calStatus, CAL } from './lib/calendar.js';
import { channelOf, isAutomation, firstToken } from './lib/titles.js';
import { addDays, localDate, localMidnightMs, dow, weekStart, isYmd } from './lib/time.js';

export const loadChannels = async (db, activeOnly = true) =>
  new Map((await db.prepare(`SELECT code,name,color,sort,active FROM channels ${activeOnly ? 'WHERE active=1' : ''} ORDER BY sort,code`).all()).results.map((c) => [c.code, c]));

export async function listChannels(ctx) {
  const ch = [...(await loadChannels(ctx.env.DB, false)).values()];
  const counts = new Map();
  for (const t of (await ctx.env.DB.prepare('SELECT name FROM tasks WHERE deleted=0').all()).results) { const k = firstToken(t.name); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
  const known = new Set(ch.map((c) => c.code));
  const unknown = [...counts.entries()].filter(([k, n]) => !known.has(k) && n >= 2 && /\d|^[A-Z]{4,}$/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([code, n]) => ({ code, tasks: n }));
  return json({ channels: ch.map((c) => ({ ...c, tasks: counts.get(c.code) || 0 })), suggestions: unknown });
}

export async function saveChannels(ctx) {
  const { env, body, emp, now } = ctx;
  if (!Array.isArray(body.channels) || body.channels.length > 40) throw bad('bad_channels', 'Channel list is not valid.');
  const seen = new Set();
  const rows = body.channels.map((c, i) => {
    const code = str(c.code, 'code', { max: 12 }).toUpperCase();
    if (!/^[A-Z][A-Z0-9]*$/.test(code)) throw bad('bad_code', 'A channel code uses letters and numbers only, like V1 or SS1.');
    if (seen.has(code)) throw bad('dup_code', `${code} is listed twice.`);
    seen.add(code);
    const color = /^#[0-9a-fA-F]{6}$/.test(c.color || '') ? c.color : '#6c93ff';
    return { code, name: str(c.name || code, 'name', { max: 60 }), color, sort: i + 1, active: c.active === false ? 0 : 1 };
  });
  const before = [...(await loadChannels(env.DB, false)).values()];
  const stmts = [env.DB.prepare('UPDATE channels SET active=0')];
  for (const r of rows) stmts.push(env.DB.prepare('INSERT INTO channels(code,name,color,sort,active) VALUES (?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,color=excluded.color,sort=excluded.sort,active=excluded.active').bind(r.code, r.name, r.color, r.sort, r.active));
  stmts.push(auditStmt(env.DB, { at: now, actor: emp.id, action: 'channels_saved', entity: 'settings', before: before.map((c) => c.code), after: rows.map((c) => c.code) }));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

export async function listCategories(ctx) {
  return json({ categories: (await ctx.env.DB.prepare('SELECT id,name,job_role,tag,active FROM work_categories ORDER BY id').all()).results });
}
export async function saveCategories(ctx) {
  const { env, body, emp, now } = ctx;
  if (!Array.isArray(body.categories) || body.categories.length > 30) throw bad('bad_categories', 'Category list is not valid.');
  const rows = body.categories.map((c) => ({ name: str(c.name, 'name', { max: 60 }), job_role: str(c.job_role, 'job', { optional: true, max: 40 }), tag: str(c.tag, 'tag', { optional: true, max: 40 }), active: c.active === false ? 0 : 1 }));
  const stmts = [env.DB.prepare('DELETE FROM work_categories')];
  for (const r of rows) stmts.push(env.DB.prepare('INSERT INTO work_categories(name,job_role,tag,active) VALUES (?,?,?,?)').bind(r.name, r.job_role, r.tag, r.active));
  stmts.push(auditStmt(env.DB, { at: now, actor: emp.id, action: 'categories_saved', entity: 'settings', after: rows.map((r) => r.name) }));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

// GET /api/calendar?week=YYYY-MM-DD : videos by channel and day, straight from ClickUp tasks. Read-only.
export async function calendar(ctx) {
  const { env, url, now } = ctx;
  let ws = url.searchParams.get('week');
  if (ws && !isYmd(ws)) throw bad('bad_week', 'Week must be a date.');
  ws = weekStart(ws || localDate(now));
  const from = localMidnightMs(ws), to = localMidnightMs(addDays(ws, 7));
  const today0 = localMidnightMs(localDate(now));
  const channels = await loadChannels(env.DB);
  const map = await statusMap(env.DB);
  const nameOf = new Map((await env.DB.prepare('SELECT clickup_user_id id,name FROM employees WHERE clickup_user_id IS NOT NULL').all()).results.map((r) => [r.id, r.name]));
  const asg = new Map();
  for (const a of (await env.DB.prepare('SELECT task_id,clickup_user_id FROM task_assignees WHERE end_ms IS NULL').all()).results) { if (!asg.has(a.task_id)) asg.set(a.task_id, []); asg.get(a.task_id).push(nameOf.get(a.clickup_user_id) || 'Someone'); }
  const shape = (t) => ({ id: t.id, name: t.name, url: t.url, status: t.status, cal: calStatus(t.status, classify(t.status, map), t.due_ms, today0), automation: isAutomation(t.name), assignees: asg.get(t.id) || [], day: t.due_ms ? localDate(t.due_ms) : null });
  const weekTasks = (await env.DB.prepare('SELECT id,name,url,status,due_ms FROM tasks WHERE deleted=0 AND due_ms>=? AND due_ms<? ORDER BY due_ms,name').bind(from, to).all()).results;
  const open = (await env.DB.prepare('SELECT id,name,url,status,due_ms FROM tasks WHERE deleted=0 AND due_ms IS NULL ORDER BY first_seen_ms DESC LIMIT 300').all()).results
    .map(shape).filter((x) => channels.has(firstToken(x.name)) && !['Uploaded'].includes(x.cal)).slice(0, 40);
  const groups = new Map([...channels.values()].map((c) => [c.code, { code: c.code, name: c.name, color: c.color, items: [] }]));
  const noChannel = { code: '', name: 'No channel', color: '#9aa3af', items: [] };
  for (const t of weekTasks) { const c = channelOf(t.name, channels); (c ? groups.get(c.code) : noChannel).items.push(shape(t)); }
  const rows = [...groups.values()].filter((g) => g.items.length);
  if (noChannel.items.length) rows.push(noChannel);
  const counts = Object.fromEntries(CAL.map((k) => [k, 0]));
  for (const g of rows) for (const i of g.items) counts[i.cal]++;
  return json({ week_start: ws, days: Array.from({ length: 7 }, (_, i) => addDays(ws, i)), today: localDate(now), channels: rows, unscheduled: open, counts });
}
