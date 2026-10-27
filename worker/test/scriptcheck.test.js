import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { evaluate, readDoc, docId, checkDeposit } from '../src/scriptcheck.js';
import { setupTeam, makeEmployee, approve, giveShift, rid } from './helpers.js';
import { localMidnightMs } from '../src/lib/time.js';

const html = (body) => `<html><body>${body}</body></html>`;
const docEnv = (page, status = 200, url = 'https://docs.googleusercontent.com/x') => Object.assign(Object.create(env), {
  DOC_FETCH: async () => { const r = new Response(page, { status, headers: { 'content-type': 'text/html' } }); Object.defineProperty(r, 'url', { value: url }); return r; },
});
const RULES = [
  { id: 'r1', label: 'Reference images', type: 'ref_images', min: 3 },
  { id: 'r2', label: 'Has Hook section', type: 'text', value: 'hook, thumbnail idea' },
  { id: 'r3', label: 'Long enough', type: 'words', min: 10 },
];
const GOOD = html('<h1>Hook</h1><p>Thumbnail idea: a fridge. ' + 'word '.repeat(20) + '</p><a href="https://www.google.com/url?q=https%3A%2F%2Fi.imgur.com%2Fa.jpg&sa=D">ref1</a><a href="https://example.com/pic.png">ref2</a><img src="https://lh3.googleusercontent.com/abc">');

describe('script check', () => {
  it('reads links, embedded images, headings and words from the Google Docs HTML export', async () => {
    const r = await readDoc(docEnv(GOOD), 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit');
    expect(r.status).toBe('ok');
    expect(r.facts.images).toBe(1);
    expect(r.facts.links).toContain('https://i.imgur.com/a.jpg'); // Google's /url?q= redirect is unwrapped
    const items = evaluate(RULES, r.facts);
    expect(items.map((i) => [i.label, i.ok])).toEqual([['Reference images', true], ['Has Hook section', true], ['Long enough', true]]);
    expect(items[0].have).toBe(3);
  });
  it('fails with exact counts when the writer skipped things', async () => {
    const r = await readDoc(docEnv(html('<p>Just a short draft</p>')), 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit');
    const items = evaluate(RULES, r.facts);
    expect(items.map((i) => i.ok)).toEqual([false, false, false]);
    expect(items[0]).toMatchObject({ have: 0, need: 3 });
    expect(items[1]).toMatchObject({ have: 0, need: 2 });
  });
  it('reports private, missing and non-doc links honestly instead of failing the writer', async () => {
    const u = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit';
    expect((await readDoc(docEnv('x', 200, 'https://accounts.google.com/ServiceLogin?x'), u)).status).toBe('private');
    expect((await readDoc(docEnv('x', 403), u)).status).toBe('private');
    expect((await readDoc(docEnv('x', 404), u)).status).toBe('not_found');
    expect((await readDoc(docEnv('x'), 'https://drive.google.com/file/d/abc')).status).toBe('not_a_doc');
    expect(docId('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit?tab=t.0')).toBe('1AbCdEfGhIjKlMnOpQrStUv');
  });
});

describe('script check end to end', () => {
  let admin, wr; const MON = localMidnightMs('2026-11-09');
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(MON + 10 * 3600000);
    admin = await setupTeam();
    wr = await makeEmployee(admin, 'Wren', { job_role: 'Writer' });
    await approve(admin, wr);
    await giveShift(admin, wr.id);
  });
  afterAll(() => vi.useRealTimers());
  it('admin config is validated and only admins can change it', async () => {
    expect((await wr.post('/api/admin/settings', { script_checks: { roles: ['Writer'], rules: RULES } })).status).toBe(403);
    expect((await admin.post('/api/admin/settings', { script_checks: { roles: ['Writer'], rules: [{ label: 'x', type: 'weird' }] } })).status).toBe(400);
    expect((await admin.post('/api/admin/settings', { script_checks: { roles: ['Writer'], rules: RULES } })).status).toBe(200);
  });
  it('checking a deposit stores the result and only applies to configured job roles', async () => {
    await wr.post('/api/checkin', { request_id: rid() }, { sign: true });
    const dep = await wr.post('/api/deposits', { request_id: rid(), link: 'https://example.com/not-a-google-doc', completed: 'Script v1', taskless_reason: 'Script writing', pending: 'Images' });
    expect(dep.status).toBe(200);
    expect(dep.data.check.status).toBe('not_a_doc'); // unreadable is reported as such, never as a failed script
    const row0 = await env.DB.prepare('SELECT id,link FROM deposits').first();
    const row = { id: row0.id, link: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit' };
    const ok = await checkDeposit(docEnv(GOOD), row, 'Writer', Date.now());
    expect(ok).toMatchObject({ status: 'ok', passed: true });
    const bad = await checkDeposit(docEnv(html('<p>short</p>')), row, 'writer', Date.now());
    expect(bad.passed).toBe(false);
    expect(await checkDeposit(docEnv(GOOD), row, 'Editor', Date.now())).toBeNull(); // other jobs are not checked
    const rep = (await admin.get('/api/reports?kind=monthly&period=2026-11')).data.employees.find((e) => e.employee.id === wr.id);
    expect(rep.script_checks).toMatchObject({ checked: 1, failed: 1, passed: 0 });
    expect(rep.script_checks.failing[0].missing.join(' ')).toMatch(/Reference images \(0\/3\)/);
    expect(rep.attention.join(' ')).toMatch(/did not pass the script check/);
  });
  it('re-check endpoint works for the owner and a manager, not for others', async () => {
    const row = await env.DB.prepare('SELECT id FROM deposits').first();
    const other = await makeEmployee(admin, 'Otto');
    expect((await other.post(`/api/deposits/${row.id}/recheck`)).status).toBe(403);
    expect((await wr.post(`/api/deposits/${row.id}/recheck`)).status).toBe(200); // not-a-doc link: reported, not an error
    expect((await admin.post(`/api/deposits/${row.id}/recheck`)).status).toBe(200);
  });
});
