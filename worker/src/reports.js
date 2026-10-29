import { json, bad, forbidden, getSetting } from './http.js';
import { codeOf, normTitle, channelOf, isAutomation } from './lib/titles.js';
import { loadChannels } from './calendar.js';
import { teamIds } from './work.js';
import { loadShiftContext, attendanceEnd, statusMap } from './engine.js';
import { statusTimeline, deliveries, applicableDeadline, classify, normalize, intersect, total } from './lib/timer.js';
import { periodRange, localMidnightMs, addDays, localDate, prevPeriod, isYmd, weekStart } from './lib/time.js';

const MIN = 60000;

export async function employeeReport(env, emp, kind, period, now, map, trackJobs = [], goals = {}, extra = {}) {
  const { from, to } = periodRange(kind, period);
  const fromMs = localMidnightMs(from), toMs = localMidnightMs(addDays(to, 1));
  const db = env.DB;
  const sc = await loadShiftContext(db, emp.id, fromMs - 86400000, toMs);
  const att = (await db.prepare('SELECT * FROM attendance WHERE employee_id=? AND check_in_at<? AND COALESCE(check_out_at,?)>? ORDER BY check_in_at').bind(emp.id, toMs, now, fromMs).all()).results;
  const leaveRows = sc.leaves;
  const warn = [];

  const days = [];
  let scheduled = 0, present = 0, leaveDays = 0, absent = 0, lateCount = 0, lateMin = 0, earlyCount = 0, earlyMin = 0, missingCo = 0, corrected = 0;
  const cutoff = Math.min(toMs, now);
  for (const w of sc.windows.filter((x) => x.start >= fromMs && x.start < toMs && x.start < now)) {
    const d = w.date;
    const onLeave = false; // windows already exclude leave days
    scheduled++;
    const here = att.filter((a) => a.check_in_at < w.end && attendanceEnd(a, sc.windows, now) > w.start);
    if (!here.length) { absent++; days.push({ date: d, status: 'absent', attendance_ids: [] }); continue; }
    present++;
    const first = Math.min(...here.map((a) => a.check_in_at));
    const closed = here.filter((a) => a.check_out_at != null);
    const last = closed.length ? Math.max(...closed.map((a) => a.check_out_at)) : null;
    const grace = (sc.asg.find((x) => x.effective_from <= d && (!x.effective_to || d <= x.effective_to))?.shift.grace_min) ?? 10;
    let late = 0, early = 0;
    if (first > w.start + grace * MIN) { late = Math.round((first - w.start) / MIN); lateCount++; lateMin += late; }
    const miss = here.some((a) => a.status === 'missing_checkout');
    const stillOpen = here.some((a) => a.status === 'open');
    if (miss) missingCo++;
    else if (last != null && !stillOpen && last < w.end) { early = Math.round((w.end - last) / MIN); earlyCount++; earlyMin += early; }
    if (here.some((a) => a.corrected)) corrected++;
    days.push({ date: d, status: 'present', late_min: late, early_min: early, missing_checkout: miss, attendance_ids: here.map((a) => a.id) });
  }
  // approved leave on days the person was otherwise scheduled
  const asgAll = sc.asg;
  let dd = from;
  while (dd <= to) {
    const a = asgAll.find((x) => x.effective_from <= dd && (!x.effective_to || dd <= x.effective_to));
    const onL = leaveRows.some((l) => l.date_from <= dd && dd <= l.date_to);
    if (a && onL && ((a.shift.days_mask >> ((new Date(dd + 'T00:00:00Z').getUTCDay() + 6) % 7)) & 1) && localMidnightMs(dd) < now) leaveDays++;
    dd = addDays(dd, 1);
  }

  const deps = (await db.prepare('SELECT id,task_id,created_at,is_complete,taskless_reason,attendance_id FROM deposits WHERE employee_id=? AND created_at>=? AND created_at<?').bind(emp.id, fromMs, toMs).all()).results;
  const attDaysWithDeposit = new Set(deps.map((d) => localDate(d.created_at)));
  const missingDeposits = days.filter((d) => d.status === 'present' && !attDaysWithDeposit.has(d.date)).length;
  // script checks: latest result per Google Doc link
  const chk = (await db.prepare('SELECT id,link,check_json,created_at FROM deposits WHERE employee_id=? AND check_json IS NOT NULL AND created_at>=? AND created_at<? ORDER BY created_at').bind(emp.id, fromMs, toMs).all()).results;
  const latest = new Map(chk.map((c) => [c.link, { ...c, task_name: null }]));
  const tchk = (await db.prepare('SELECT c.task_id,c.result_json check_json,t.name task_name,t.url FROM task_checks c LEFT JOIN tasks t ON t.id=c.task_id WHERE c.employee_id=? AND c.checked_at>=? AND c.checked_at<?').bind(emp.id, fromMs, toMs).all()).results;
  for (const c of tchk) latest.set('task:' + c.task_id, { id: c.task_id, link: c.url, task_name: c.task_name, check_json: c.check_json });
  const scriptChecks = { checked: 0, passed: 0, failed: 0, unavailable: 0, by_rule: {}, failing: [] };
  for (const c of latest.values()) {
    const r = JSON.parse(c.check_json);
    if (r.status !== 'ok') { scriptChecks.unavailable++; continue; }
    if (!r.items) continue;
    scriptChecks.checked++;
    if (r.passed) scriptChecks.passed++; else { scriptChecks.failed++; scriptChecks.failing.push({ deposit_id: c.id, name: c.task_name, link: c.link, missing: r.items.filter((i) => !i.ok).map((i) => `${i.label} (${i.have}/${i.need})`) }); }
    for (const i of r.items) { const b = (scriptChecks.by_rule[i.label] ||= { passed: 0, total: 0 }); b.total++; if (i.ok) b.passed++; }
  }
  const exceptions = att.filter((a) => a.checkout_exception).length;
  const netEx = att.filter((a) => a.network_exception_id).length;

  const sess = (await db.prepare('SELECT * FROM task_sessions WHERE employee_id=? AND start_ms<? AND COALESCE(end_ms,?)>?').bind(emp.id, toMs, now, fromMs).all()).results;
  let origMs = 0, revMs = 0;
  const byTask = new Map();
  for (const s of sess) {
    const ms = Math.max(0, Math.min(s.end_ms ?? now, toMs, now) - Math.max(s.start_ms, fromMs));
    if (s.kind === 'revision') revMs += ms; else origMs += ms;
    const b = byTask.get(s.task_id) || { orig: 0, rev: 0 }; b[s.kind === 'revision' ? 'rev' : 'orig'] += ms; byTask.set(s.task_id, b);
  }

  const deliveredTasks = []; let onTime = 0, overdue = 0, noDeadline = 0, revDelivered = 0;
  const blockers = []; const gapsOut = [];
  if (emp.clickup_user_id) {
    const tids = (await db.prepare('SELECT DISTINCT task_id FROM task_assignees WHERE clickup_user_id=?').bind(emp.clickup_user_id).all()).results.map((r) => r.task_id);
    for (const id of tids) {
      const ev = (await db.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY at_ms,id').bind(id).all()).results;
      const t = await db.prepare('SELECT id,name,url,list_name,work_type FROM tasks WHERE id=?').bind(id).first();
      const dl = deliveries(ev, map);
      const due = ev.filter((e) => e.kind === 'due');
      dl.forEach((d) => {
        if (d.at < fromMs || d.at >= toMs) return;
        if (d.kind === 'revision') { revDelivered++; return; }
        const ad = applicableDeadline(due, d.at);
        const rec = { task_id: id, name: t?.name, url: t?.url, channel: (extra.channels && channelOf(t?.name, extra.channels)?.name) || 'No channel', delivered_at: d.at, deadline: ad.deadline, original_deadline: ad.original ?? null, extended_after_miss: ad.extendedAfterMiss.length > 0 };
        if (ad.deadline == null) { noDeadline++; rec.on_time = null; } else if (d.at <= ad.deadline) { onTime++; rec.on_time = true; } else { overdue++; rec.on_time = false; }
        deliveredTasks.push(rec);
      });
      for (const seg of statusTimeline(ev, map)) {
        if (seg.cls !== 'paused') continue;
        const e = seg.end ?? now;
        if (e <= fromMs || seg.start >= toMs) continue;
        blockers.push({ task_id: id, name: t?.name, url: t?.url, status: seg.status, from: seg.start, to: seg.end, ms: Math.min(e, toMs) - Math.max(seg.start, fromMs), reason: 'No reason recorded in ClickUp' });
      }
      const g = (await db.prepare('SELECT from_ms,to_ms,reason FROM gaps WHERE task_id=? AND to_ms>? AND from_ms<?').bind(id, fromMs, toMs).all()).results;
      g.forEach((x) => gapsOut.push({ task_id: id, name: t?.name, ...x }));
    }
  } else warn.push('Not linked to a ClickUp user: tasks and recorded time are not available.');

  // jobs that create tasks (title finders): count what they created, per channel code
  let created = null;
  if (emp.clickup_user_id && emp.job_role && trackJobs.includes(emp.job_role.toLowerCase())) {
    const mine = (await db.prepare('SELECT id,name,url,created_ms FROM tasks WHERE creator_id=? AND created_ms>=? AND created_ms<? AND deleted=0 ORDER BY created_ms').bind(emp.clickup_user_id, fromMs, toMs).all()).results;
    const all = (await db.prepare('SELECT id,name FROM tasks WHERE deleted=0 LIMIT 20000').all()).results;
    const seen = new Map();
    for (const t of all) { const k = normTitle(t.name); if (k) { if (!seen.has(k)) seen.set(k, []); seen.get(k).push(t.id); } }
    created = { total: mine.length, by_code: {}, no_code: [], days: {}, duplicates: [], note: 'Counts tasks this person created in ClickUp. It does not judge title quality.' };
    for (const t of mine) {
      const c = codeOf(t.name);
      if (c) created.by_code[c] = (created.by_code[c] || 0) + 1; else created.no_code.push({ id: t.id, name: t.name, url: t.url });
      const d = localDate(t.created_ms); created.days[d] = (created.days[d] || 0) + 1;
      const same = (seen.get(normTitle(t.name)) || []).filter((x) => x !== t.id);
      if (same.length) created.duplicates.push({ id: t.id, name: t.name, url: t.url, others: same.length });
    }
    created.days = Object.entries(created.days).sort().map(([date, n]) => ({ date, count: n }));
  }
  // goal: weekly target per job, scaled to the period. Titles for task-creating jobs, delivered tasks for everyone else.
  let goal = null;
  const perWeek = +goals[String(emp.job_role || '').toLowerCase()] || 0;
  if (perWeek > 0) {
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
    const target = Math.max(1, Math.round(perWeek * days / 7));
    const count = created ? created.total : deliveredTasks.length;
    goal = { per_week: perWeek, target, count, pct: Math.round(count / target * 100), metric: created ? 'titles created' : 'tasks delivered' };
  }
  // work types: the person's category (from their job) with automation-made thumbnails kept apart
  const roleCat = (extra.cats || []).find((c) => c.active && c.job_role && emp.job_role && c.job_role.toLowerCase() === emp.job_role.toLowerCase())?.name || emp.job_role || 'Other';
  const catOf = (n) => (isAutomation(n) ? 'Thumbnail (automation)' : roleCat);
  const workTypes = {};
  const wt = (k) => (workTypes[k] ||= { delivered: 0, ms: 0 });
  for (const d of deliveredTasks) wt(catOf(d.name)).delivered++;
  if (byTask.size) {
    const ids = [...byTask.keys()];
    const names = new Map((await db.prepare(`SELECT id,name FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results.map((r) => [r.id, r.name]));
    for (const [id, v] of byTask) wt(catOf(names.get(id))).ms += v.orig + v.rev;
  }
  const attention = [];
  if (absent) attention.push(`${absent} unexplained absence day(s)`);
  if (missingCo) attention.push(`${missingCo} missing check-out(s) need correction`);
  if (missingDeposits) attention.push(`${missingDeposits} present day(s) without a work deposit`);
  if (overdue) attention.push(`${overdue} delivery(ies) after the agreed deadline`);
  if (exceptions) attention.push(`${exceptions} check-out(s) done without a work deposit (technical exception)`);
  if (netEx) attention.push(`${netEx} attendance record(s) made under a network exception`);
  if (created?.no_code.length) attention.push(`${created.no_code.length} title(s) created without a channel code`);
  if (created?.duplicates.length) attention.push(`${created.duplicates.length} title(s) that may repeat an existing one`);
  if (scriptChecks.failed) attention.push(`${scriptChecks.failed} item(s) did not pass the script/title check`);
  if (gapsOut.length) attention.push(`${gapsOut.length} ClickUp history gap(s): exact times unknown`);

  const incomplete = toMs > now;
  return {
    employee: { id: emp.id, name: emp.name, job_role: emp.job_role || null },
    incomplete_period: incomplete, warnings: warn,
    attendance: { scheduled_days: scheduled, present_days: present, approved_leave_days: leaveDays, unexplained_absence_days: absent, late_arrivals: lateCount, late_minutes: lateMin, early_departures: earlyCount, early_minutes: earlyMin, missing_checkouts: missingCo, corrected_days: corrected, days },
    deposits: { count: deps.length, missing_days: missingDeposits, checkout_exceptions: exceptions },
    delivery: { delivered: deliveredTasks.length, on_time: onTime, overdue, no_deadline: noDeadline, revision_deliveries: revDelivered, denominator: onTime + overdue, tasks: deliveredTasks, label: 'Ready for Upload / Delivered (not quality-approved)' },
    recorded_time: { original_ms: origMs, revision_ms: revMs, note: 'Recorded task time while checked in and in an eligible status; not proof of focused editing.' },
    work_types: workTypes, goal, created, script_checks: scriptChecks, blockers, gaps: gapsOut, attention,
    sources: { attendance_ids: att.map((a) => a.id), deposit_ids: deps.map((d) => d.id), task_ids: [...byTask.keys(), ...deliveredTasks.map((t) => t.task_id)] },
  };
}

function rollup(list) {
  const sum = (f) => list.reduce((n, r) => n + f(r), 0);
  return {
    scheduled_days: sum((r) => r.attendance.scheduled_days), present_days: sum((r) => r.attendance.present_days),
    leave_days: sum((r) => r.attendance.approved_leave_days), absent_days: sum((r) => r.attendance.unexplained_absence_days),
    late_minutes: sum((r) => r.attendance.late_minutes), delivered: sum((r) => r.delivery.delivered), on_time: sum((r) => r.delivery.on_time), overdue: sum((r) => r.delivery.overdue), created: sum((r) => r.created?.total || 0),
    original_ms: sum((r) => r.recorded_time.original_ms), revision_ms: sum((r) => r.recorded_time.revision_ms), deposits: sum((r) => r.deposits.count),
  };
}

export const AGAINST = { previous: 'the previous period', same_week_last_month: 'the same week last month' };
export function comparePeriod(kind, period, against) {
  if (against === 'same_week_last_month' && kind === 'weekly') return addDays(period, -28);
  return prevPeriod(kind, period);
}

// opts.comparison (Owner only): also compute each person against an earlier period.
export async function buildReport(env, ids, kind, period, now, opts = {}) {
  const emps = ids.length ? (await env.DB.prepare(`SELECT id,name,job_role,clickup_user_id FROM employees WHERE id IN (${ids.map(() => '?').join(',')}) AND role<>'admin' AND active=1 ORDER BY name`).bind(...ids).all()).results : [];
  const rows = [];
  const trackJobs = (await getSetting(env.DB, 'created_tracking_jobs', [])).map((j) => String(j).toLowerCase());
  const goals = Object.fromEntries(Object.entries(await getSetting(env.DB, 'job_goals', {})).map(([k, v]) => [k.toLowerCase(), v]));
  const extra = { channels: await loadChannels(env.DB), cats: (await env.DB.prepare('SELECT name,job_role,active FROM work_categories').all()).results };
  const maps = new Map(); // one map per job role
  const mapFor = async (e) => { const k = e.job_role || ''; if (!maps.has(k)) maps.set(k, await statusMap(env.DB, e.job_role)); return maps.get(k); };
  for (const e of emps) rows.push(await employeeReport(env, e, kind, period, now, await mapFor(e), trackJobs, goals, extra));
  const out = { kind, period, range: periodRange(kind, period), generated_at: now, incomplete_period: rows.some((r) => r.incomplete_period), employees: rows, totals: rollup(rows),
    notes: ['No automatic pay, raise or disciplinary decisions are made from this report.', 'Employees are not ranked: shifts and video complexity differ.'] };
  if (opts.comparison) {
    const against = opts.against || 'previous';
    const pp = comparePeriod(kind, period, against);
    const prevRows = [];
    for (const e of emps) prevRows.push(await employeeReport(env, e, kind, pp, now, await mapFor(e), trackJobs, goals, extra));
    const cnt = (r) => (r.created ? r.created.total : r.delivery.delivered);
    rows.forEach((r, i) => { const p0 = prevRows[i]; r.comparison = { period: pp, delivered_delta: cnt(r) - cnt(p0), goal_pct_delta: r.goal && p0.goal ? r.goal.pct - p0.goal.pct : null, days_delta: r.attendance.present_days - p0.attendance.present_days, time_delta_ms: (r.recorded_time.original_ms + r.recorded_time.revision_ms) - (p0.recorded_time.original_ms + p0.recorded_time.revision_ms) }; });
    const pt = rollup(prevRows);
    const comparable = pt.scheduled_days > 0 && out.totals.scheduled_days > 0;
    out.previous = { period: pp, against, label: AGAINST[against], totals: pt, comparable, comparable_note: comparable ? 'Compare per scheduled day; period lengths and shifts differ.' : 'Not comparable (no scheduled days in one of the periods).' };
  }
  {
  const byCh = {};
    for (const r of rows) for (const t of r.delivery.tasks) { const c = (byCh[t.channel] ||= { delivered: 0, on_time: 0, overdue: 0 }); c.delivered++; if (t.on_time === true) c.on_time++; if (t.on_time === false) c.overdue++; }
    out.by_channel = byCh;
    const byWt = {};
    for (const r of rows) for (const [k, v] of Object.entries(r.work_types || {})) { const c = (byWt[k] ||= { people: 0, delivered: 0, ms: 0 }); c.people++; c.delivered += v.delivered; c.ms += v.ms; }
    out.by_work_type = byWt;
  }
  if (kind === 'monthly') {
    const rep = new Map();
    for (const r of rows) for (const b of r.blockers) rep.set(b.task_id, (rep.get(b.task_id) || 0) + 1);
    out.repeated_blockers = [...rep.entries()].filter(([, n]) => n > 1).map(([task_id, n]) => ({ task_id, times: n }));
    const byRole = {};
    for (const r of rows) { const k = r.employee.job_role || 'No job role set'; const c = (byRole[k] ||= { people: 0, delivered: 0, on_time: 0, overdue: 0, original_ms: 0, revision_ms: 0 }); c.people++; c.delivered += r.delivery.delivered; c.on_time += r.delivery.on_time; c.overdue += r.delivery.overdue; c.original_ms += r.recorded_time.original_ms; c.revision_ms += r.recorded_time.revision_ms; }
    out.by_role = byRole;
    out.review_notes = rows.map((r) => ({ employee: r.employee.name, notes: [
      ...(r.attendance.unexplained_absence_days ? ['Discuss attendance: unexplained absences'] : []),
      ...(r.delivery.overdue ? ['Discuss workload / deadlines: late deliveries (check documented upstream delays first)'] : []),
      ...(r.blockers.length > 2 ? ['Repeated blockers: check whether support or training is needed'] : []),
      ...(r.warnings.length || r.gaps.length ? ['Data incomplete: confirm figures before any discussion'] : []),
    ] }));
  }
  return out;
}

export const DEFAULT_LAYOUT = { columns: { goal: true, delivered: true, days: true, time: false, late: false, titles: false }, compare: { enabled: true, against: 'previous' } };

export async function getReport(ctx) {
  const { env, url, now, emp } = ctx;
  if (emp.role === 'employee') throw forbidden();
  const kind = url.searchParams.get('kind') || 'weekly';
  let period = url.searchParams.get('period');
  if (!period) period = kind === 'weekly' ? addDays(weekStart(localDate(now)), -7) : prevPeriod('monthly', localDate(now).slice(0, 7));
  let range; try { range = periodRange(kind, period); } catch (e) { throw bad('bad_period', e.message); }
  const ids = await teamIds(ctx);
  const scope = emp.role === 'admin' ? 'all' : emp.id;
  const finished = localMidnightMs(addDays(range.to, 1)) <= now;
  // Always recomputed from source records so corrections show immediately; the stored snapshot is an archive.
  const layout = await getSetting(env.DB, 'report_layout', DEFAULT_LAYOUT);
  // The comparison with earlier periods is for the Owner only: managers and employees never get it.
  const wantCompare = emp.role === 'admin' && layout.compare?.enabled !== false;
  const rep = await buildReport(env, ids, kind, period, now, { comparison: wantCompare, against: layout.compare?.against });
  rep.layout = { columns: layout.columns || DEFAULT_LAYOUT.columns, compare: wantCompare ? { enabled: true, against: layout.compare?.against || 'previous' } : { enabled: false } };
  if (finished) {
    await env.DB.prepare('INSERT INTO report_snapshots(kind,period,scope,generated_at,body) VALUES (?,?,?,?,?) ON CONFLICT(kind,period,scope) DO UPDATE SET generated_at=excluded.generated_at,body=excluded.body')
      .bind(kind, period, scope, now, JSON.stringify(rep)).run();
  }
  return json(rep);
}

// Cron: store the just-finished week/month so reports exist without anyone asking.
export async function autoReports(env, now) {
  const on = await getSetting(env.DB, 'auto_reports', true);
  if (!on) return;
  const today = localDate(now);
  const lastWeek = addDays(weekStart(today), -7);
  const lastMonth = prevPeriod('monthly', today.slice(0, 7));
  const ids = (await env.DB.prepare("SELECT id FROM employees WHERE active=1").all()).results.map((r) => r.id);
  for (const [kind, period] of [['weekly', lastWeek], ['monthly', lastMonth]]) {
    const have = await env.DB.prepare("SELECT 1 FROM report_snapshots WHERE kind=? AND period=? AND scope='all'").bind(kind, period).first();
    if (have) continue;
    const rep = await buildReport(env, ids, kind, period, now);
    await env.DB.prepare("INSERT OR IGNORE INTO report_snapshots(kind,period,scope,generated_at,body) VALUES (?,?,'all',?,?)").bind(kind, period, now, JSON.stringify(rep)).run();
  }
}

// Employee's own goal summary. Never contains comparisons with earlier periods or anyone else's data.
export async function myReport(ctx) {
  const { env, emp, url, now } = ctx;
  const kind = url.searchParams.get('kind') === 'monthly' ? 'monthly' : 'weekly';
  const today = localDate(now);
  const period = kind === 'weekly' ? weekStart(today) : today.slice(0, 7);
  const trackJobs = (await getSetting(env.DB, 'created_tracking_jobs', [])).map((j) => String(j).toLowerCase());
  const goals = Object.fromEntries(Object.entries(await getSetting(env.DB, 'job_goals', {})).map(([k, v]) => [k.toLowerCase(), v]));
  const full = await employeeReport(env, { id: emp.id, name: emp.name, job_role: emp.job_role, clickup_user_id: emp.clickup_user_id }, kind, period, now, await statusMap(env.DB, emp.job_role), trackJobs, goals);
  const { from, to } = periodRange(kind, period);
  const deps = (await env.DB.prepare('SELECT created_at FROM deposits WHERE employee_id=? AND created_at>=? AND created_at<?').bind(emp.id, localMidnightMs(from), localMidnightMs(addDays(to, 1))).all()).results;
  const att = (await env.DB.prepare('SELECT id,check_in_at,check_out_at,status FROM attendance WHERE employee_id=? AND check_in_at>=? AND check_in_at<? ORDER BY check_in_at DESC').bind(emp.id, localMidnightMs(from), localMidnightMs(addDays(to, 1))).all()).results;
  const pend = (await env.DB.prepare("SELECT attendance_id,status FROM correction_requests WHERE employee_id=? AND status='pending'").bind(emp.id).all()).results;
  return json({
    kind, period, range: { from, to }, incomplete_period: full.incomplete_period,
    goal: full.goal, days_present: full.attendance.present_days, days_scheduled: full.attendance.scheduled_days,
    recorded_ms: full.recorded_time.original_ms + full.recorded_time.revision_ms, updates: deps.length,
    tasks_done: full.delivery.tasks.map((t) => ({ task_id: t.task_id, name: t.name, url: t.url, delivered_at: t.delivered_at })),
    created: full.created ? { total: full.created.total, by_code: full.created.by_code } : null,
    attendance: att.map((a) => ({ id: a.id, check_in_at: a.check_in_at, check_out_at: a.check_out_at, status: a.status, updates: deps.filter((d) => localDate(d.created_at) === localDate(a.check_in_at)).length, correction_pending: pend.some((p) => p.attendance_id === a.id) })),
    note: 'Recorded task time is time on a task while clocked in. It is not a measure of effort or quality.',
  });
}
