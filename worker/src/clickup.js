import { HttpError, bad, forbidden, json, str, int, audit, auditStmt, getSetting, setSettingStmt } from './http.js';
import { hmacHex, timingSafeEqual, encryptSecret, decryptSecret, randomToken, sha256Hex } from './lib/crypto.js';
import { rebuildForTask, statusMap } from './engine.js';
import { classify } from './lib/timer.js';
import { localDate, localMinutes } from './lib/time.js';

const API = 'https://api.clickup.com/api/v2';
const WANTED_EVENTS = ['taskStatusUpdated', 'taskAssigneeUpdated', 'taskDueDateUpdated', 'taskDeleted', 'taskCreated'];

export class RateLimited extends Error { constructor(resetMs) { super('rate_limited'); this.resetMs = resetMs; } }
export class AuthRevoked extends Error { constructor() { super('clickup_auth_revoked'); } }

async function getSecret(env, key) {
  const r = await env.DB.prepare('SELECT value FROM secrets_store WHERE key=?').bind(key).first();
  if (!r) return null;
  return decryptSecret(env.ENCRYPTION_KEY, r.value);
}
async function putSecret(env, key, val) {
  const blob = await encryptSecret(env.ENCRYPTION_KEY, val);
  await env.DB.prepare('INSERT INTO secrets_store(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, blob).run();
}
export const getToken = async (env) => env.CLICKUP_TOKEN || (await getSecret(env, 'clickup_token'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function cu(env, path, { method = 'GET', body, retries = 2 } = {}) {
  const token = await getToken(env);
  if (!token) throw new Error('clickup_not_connected');
  for (let i = 0; ; i++) {
    const res = await (env.CLICKUP_FETCH || fetch)(API + path, {
      method, headers: { Authorization: token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) throw new AuthRevoked();
    if (res.status === 429) throw new RateLimited(Number(res.headers.get('x-ratelimit-reset') || 0) * 1000);
    if (res.status >= 500 && i < retries) { await sleep(400 * (i + 1)); continue; }
    if (!res.ok) { const e = new Error(`clickup_${res.status}`); e.status = res.status; throw e; }
    return res.status === 204 ? {} : res.json();
  }
}
export const writeClickUpStatus = (env, taskId, status) => cu(env, `/task/${encodeURIComponent(taskId)}`, { method: 'PUT', body: { status } });
export const writeClickUpComment = (env, taskId, text) => cu(env, `/task/${encodeURIComponent(taskId)}/comment`, { method: 'POST', body: { comment_text: text } });

// ---------------------------------------------------------------- webhook
const val = (x) => (x && typeof x === 'object') ? (x.status ?? x.name ?? x.value ?? x.id ?? null) : (x ?? null);
const asId = (x) => (x && typeof x === 'object' ? x.id : x);

export async function webhook(ctx) {
  const { env, now } = ctx;
  const secret = await getSecret(env, 'clickup_webhook_secret');
  const sig = ctx.req.headers.get('x-signature');
  if (!secret || !sig) throw new HttpError(401, 'bad_signature', 'Unsigned request.');
  const expected = await hmacHex(secret, ctx.rawBody);
  if (!timingSafeEqual(expected, sig.toLowerCase())) throw new HttpError(401, 'bad_signature', 'Signature mismatch.');
  let p; try { p = JSON.parse(ctx.rawBody); } catch { throw bad('bad_json'); }
  const res = await processWebhook(env, p, now);
  if (res.taskId && res.changed) ctx.waitUntil?.(refreshTaskMeta(env, res.taskId).catch(() => {}));
  return json({ ok: true, new_events: res.inserted });
}

// Exported for tests. Idempotent: replays, duplicates and out-of-order delivery converge to the same state.
export async function processWebhook(env, p, now) {
  const taskId = p.task_id ? String(p.task_id) : null;
  if (!taskId || !WANTED_EVENTS.includes(p.event)) return { inserted: 0, taskId, changed: false };
  const wid = p.webhook_id || 'wh';
  const items = Array.isArray(p.history_items) ? p.history_items : [];
  const evs = [];
  if (p.event === 'taskDeleted') evs.push({ key: `${wid}:deleted:${taskId}`, kind: 'deleted', at: Number(items[0]?.date) || now, to: 'deleted' });
  for (const h of items) {
    const at = Number(h.date) || now;
    const key = `${wid}:${h.id ?? `${h.field}:${at}`}`;
    const actor = h.user?.id != null ? String(h.user.id) : null;
    if (h.field === 'status') evs.push({ key, kind: 'status', at, from: val(h.before), to: val(h.after), actor });
    else if (h.field === 'due_date') evs.push({ key, kind: 'due', at, from: h.before == null ? null : String(h.before), to: h.after == null ? null : String(h.after), actor });
    else if (h.field === 'assignee_add') evs.push({ key, kind: 'assignee_add', at, to: String(asId(h.after) ?? '') , actor });
    else if (h.field === 'assignee_rem') evs.push({ key, kind: 'assignee_rem', at, from: String(asId(h.before) ?? ''), actor });
  }
  if (p.event === 'taskCreated' && !evs.some((e) => e.kind === 'status')) {
    // creation carries the initial status in history; nothing to do without it
  }
  const db = env.DB;
  await db.prepare('INSERT OR IGNORE INTO tasks(id,name,first_seen_ms) VALUES (?,?,?)').bind(taskId, '(loading…)', now).run();
  let inserted = 0, minAt = Infinity, assigneeTouched = false;
  for (const e of evs) {
    const r = await db.prepare('INSERT OR IGNORE INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,from_val,to_val,actor) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(e.key, taskId, e.kind, e.at, now, 'webhook', e.from ?? null, e.to ?? null, e.actor ?? null).run();
    if (r.meta.changes) { inserted++; minAt = Math.min(minAt, e.at); if (e.kind.startsWith('assignee')) assigneeTouched = true; }
  }
  if (!inserted) return { inserted: 0, taskId, changed: false };
  if (assigneeTouched) await rebuildAssignees(db, taskId);
  await applyLatestToTask(db, taskId);
  await rebuildForTask(env, taskId, minAt, now);
  return { inserted, taskId, changed: true };
}

// task_assignees is derived from events so arrival order cannot corrupt it.
export async function rebuildAssignees(db, taskId) {
  const ev = (await db.prepare("SELECT kind,at_ms,to_val,from_val,note FROM task_events WHERE task_id=? AND kind IN ('assignee_add','assignee_rem') ORDER BY at_ms,id").bind(taskId).all()).results;
  const open = new Map(); const rows = [];
  for (const e of ev) {
    const uid = e.kind === 'assignee_add' ? e.to_val : e.from_val;
    if (!uid) continue;
    if (e.kind === 'assignee_add') {
      if (!open.has(uid)) { const r = { uid, start: e.note === 'approx' ? 0 : e.at_ms, end: null, known: e.note === 'approx' ? 0 : 1 }; open.set(uid, r); rows.push(r); }
    } else if (open.has(uid)) { open.get(uid).end = e.at_ms; open.delete(uid); }
    else rows.push({ uid, start: 0, end: e.at_ms, known: 0 }); // removal seen without the add: start unknown
  }
  await db.batch([
    db.prepare('DELETE FROM task_assignees WHERE task_id=?').bind(taskId),
    ...rows.map((r) => db.prepare('INSERT OR IGNORE INTO task_assignees(task_id,clickup_user_id,start_ms,end_ms,start_known) VALUES (?,?,?,?,?)').bind(taskId, r.uid, r.start, r.end, r.known)),
  ]);
}

async function applyLatestToTask(db, taskId) {
  const st = await db.prepare("SELECT to_val FROM task_events WHERE task_id=? AND kind='status' ORDER BY at_ms DESC,id DESC LIMIT 1").bind(taskId).first();
  const due = await db.prepare("SELECT to_val FROM task_events WHERE task_id=? AND kind='due' ORDER BY at_ms DESC,id DESC LIMIT 1").bind(taskId).first();
  const del = await db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='deleted'").bind(taskId).first();
  await db.prepare('UPDATE tasks SET status=COALESCE(?,status), due_ms=CASE WHEN ? IS NULL THEN due_ms ELSE ? END, deleted=? WHERE id=?')
    .bind(st?.to_val ?? null, due ? 1 : null, due?.to_val ? Number(due.to_val) : null, del ? 1 : 0, taskId).run();
}

export async function refreshTaskMeta(env, taskId) {
  const t = await cu(env, `/task/${encodeURIComponent(taskId)}`);
  await env.DB.prepare('UPDATE tasks SET name=?,url=?,priority=?,list_name=?,updated_ms=? WHERE id=?')
    .bind(t.name || '(untitled)', t.url || null, t.priority?.priority || null, t.list?.name || null, Number(t.date_updated) || null, taskId).run();
}

// ---------------------------------------------------------------- reconcile / sync
export async function syncState(db) { return db.prepare('SELECT * FROM sync_state WHERE id=1').first(); }

export async function runSync(env, now, { manual = false } = {}) {
  const db = env.DB;
  const st = await syncState(db);
  if (st.running && now - (st.last_attempt_ms || 0) < 10 * 60000) return { skipped: 'already_running' };
  await db.prepare('UPDATE sync_state SET running=1,last_attempt_ms=? WHERE id=1').bind(now).run();
  try {
    const team = await getSetting(db, 'clickup_team_id', null);
    if (!team) throw new Error('ClickUp workspace is not selected yet.');
    let page = st.cursor ? JSON.parse(st.cursor).page : 0;
    const fresh = page === 0;
    const seen = new Set();
    let pages = 0, done = false;
    const map = await statusMap(db);
    while (pages < 40) {
      const r = await cu(env, `/team/${encodeURIComponent(team)}/task?page=${page}&include_closed=true&subtasks=true&order_by=updated`);
      const tasks = r.tasks || [];
      await reconcilePage(env, tasks, now, map);
      tasks.forEach((t) => seen.add(String(t.id)));
      pages++; page++;
      if (r.last_page === true || tasks.length < 100) { done = true; break; }
    }
    if (done && fresh) await probeMissing(env, seen, now);
    if (done) await db.prepare('UPDATE sync_state SET running=0,last_ok_ms=?,last_error=NULL,cursor=NULL,last_run_day=? WHERE id=1').bind(now, localDate(now)).run();
    else await db.prepare('UPDATE sync_state SET running=0,cursor=? WHERE id=1').bind(JSON.stringify({ page })).run();
    return { ok: true, done, pages };
  } catch (e) {
    let msg = e.message;
    let cursor = st.cursor;
    if (e instanceof RateLimited) msg = 'ClickUp rate limit reached; will retry automatically.';
    else if (e instanceof AuthRevoked) msg = 'ClickUp access was revoked. Reconnect ClickUp in Settings.';
    await db.prepare('UPDATE sync_state SET running=0,last_error=? WHERE id=1').bind(msg).run();
    if (manual) return { ok: false, error: msg };
    return { ok: false, error: msg };
  }
}

export async function reconcilePage(env, tasks, now, map) {
  const db = env.DB;
  if (!tasks.length) return;
  const ids = tasks.map((t) => String(t.id));
  const ph = ids.map(() => '?').join(',');
  const known = new Map((await db.prepare(`SELECT id,due_ms FROM tasks WHERE id IN (${ph})`).bind(...ids).all()).results.map((r) => [r.id, r]));
  const lastStatus = new Map((await db.prepare(
    `SELECT task_id,to_val,at_ms FROM task_events e WHERE kind='status' AND task_id IN (${ph}) AND at_ms=(SELECT MAX(at_ms) FROM task_events x WHERE x.task_id=e.task_id AND x.kind='status')`).bind(...ids).all()).results.map((r) => [r.task_id, r]));
  const openAsg = (await db.prepare(`SELECT task_id,clickup_user_id FROM task_assignees WHERE end_ms IS NULL AND task_id IN (${ph})`).bind(...ids).all()).results;
  const asgBy = new Map();
  for (const a of openAsg) { if (!asgBy.has(a.task_id)) asgBy.set(a.task_id, new Set()); asgBy.get(a.task_id).add(a.clickup_user_id); }

  const stmts = []; const touched = [];
  for (const t of tasks) {
    const id = String(t.id);
    const status = t.status?.status ?? null;
    const due = t.due_date ? Number(t.due_date) : null;
    stmts.push(db.prepare(
      `INSERT INTO tasks(id,name,url,status,priority,due_ms,list_name,deleted,updated_ms,first_seen_ms) VALUES (?,?,?,?,?,?,?,0,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,status=excluded.status,priority=excluded.priority,due_ms=excluded.due_ms,list_name=excluded.list_name,deleted=0,updated_ms=excluded.updated_ms`)
      .bind(id, t.name || '(untitled)', t.url || null, status, t.priority?.priority || null, due, t.list?.name || null, Number(t.date_updated) || null, now));
    const ls = lastStatus.get(id);
    if (status != null && (!ls || String(ls.to_val).toLowerCase() !== String(status).toLowerCase())) {
      // Webhook history missed this change. Record it as UNVERIFIED over the whole uncertain window; never as counted time.
      const at = ls ? ls.at_ms + 1 : now;
      stmts.push(db.prepare("INSERT OR IGNORE INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,from_val,to_val,note) VALUES (?,?,?,?,?,'reconcile',?,?,'approx')")
        .bind(`rec:${id}:status:${status}:${now}`, id, 'status', at, now, ls?.to_val ?? null, status));
      if (ls) stmts.push(db.prepare('INSERT INTO gaps(task_id,from_ms,to_ms,reason,created_at) VALUES (?,?,?,?,?)')
        .bind(id, ls.at_ms, now, `Status changed from "${ls.to_val}" to "${status}" but no webhook was received; exact change time unknown.`, now));
      touched.push([id, at]);
    }
    const prevDue = known.get(id)?.due_ms ?? null;
    if (known.has(id) && prevDue !== due) {
      stmts.push(db.prepare("INSERT OR IGNORE INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,from_val,to_val,note) VALUES (?,?,'due',?,?,'reconcile',?,?,'approx')")
        .bind(`rec:${id}:due:${due}:${now}`, id, now, now, prevDue == null ? null : String(prevDue), due == null ? null : String(due)));
    } else if (!known.has(id) && due != null) {
      stmts.push(db.prepare("INSERT OR IGNORE INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,from_val,to_val,note) VALUES (?,?,'due',?,?,'reconcile',NULL,?,'approx')")
        .bind(`rec:${id}:due:${due}:first`, id, now, now, String(due)));
    }
    const snap = new Set((t.assignees || []).map((a) => String(a.id)));
    const cur = asgBy.get(id) || new Set();
    let asgChanged = false;
    for (const u of snap) if (!cur.has(u)) { asgChanged = true;
      stmts.push(db.prepare("INSERT OR IGNORE INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,to_val,note) VALUES (?,?,'assignee_add',?,?,'reconcile',?,'approx')").bind(`rec:${id}:add:${u}:${now}`, id, now, now, u)); }
    for (const u of cur) if (!snap.has(u)) { asgChanged = true;
      stmts.push(db.prepare("INSERT OR IGNORE INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,from_val,note) VALUES (?,?,'assignee_rem',?,?,'reconcile',?,'approx')").bind(`rec:${id}:rem:${u}:${now}`, id, now, now, u)); }
    if (asgChanged) touched.push([id, now, true]);
  }
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
  for (const [id, at, asg] of touched) { if (asg) await rebuildAssignees(db, id); await rebuildForTask(env, id, at, now); }
}

// A task missing from the listing may just be archived/closed, so confirm individually before calling it deleted.
async function probeMissing(env, seen, now) {
  const rows = (await env.DB.prepare('SELECT id,status FROM tasks WHERE deleted=0').all()).results.filter((r) => !seen.has(r.id)).slice(0, 15);
  for (const r of rows) {
    try { await cu(env, `/task/${encodeURIComponent(r.id)}`); }
    catch (e) {
      if (e.status === 404) {
        await env.DB.batch([
          env.DB.prepare("INSERT OR IGNORE INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,to_val,note) VALUES (?,?,'deleted',?,?,'reconcile','deleted','approx')").bind(`rec:${r.id}:deleted`, r.id, now, now),
          env.DB.prepare('UPDATE tasks SET deleted=1 WHERE id=?').bind(r.id),
        ]);
        await rebuildForTask(env, r.id, now, now);
      } else if (e instanceof RateLimited || e instanceof AuthRevoked) throw e;
    }
  }
}

// Cron: only fires the end-of-day sync at the admin-configured Karachi time, plus continues an interrupted sync.
export async function cronTick(env, now) {
  const st = await syncState(env.DB);
  const at = await getSetting(env.DB, 'sync_time_min', 18 * 60 + 30);
  const today = localDate(now);
  const due = localMinutes(now) >= at && st.last_run_day !== today;
  if (due || st.cursor) await runSync(env, now);
}

// ---------------------------------------------------------------- admin: connection
export async function saveToken(ctx) {
  const token = str(ctx.body.token, 'token', { min: 10, max: 300 });
  if (!ctx.env.ENCRYPTION_KEY) throw new HttpError(500, 'server_not_configured', 'Server encryption key is missing.');
  await putSecret(ctx.env, 'clickup_token', token);
  await audit(ctx.env.DB, { at: ctx.now, actor: ctx.emp.id, action: 'clickup_token_saved' });
  return json({ ok: true });
}
export async function members(ctx) {
  const r = await cu(ctx.env, '/team');
  return json({ teams: (r.teams || []).map((t) => ({ id: t.id, name: t.name, members: (t.members || []).map((m) => ({ id: String(m.user.id), name: m.user.username, email: m.user.email })) })) });
}
export async function createWebhook(ctx) {
  const team = await getSetting(ctx.env.DB, 'clickup_team_id', null);
  if (!team) throw bad('no_team', 'Pick the ClickUp workspace first.');
  const endpoint = new URL(ctx.req.url).origin + '/api/webhooks/clickup';
  const r = await cu(ctx.env, `/team/${encodeURIComponent(team)}/webhook`, { method: 'POST', body: { endpoint, events: WANTED_EVENTS } });
  const wh = r.webhook || r;
  if (!wh.secret) throw new HttpError(502, 'clickup_no_secret', 'ClickUp did not return a signing secret.');
  await putSecret(ctx.env, 'clickup_webhook_secret', wh.secret);
  await ctx.env.DB.batch([setSettingStmt(ctx.env.DB, 'clickup_webhook_id', wh.id), auditStmt(ctx.env.DB, { at: ctx.now, actor: ctx.emp.id, action: 'clickup_webhook_created', after: { id: wh.id } })]);
  return json({ ok: true });
}
export async function health(ctx) {
  const st = await syncState(ctx.env.DB);
  const connected = !!(await getToken(ctx.env));
  const hook = !!(await getSecret(ctx.env, 'clickup_webhook_secret'));
  const lastEvt = await ctx.env.DB.prepare("SELECT MAX(received_ms) m FROM task_events WHERE source='webhook'").first();
  const gaps = await ctx.env.DB.prepare('SELECT COUNT(*) n FROM gaps').first();
  const stale = !st.last_ok_ms || ctx.now - st.last_ok_ms > 36 * 3600000;
  return json({ connected, webhook_ready: hook, last_ok_ms: st.last_ok_ms, last_attempt_ms: st.last_attempt_ms, last_error: st.last_error, running: !!st.running, stale, last_webhook_ms: lastEvt.m, gap_count: gaps.n, team_id: await getSetting(ctx.env.DB, 'clickup_team_id', null) });
}
export async function syncNow(ctx) {
  const r = await runSync(ctx.env, ctx.now, { manual: true });
  return json(r);
}
