import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { setupTeam, makeEmployee } from './helpers.js';
import { calStatus } from '../src/lib/calendar.js';
import { codeOf, isAutomation, firstToken, channelOf } from '../src/lib/titles.js';
import { localMidnightMs } from '../src/lib/time.js';
import { calendarPass } from '../src/clickup.js';

const H = 3600000, DAY = 24 * H;
const MON = localMidnightMs('2026-11-30');
let admin, mgr, emp;

describe('channel detection', () => {
  it('reads the channel from the start of the name, including automation braces and the Spanish group', () => {
    expect(codeOf('V4--30 Forgotten $1 Meals')).toBe('V4');
    expect(codeOf('{C1--12 Chains That Made Your Meal Smaller}')).toBe('C1');
    expect(codeOf('{B1-How Every Famous French King Died}')).toBe('B1');
    expect(codeOf('C2—NEVER Boil Your Spaghetti')).toBe('C2');
    expect(isAutomation('{C1--12 x}')).toBe(true);
    expect(isAutomation('C1--12 x')).toBe(false);
    expect(firstToken('Spanish--30 Forgotten')).toBe('SPANISH');
    expect(firstToken('{SS1-abc}')).toBe('SS1');
    const ch = new Map([['V1', { code: 'V1', name: 'Vintage' }], ['SPANISH', { code: 'SPANISH', name: 'Spanish' }]]);
    expect(channelOf('V1-30 Treats', ch).name).toBe('Vintage');
    expect(channelOf('Spanish--30 Cosas', ch).name).toBe('Spanish');
    expect(channelOf('Fix thumbnail for 9', ch)).toBeNull();
  });
});

describe('calendar status', () => {
  const today = MON + 2 * DAY;
  it('maps ClickUp statuses to Planned / In Production / Ready / Uploaded / Missed', () => {
    expect(calStatus('to do', 'other', today + DAY, today)).toBe('Planned');
    expect(calStatus('in progress', 'active', today + DAY, today)).toBe('In Production');
    expect(calStatus('blocked', 'paused', today + DAY, today)).toBe('In Production');
    expect(calStatus('ready to uploading', 'done', today + DAY, today)).toBe('Ready');
    expect(calStatus('edited thumbnails', 'done', today + DAY, today)).toBe('Ready');
    expect(calStatus('uploaded', 'done', today - DAY, today)).toBe('Uploaded');
    expect(calStatus('payment done', 'ignore', today - DAY, today)).toBe('Uploaded');
  });
  it('anything past its day and not uploaded is Missed, never silently hidden', () => {
    expect(calStatus('to do', 'other', today - DAY, today)).toBe('Missed');
    expect(calStatus('ready to uploading', 'done', today - DAY, today)).toBe('Missed');
    expect(calStatus('in progress', 'active', today, today)).toBe('In Production'); // due today is not late yet
    expect(calStatus('to do', 'other', null, today)).toBe('Planned');
  });
});

