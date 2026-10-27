// Automatic, non-blocking checklist for script Google Docs. The doc is read through Google's public
// "export as HTML" link (the doc must be shared as "Anyone with the link can view").
import { HttpError, bad, forbidden, notFound, json, getSetting, auditStmt } from './http.js';
import { cu, AuthRevoked } from './clickup.js';
import { statusMap } from './engine.js';
import { classify } from './lib/timer.js';

const IMG_LINK = /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)|imgur\.|pinterest\.|unsplash\.|pexels\.|wikimedia\.|wikipedia\.org\/wiki\/File|alamy\.|gettyimages\.|shutterstock\.|loc\.gov|archive\.org|googleusercontent\.com|drive\.google\.com\/(file|open|uc)|photos\.(app\.)?goo/i;
const MAX_TEXT = 400000;

export const docId = (url) => /docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{15,})/.exec(String(url || ''))?.[1] || null;

// ---- pure evaluation (unit-tested) ----
export function evaluate(rules, f) {
  return rules.map((r) => {
    const extra = String(r.value || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const matchLinks = (re) => f.links.filter((l) => (extra.length ? extra.some((x) => l.toLowerCase().includes(x)) : true) && (re ? re.test(l) : true));
    let have = 0, need = Math.max(1, +r.min || 1), ok;
    if (r.type === 'ref_images') { have = f.images + f.links.filter((l) => IMG_LINK.test(l) || extra.some((x) => l.toLowerCase().includes(x))).length; ok = have >= need; }
    else if (r.type === 'links') { have = matchLinks(null).length; ok = have >= need; }
    else if (r.type === 'images') { have = f.images; ok = have >= need; }
    else if (r.type === 'words') { have = f.words; need = Math.max(1, +r.min || 1); ok = have >= need; }
    else if (r.type === 'desc_links') { have = (f.descLinks || []).filter((l) => (extra.length ? extra.some((x) => l.toLowerCase().includes(x)) : true)).length; ok = have >= need; }
    else if (r.type === 'desc_items') { have = f.descItems || 0; ok = have >= need; }
    else if (r.type === 'desc_words') { have = f.descWords || 0; ok = have >= need; }
    else if (r.type === 'text') { have = extra.filter((x) => f.text.includes(x)).length; need = extra.length || 1; ok = extra.length > 0 && have >= need; }
    else { ok = false; }
    return { id: r.id, label: r.label, type: r.type, ok, have, need };
  });
}

// ---- reading the doc ----
export async function readDoc(env, url) {
  const id = docId(url);
  if (!id) return { status: 'not_a_doc' };
  let res;
  try { res = await (env.DOC_FETCH || fetch)(`https://docs.google.com/document/d/${id}/export?format=html`, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (YT Manager script check)' } }); }
  catch { return { status: 'unreachable' }; }
  const finalUrl = res.url || '';
  if (res.status === 404) return { status: 'not_found' };
  if (res.status === 401 || res.status === 403 || /accounts\.google\.com|ServiceLogin/i.test(finalUrl)) return { status: 'private' };
  if (!res.ok) return { status: 'unreachable' };
  const facts = { links: [], images: 0, words: 0, text: '' };
  let chunks = [], len = 0, title = '';
  const rw = new HTMLRewriter()
    .on('a[href]', { element(e) { const h = e.getAttribute('href'); if (h) { try { const u = new URL(h, 'https://docs.google.com'); const t = u.hostname === 'www.google.com' && u.pathname === '/url' ? u.searchParams.get('q') : u.toString(); if (t && /^https?:/i.test(t)) facts.links.push(t); } catch {} } } })
    .on('img', { element() { facts.images++; } })
    .on('title', { text(t) { title += t.text; } })
    .on('body', { text(t) { if (len < MAX_TEXT) { chunks.push(t.text); len += t.text.length; } } });
  try { await rw.transform(res).arrayBuffer(); } catch { return { status: 'unreachable' }; }
  if (/sign in|google accounts|accounts\.google/i.test(title)) return { status: 'private' }; // Google sometimes answers a private doc with a sign-in page
  const text = chunks.join(' ');
  facts.text = text.toLowerCase().replace(/\s+/g, ' ');
  facts.words = (text.match(/\S+/g) || []).length;
  facts.links = [...new Set(facts.links)];
  return { status: 'ok', facts };
}

export async function getConfig(db) {
  const c = await getSetting(db, 'script_checks', { jobs: {} });
  return c.jobs ? c : { jobs: {} };
}
export const rulesFor = (cfg, jobRole) => (jobRole && cfg.jobs?.[String(jobRole).toLowerCase()]?.rules) || [];

// Runs the DEPOSIT check for one deposit and stores the outcome. Never throws and never blocks checkout.
export async function checkDeposit(env, dep, jobRole, now) {
  const rules = rulesFor(await getConfig(env.DB), jobRole);
  if (!rules.length) return null;
  let result;
  try {
    const doc = await readDoc(env, dep.link);
    if (doc.status === 'ok') {
      const items = evaluate(rules, { ...doc.facts, descLinks: [], descItems: 0, descWords: 0 });
      result = { status: 'ok', passed: items.every((i) => i.ok), items };
    } else result = { status: doc.status };
  } catch { result = { status: 'unreachable' }; }
  await env.DB.prepare('UPDATE deposits SET check_json=?,check_at=? WHERE id=?').bind(JSON.stringify(result), now, dep.id).run();
  return result;
}

// ---- ClickUp task description ----
const URL_RE = /https?:\/\/[^\s)<>\]"'\\]+/gi;
export function descFacts(text) {
  const t = String(text || '');
  const links = [...new Set((t.match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const itemRe = /^([-*•]|\d+[.)])\s+\S/;
  const bulleted = lines.filter((l) => itemRe.test(l)).length;
  return { links, items: bulleted >= 2 ? bulleted : lines.length, words: (t.match(/\S+/g) || []).length, text: t.toLowerCase().replace(/\s+/g, ' ') };
}

// Runs when a task reaches a Finished status for someone whose job has rules. Reads the task description from
// ClickUp, follows the first Google Doc link in it, and stores the result. Never throws.
export async function checkTask(env, taskId, emp, trigger, now) {
  const rules = rulesFor(await getConfig(env.DB), emp.job_role);
  if (!rules.length) return null;
  let result;
  try {
    const t = await cu(env, `/task/${encodeURIComponent(taskId)}`);
    const d = descFacts(t.markdown_description || t.description || t.text_content || '');
    const docLink = d.links.find((l) => docId(l));
    let facts = { links: d.links, images: 0, words: d.words, text: d.text, descLinks: d.links, descItems: d.items, descWords: d.words };
    let docStatus = null;
    if (docLink) {
      const doc = await readDoc(env, docLink);
      if (doc.status === 'ok') facts = { links: [...new Set([...d.links, ...doc.facts.links])], images: doc.facts.images, words: doc.facts.words, text: doc.facts.text + ' ' + d.text, descLinks: d.links, descItems: d.items, descWords: d.words };
      else docStatus = doc.status;
    }
    const needsDoc = rules.some((r) => ['ref_images', 'images', 'words', 'text'].includes(r.type));
    const items = evaluate(rules, facts);
    result = { status: docStatus && needsDoc ? docStatus : 'ok', doc: docLink || null, passed: items.every((i) => i.ok), items };
    if (docStatus && needsDoc) { delete result.items; delete result.passed; result.status = docStatus; }
  } catch (e) { result = { status: e instanceof AuthRevoked ? 'clickup' : 'unreachable' }; }
  await env.DB.prepare('INSERT INTO task_checks(task_id,employee_id,checked_at,trigger,result_json) VALUES (?,?,?,?,?) ON CONFLICT(task_id,employee_id) DO UPDATE SET checked_at=excluded.checked_at,trigger=excluded.trigger,result_json=excluded.result_json')
    .bind(taskId, emp.id, now, trigger, JSON.stringify(result)).run();
  return result;
}

// After a webhook delivery: for each assignee whose job has rules and for whom a new status is "Finished", run the check.
export async function runTaskChecks(env, taskId, statuses, now) {
  const people = (await env.DB.prepare('SELECT e.id,e.job_role FROM task_assignees ta JOIN employees e ON e.clickup_user_id=ta.clickup_user_id WHERE ta.task_id=? AND ta.end_ms IS NULL AND e.job_role IS NOT NULL').bind(taskId).all()).results;
  for (const p of people) {
    const map = await statusMap(env.DB, p.job_role);
    const hit = statuses.find((st) => classify(st, map) === 'done');
    if (hit) await checkTask(env, taskId, p, hit, now);
  }
}
export const STATUS_TEXT = {
  not_a_doc: 'The link is not a Google Doc, so it could not be checked.',
  clickup: 'ClickUp could not be read. Reconnect ClickUp in Settings.',
  private: 'The Google Doc is private. Set sharing to "Anyone with the link can view", then press Re-check.',
  not_found: 'That Google Doc was not found.',
  unreachable: 'Google did not answer. Press Re-check in a minute.',
};

// POST /api/deposits/:id/recheck  (the person who made it, or their manager/admin)
export async function recheck(ctx) {
  const { env, emp, now, params } = ctx;
  const d = await env.DB.prepare('SELECT d.id,d.link,d.employee_id,e.job_role FROM deposits d JOIN employees e ON e.id=d.employee_id WHERE d.id=?').bind(params.id).first();
  if (!d) throw notFound();
  if (d.employee_id !== emp.id) {
    const { teamIds } = await import('./work.js');
    if (!(await teamIds(ctx)).includes(d.employee_id)) throw forbidden();
  }
  const r = await checkDeposit(env, d, d.job_role, now);
  if (!r) throw bad('no_check', 'Script checking is not turned on for this job.');
  return json({ ok: true, check: r });
}

export async function recheckTask(ctx) {
  const { env, emp, now, params } = ctx;
  const t = await env.DB.prepare('SELECT id FROM tasks WHERE id=?').bind(params.id).first();
  if (!t) throw notFound();
  const { teamIds } = await import('./work.js');
  const allowed = await teamIds(ctx);
  const rows = (await env.DB.prepare('SELECT e.id,e.job_role FROM task_assignees ta JOIN employees e ON e.clickup_user_id=ta.clickup_user_id WHERE ta.task_id=? AND ta.end_ms IS NULL AND e.id IN (' + (allowed.map(() => '?').join(',') || "''") + ')').bind(params.id, ...allowed).all()).results;
  if (!rows.length) throw forbidden();
  let any = null;
  for (const p of rows) { const r = await checkTask(env, params.id, p, 'manual', now); if (r) any = r; }
  if (!any) throw bad('no_check', 'Script checking is not turned on for this job.');
  return json({ ok: true, check: any });
}

// Latest task checks the caller may see: own for employees, team for managers/admins.
export async function listTaskChecks(ctx) {
  const { teamIds } = await import('./work.js');
  const ids = await teamIds(ctx);
  const days = Math.min(+ctx.url.searchParams.get('days') || 14, 92);
  const rows = (await ctx.env.DB.prepare(
    `SELECT c.task_id,c.employee_id,e.name employee,e.job_role,c.checked_at,c.trigger,c.result_json,t.name task_name,t.url task_url
       FROM task_checks c JOIN employees e ON e.id=c.employee_id LEFT JOIN tasks t ON t.id=c.task_id
      WHERE c.employee_id IN (${ids.map(() => '?').join(',') || "''"}) AND c.checked_at>=? ORDER BY c.checked_at DESC LIMIT 200`).bind(...ids, Date.now() - days * 86400000).all()).results;
  return json({ checks: rows.map((r) => ({ ...r, result: JSON.parse(r.result_json), result_json: undefined })) });
}

export async function mineLatestCheck(ctx) {
  const row = await ctx.env.DB.prepare('SELECT id,check_json FROM deposits WHERE employee_id=? AND check_json IS NOT NULL ORDER BY created_at DESC LIMIT 1').bind(ctx.emp.id).first();
  return json({ id: row?.id || null, check: row ? JSON.parse(row.check_json) : null });
}
