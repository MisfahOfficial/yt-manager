// Automatic, non-blocking checklist for script Google Docs. The doc is read through Google's public
// "export as HTML" link (the doc must be shared as "Anyone with the link can view").
import { HttpError, bad, forbidden, notFound, json, getSetting, auditStmt } from './http.js';

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

export async function getConfig(db) { return getSetting(db, 'script_checks', { roles: [], rules: [] }); }
const appliesTo = (cfg, jobRole) => !!jobRole && cfg.rules?.length && (cfg.roles || []).map((x) => x.toLowerCase()).includes(String(jobRole).toLowerCase());

// Runs the check for one deposit and stores the outcome. Never throws and never blocks checkout.
export async function checkDeposit(env, dep, jobRole, now) {
  const cfg = await getConfig(env.DB);
  if (!appliesTo(cfg, jobRole)) return null;
  let result;
  try {
    const doc = await readDoc(env, dep.link);
    if (doc.status === 'ok') {
      const items = evaluate(cfg.rules, doc.facts);
      result = { status: 'ok', passed: items.every((i) => i.ok), items };
    } else result = { status: doc.status };
  } catch { result = { status: 'unreachable' }; }
  await env.DB.prepare('UPDATE deposits SET check_json=?,check_at=? WHERE id=?').bind(JSON.stringify(result), now, dep.id).run();
  return result;
}

export const STATUS_TEXT = {
  not_a_doc: 'The link is not a Google Doc, so it could not be checked.',
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

export async function mineLatestCheck(ctx) {
  const row = await ctx.env.DB.prepare('SELECT id,check_json FROM deposits WHERE employee_id=? AND check_json IS NOT NULL ORDER BY created_at DESC LIMIT 1').bind(ctx.emp.id).first();
  return json({ id: row?.id || null, check: row ? JSON.parse(row.check_json) : null });
}
