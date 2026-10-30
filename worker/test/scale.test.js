// Baseline at realistic team scale. Cloudflare Free allows ~1000 internal calls (D1/KV) per request, so query counts matter.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { setupTeam, makeEmployee, approve, giveShift } from './helpers.js';
import { buildReport } from '../src/reports.js';
import { rebuildEmployee } from '../src/engine.js';
import { localMidnightMs } from '../src/lib/time.js';

const H = 3600000, DAY = 24 * H;
const MON = localMidnightMs('2026-11-02');
let admin, people = [];
function counted() {
  const c = { n: 0 };
  const db = new Proxy(env.DB, { get(t, k) { if (k === 'prepare') return (sql) => { c.n++; return t.prepare(sql); }; if (k === 'batch') return (s) => { c.n++; return t.batch(s); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
  return { env: new Proxy(env, { get(t, k) { return k === 'DB' ? db : t[k]; } }), c };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(MON + 30 * DAY);
  admin = await setupTeam();
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const e = await makeEmployee(admin, 'Scale' + i, { job_role: 'Editor', clickup_user_id: String(9000 + i) });
    await approve(admin, e); await giveShift(admin, e.id, { start: 0, end: 1439, days: 127 });
    people.push(e); ids.push(e);
  }
  // 150 tasks per person over a month, each with 6 events, plus 28 days of attendance
  const stm = [];
  const ins = (sql, ...a) => stm.push(env.DB.prepare(sql).bind(...a));
  for (let p = 0; p < 8; p++) {
    for (let t = 0; t < 150; t++) {
      const id = `S${p}-${t}`, base = MON + (t % 28) * DAY + 2 * H;
      ins('INSERT INTO tasks(id,name,url,status,due_ms,first_seen_ms) VALUES (?,?,?,?,?,1)', id, `V${(t % 4) + 1}-${t} Task ${id}`, 'u', t % 5 === 0 ? 'in progress' : 'ready to upload', base + DAY);
      ins('INSERT INTO task_assignees(task_id,clickup_user_id,start_ms,end_ms) VALUES (?,?,0,?)', id, String(9000 + p), t % 5 === 0 ? null : base + 6 * H);
      ins('INSERT INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,to_val) VALUES (?,?,?,?,?,?,?)', id + 'a', id, 'assignee_add', base - H, 1, 'webhook', String(9000 + p));
      ins('INSERT INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,to_val) VALUES (?,?,?,?,?,?,?)', id + 'd', id, 'due', base - H, 1, 'webhook', String(base + DAY));
      ins('INSERT INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,to_val) VALUES (?,?,?,?,?,?,?)', id + 's1', id, 'status', base, 1, 'webhook', 'in progress');
      if (t % 5 !== 0) ins('INSERT INTO task_events(event_key,task_id,kind,at_ms,received_ms,source,to_val) VALUES (?,?,?,?,?,?,?)', id + 's2', id, 'status', base + 5 * H, 1, 'webhook', 'ready to upload');
    }
    for (let d = 0; d < 28; d++) ins("INSERT INTO attendance(id,employee_id,request_id,check_in_at,check_out_at,status) VALUES (?,?,?,?,?,'closed')", `A${p}-${d}`, people[p].id, `r${p}-${d}`, MON + d * DAY + 2 * H, MON + d * DAY + 9 * H);
  }
  for (let i = 0; i < stm.length; i += 90) await env.DB.batch(stm.slice(i, i + 90));
}, 120000);
afterAll(() => vi.useRealTimers());

describe('team-scale baseline (8 people x 150 tasks)', () => {
  it('a monthly report stays far below the 1000-calls-per-request limit', async () => {
    const { env: e, c } = counted();
    const ids = people.map((p) => p.id);
    const t0 = performance.now();
    const r = await buildReport(e, ids, 'monthly', '2026-11', Date.now(), { comparison: true });
    const ms = performance.now() - t0;
    console.log(`REPORT monthly+comparison: ${c.n} db calls, ${ms.toFixed(0)} ms, ${r.employees.length} people`);
    expect(r.employees.length).toBe(8);
    expect(c.n).toBeLessThan(400);
  });
  it('rebuilding one person (every Today page load) stays small', async () => {
    const { env: e, c } = counted();
    const t0 = performance.now();
    await rebuildEmployee(e, people[0].id, Date.now(), Date.now());
    console.log(`REBUILD one person: ${c.n} db calls, ${(performance.now() - t0).toFixed(0)} ms`);
    expect(c.n).toBeLessThan(60);
  });
  it('rebuilding everyone after a sync stays below the per-request limit', async () => {
    const { env: e, c } = counted();
    for (const p of people) await rebuildEmployee(e, p.id, Date.now() - 3 * DAY, Date.now());
    console.log(`REBUILD all 8: ${c.n} db calls`);
    expect(c.n).toBeLessThan(500);
  });
});