describe('calendar, channels and categories API', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(MON + 2 * DAY + 10 * H);
    admin = await setupTeam();
    mgr = await makeEmployee(admin, 'Cal', { role: 'manager' });
    emp = await makeEmployee(admin, 'Ed', { job_role: 'Editor', clickup_user_id: '311' });
    const ins = env.DB.prepare('INSERT OR REPLACE INTO tasks(id,name,url,status,due_ms,first_seen_ms) VALUES (?,?,?,?,?,1)');
    await env.DB.batch([
      ins.bind('K1', 'V1-30 Forgotten Treats', 'https://c/K1', 'in progress', MON + 3 * DAY + 12 * H),
      ins.bind('K2', 'V4--25 Cheap Dinners', 'https://c/K2', 'ready to uploading', MON + 3 * DAY + 12 * H),
      ins.bind('K3', '{C1--12 Chains}', 'https://c/K3', 'edited thumbnails', MON + 4 * DAY + 12 * H),
      ins.bind('K4', 'Spanish--30 Dulces', 'https://c/K4', 'uploaded', MON + DAY + 12 * H),
      ins.bind('K5', 'V2--25 Cookies', 'https://c/K5', 'to do', MON + 12 * H),               // Monday, before today, not uploaded: Missed
      ins.bind('K6', 'Random chore', 'https://c/K6', 'to do', MON + 5 * DAY + 12 * H),       // no channel
      ins.bind('K7', 'V3-25 Cheese', 'https://c/K7', 'to do', null),                         // unscheduled
      ins.bind('K8', 'V1-31 Next week', 'https://c/K8', 'to do', MON + 8 * DAY + 12 * H),    // other week
    ]);
    await env.DB.prepare("INSERT INTO task_assignees(task_id,clickup_user_id,start_ms) VALUES ('K1','311',0)").run();
  });
  afterAll(() => vi.useRealTimers());

  it('week view groups by channel with the right statuses; thumbnails from automation are flagged', async () => {
    const r = (await mgr.get('/api/calendar?week=2026-11-30')).data;
    expect(r.days[0]).toBe('2026-11-30');
    const by = Object.fromEntries(r.channels.map((c) => [c.code, c.items]));
    expect(by.V1[0]).toMatchObject({ id: 'K1', cal: 'In Production', assignees: ['Ed'] });
    expect(by.V4[0].cal).toBe('Ready');
    expect(by.C1[0]).toMatchObject({ automation: true, cal: 'Ready' });
    expect(by.SPANISH[0].cal).toBe('Uploaded');
    expect(by.V2[0].cal).toBe('Missed');
    expect(by['']?.[0].id).toBe('K6');
    expect(JSON.stringify(r.channels)).not.toContain('K8');
    expect(r.unscheduled.map((x) => x.id)).toEqual(['K7']);
    expect(r.counts).toMatchObject({ 'In Production': 1, Ready: 2, Uploaded: 1, Missed: 1 });
  });
  it('employees cannot see the calendar; only the Owner edits channels', async () => {
    expect((await emp.get('/api/calendar')).status).toBe(403);
    expect((await mgr.post('/api/admin/channels', { channels: [] })).status).toBe(403);
    expect((await mgr.get('/api/channels')).status).toBe(200);
  });
  it('the Owner edits the channel list; bad input is refused; removed channels become inactive', async () => {
    const list = (await admin.get('/api/channels')).data;
    expect(list.channels.map((c) => c.code)).toContain('V4');
    expect(list.channels.find((c) => c.code === 'V1').tasks).toBeGreaterThan(0);
    expect((await admin.post('/api/admin/channels', { channels: [{ code: 'v 1', name: 'x' }] })).status).toBe(400);
    expect((await admin.post('/api/admin/channels', { channels: [{ code: 'V1', name: 'A' }, { code: 'v1', name: 'B' }] })).status).toBe(400);
    const ok = await admin.post('/api/admin/channels', { channels: [{ code: 'V1', name: 'Vintage Life', color: '#112233' }, { code: 'V4', name: 'Canada' }, { code: 'NEW1', name: 'New channel' }] });
    expect(ok.status).toBe(200);
    const after = (await admin.get('/api/channels')).data.channels;
    expect(after.find((c) => c.code === 'V1')).toMatchObject({ name: 'Vintage Life', color: '#112233', active: 1 });
    expect(after.find((c) => c.code === 'V2').active).toBe(0);
    await admin.post('/api/admin/channels', { channels: ['V1', 'V2', 'V3', 'V4', 'C1', 'SPANISH'].map((c) => ({ code: c, name: c })) });
  });
  it('categories are Owner-managed', async () => {
    expect((await mgr.get('/api/admin/categories')).status).toBe(403);
    expect((await admin.post('/api/admin/categories', { categories: [{ name: 'Video editing', job_role: 'Editor' }, { name: 'Uploading', job_role: 'Uploader' }] })).status).toBe(200);
    expect((await admin.get('/api/admin/categories')).data.categories.map((c) => c.name)).toEqual(['Video editing', 'Uploading']);
  });
  it('calendarPass keeps only tasks that start with a known channel code, whoever they are assigned to', async () => {
    const now = Date.now();
    const e = Object.assign(Object.create(env), { CLICKUP_TOKEN: 'pk_x', CLICKUP_FETCH: async () => new Response(JSON.stringify({ last_page: true, tasks: [
      { id: 'P1', name: 'V1-40 New video', url: 'u', status: { status: 'to do' }, due_date: String(now + 3 * DAY), date_updated: String(now), assignees: [] },
      { id: 'P2', name: '{C1--13 thumb}', url: 'u', status: { status: 'to do' }, due_date: String(now + 3 * DAY), date_updated: String(now), assignees: [] },
      { id: 'P3', name: 'Team lunch', url: 'u', status: { status: 'to do' }, due_date: String(now + DAY), date_updated: String(now), assignees: [] } ] }), { status: 200 }) });
    await env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('clickup_team_id','\"T1\"')").run();
    const r = await calendarPass(e, now);
    expect(r.kept).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM tasks WHERE id IN ('P1','P2')").first()).n).toBe(2);
    expect(await env.DB.prepare("SELECT 1 FROM tasks WHERE id='P3'").first()).toBeNull();
  });
});
