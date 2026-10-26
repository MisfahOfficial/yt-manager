import { describe, it, expect } from 'vitest';
import { DEFAULT_STATUS_MAP, computeSessions, statusTimeline, deliveries, applicableDeadline, shiftWindows, intersect, normalize } from '../src/lib/timer.js';
import { localMidnightMs } from '../src/lib/time.js';

const H = 3600000, M = 60000;
const D = localMidnightMs('2026-10-26'); // Monday
const t = (h, m = 0) => D + h * H + m * M;
const ev = (id, task, at, to, extra = {}) => ({ id, task_id: task, kind: 'status', at_ms: at, to_val: to, source: 'webhook', ...extra });
const task = (id, events, assigned = [{ start: 0, end: Infinity }], now = t(20)) => ({
  id, timeline: statusTimeline(events), assigned, deliveredAt: deliveries(events).map((d) => d.at),
});
const WIN = [{ start: t(9), end: t(17) }];

describe('interval algebra', () => {
  it('normalizes and intersects', () => {
    expect(normalize([{ start: 5, end: 10 }, { start: 1, end: 6 }])).toEqual([{ start: 1, end: 10 }]);
    expect(intersect([{ start: 0, end: 10 }], [{ start: 5, end: 20 }])).toEqual([{ start: 5, end: 10 }]);
  });
});

describe('recorded time', () => {
  it('counts only the intersection of In Progress and attendance', () => {
    const T = task('a', [ev(1, 'a', t(8), 'In Progress')]);
    const r = computeSessions({ attendance: [{ start: t(10), end: t(12) }], windows: WIN, tasks: [T], now: t(20) });
    expect(r.sessions).toEqual([{ task_id: 'a', kind: 'original', start: t(10), end: t(12), reason: 'checkout' }]);
  });
  it('does not count In Progress outside attendance', () => {
    const T = task('a', [ev(1, 'a', t(8), 'In Progress')]);
    const r = computeSessions({ attendance: [], windows: WIN, tasks: [T], now: t(20) });
    expect(r.sessions).toEqual([]);
  });
  it('checkout pauses, next check-in resumes the same task automatically', () => {
    const T = task('a', [ev(1, 'a', t(9), 'In Progress')]);
    const r = computeSessions({ attendance: [{ start: t(9), end: t(11) }, { start: t(13), end: t(15) }], windows: WIN, tasks: [T], now: t(20) });
    expect(r.sessions.map((s) => [s.start, s.end])).toEqual([[t(9), t(11)], [t(13), t(15)]]);
  });
  it('Blocked pauses; Ready for Upload stops and records delivery', () => {
    const E = [ev(1, 'a', t(9), 'In Progress'), ev(2, 'a', t(10), 'Blocked'), ev(3, 'a', t(11), 'In Progress'), ev(4, 'a', t(13), 'Ready for Upload')];
    const r = computeSessions({ attendance: [{ start: t(9), end: t(17) }], windows: WIN, tasks: [task('a', E)], now: t(20) });
    expect(r.sessions.map((s) => [s.start, s.end, s.reason])).toEqual([[t(9), t(10), 'blocked'], [t(11), t(13), 'ready_for_upload']]);
    expect(deliveries(E)).toEqual([{ at: t(13), seq: 0, kind: 'original' }]);
  });
  it('does not count outside the approved window (early arrival / late stay)', () => {
    const T = task('a', [ev(1, 'a', t(7), 'In Progress')]);
    const r = computeSessions({ attendance: [{ start: t(8), end: t(19) }], windows: WIN, tasks: [T], now: t(20) });
    expect(r.sessions.map((s) => [s.start, s.end])).toEqual([[t(9), t(17)]]);
  });
  it('authorised overtime widens the window', () => {
    const T = task('a', [ev(1, 'a', t(7), 'In Progress')]);
    const r = computeSessions({ attendance: [{ start: t(9), end: t(19) }], windows: [...WIN, { start: t(17), end: t(18) }], tasks: [T], now: t(20) });
    expect(r.sessions.map((s) => [s.start, s.end])).toEqual([[t(9), t(18)]]);
  });
  it('open attendance gives an open session', () => {
    const T = task('a', [ev(1, 'a', t(9), 'In Progress')]);
    const r = computeSessions({ attendance: [{ start: t(9), end: t(12), open: true }], windows: WIN, tasks: [T], now: t(12) });
    expect(r.sessions[0].end).toBeNull();
  });
  it('unassigned employee gets no time', () => {
    const T = task('a', [ev(1, 'a', t(9), 'In Progress')], [{ start: t(11), end: Infinity }]);
    const r = computeSessions({ attendance: [{ start: t(9), end: t(12) }], windows: WIN, tasks: [T], now: t(20) });
    expect(r.sessions.map((s) => [s.start, s.end])).toEqual([[t(11), t(12)]]);
  });
});

describe('single active task', () => {
  it('two simultaneous In Progress: incumbent retained, no double count', () => {
    const A = task('a', [ev(1, 'a', t(9), 'In Progress')]);
    const B = task('b', [ev(2, 'b', t(10), 'In Progress')]);
    const r = computeSessions({ attendance: [{ start: t(9), end: t(12) }], windows: WIN, tasks: [A, B], now: t(20) });
    expect(r.sessions.map((s) => [s.task_id, s.start, s.end])).toEqual([['a', t(9), t(12)]]);
    const sum = r.sessions.reduce((n, s) => n + (s.end - s.start), 0);
    expect(sum).toBe(3 * H);
  });
  it('after incumbent leaves, remaining In Progress task takes over', () => {
    const A = task('a', [ev(1, 'a', t(9), 'In Progress'), ev(3, 'a', t(11), 'Blocked')]);
    const B = task('b', [ev(2, 'b', t(10), 'In Progress')]);
    const r = computeSessions({ attendance: [{ start: t(9), end: t(13) }], windows: WIN, tasks: [A, B], now: t(20) });
    expect(r.sessions.map((s) => [s.task_id, s.start, s.end])).toEqual([['a', t(9), t(11)], ['b', t(11), t(13)]]);
  });
  it('ambiguous at check-in: nothing counted until the employee chooses', () => {
    const A = task('a', [ev(1, 'a', t(8), 'In Progress')]);
    const B = task('b', [ev(2, 'b', t(8), 'In Progress')]);
    const none = computeSessions({ attendance: [{ start: t(9), end: t(12) }], windows: WIN, tasks: [A, B], now: t(20) });
    expect(none.sessions).toEqual([]);
    expect(none.ambiguous).toEqual([{ start: t(9), end: t(12), tasks: ['a', 'b'] }]);
    const chosen = computeSessions({ attendance: [{ start: t(9), end: t(12) }], windows: WIN, tasks: [A, B], choices: [{ task_id: 'b', at_ms: t(10) }], now: t(20) });
    expect(chosen.sessions.map((s) => [s.task_id, s.start, s.end])).toEqual([['b', t(10), t(12)]]);
    expect(chosen.ambiguous).toEqual([{ start: t(9), end: t(10), tasks: ['a', 'b'] }]);
  });
  it('a stale choice from an earlier tie does not override the incumbent', () => {
    const A = task('a', [ev(1, 'a', t(8), 'In Progress')]);
    const B = task('b', [ev(2, 'b', t(10), 'In Progress')]);
    const r = computeSessions({ attendance: [{ start: t(9), end: t(12) }], windows: WIN, tasks: [A, B], choices: [{ task_id: 'b', at_ms: t(8, 30) }], now: t(20) });
    expect(r.sessions.map((s) => s.task_id)).toEqual(['a']);
  });
});

describe('out-of-order and duplicate events', () => {
  it('uses ClickUp event time, not arrival order', () => {
    const late = [ev(5, 'a', t(11), 'Ready for Upload'), ev(1, 'a', t(9), 'In Progress')]; // delivered out of order
    const r = computeSessions({ attendance: [{ start: t(9), end: t(17) }], windows: WIN, tasks: [task('a', late)], now: t(20) });
    expect(r.sessions.map((s) => [s.start, s.end])).toEqual([[t(9), t(11)]]);
  });
  it('approx reconcile event opens an unverified gap that is never counted', () => {
    const E = [ev(1, 'a', t(12), 'In Progress', { source: 'reconcile', note: 'approx' })];
    const r = computeSessions({ attendance: [{ start: t(9), end: t(17) }], windows: WIN, tasks: [task('a', E)], now: t(20) });
    expect(r.sessions).toEqual([]);
  });
});

describe('revisions', () => {
  const E = [ev(1, 'a', t(9), 'In Progress'), ev(2, 'a', t(10), 'Ready for Upload'), ev(3, 'a', t(13), 'Revisions'), ev(4, 'a', t(15), 'Ready for Upload')];
  it('separates revision time and preserves the original delivery', () => {
    const r = computeSessions({ attendance: [{ start: t(9), end: t(17) }], windows: WIN, tasks: [task('a', E)], now: t(20) });
    expect(r.sessions.map((s) => [s.kind, s.start, s.end])).toEqual([['original', t(9), t(10)], ['revision', t(13), t(15)]]);
    expect(deliveries(E).map((d) => [d.kind, d.at])).toEqual([['original', t(10)], ['revision', t(15)]]);
  });
  it('revision pauses at checkout and resumes at next check-in', () => {
    const r = computeSessions({ attendance: [{ start: t(9), end: t(14) }, { start: t(14, 30), end: t(17) }], windows: WIN, tasks: [task('a', E)], now: t(20) });
    expect(r.sessions.filter((s) => s.kind === 'revision').map((s) => [s.start, s.end])).toEqual([[t(13), t(14)], [t(14, 30), t(15)]]);
  });
  it('In Progress after delivery without a Revisions status still counts as revision', () => {
    const F = [ev(1, 'a', t(9), 'In Progress'), ev(2, 'a', t(10), 'Ready for Upload'), ev(3, 'a', t(11), 'In Progress')];
    const r = computeSessions({ attendance: [{ start: t(9), end: t(17) }], windows: WIN, tasks: [task('a', F)], now: t(20) });
    expect(r.sessions.map((s) => s.kind)).toEqual(['original', 'revision']);
  });
});

describe('deadlines', () => {
  const due = (id, at, v) => ({ id, at_ms: at, to_val: v == null ? null : String(v) });
  it('extension made before the deadline passes is honoured', () => {
    expect(applicableDeadline([due(1, t(1), t(12)), due(2, t(10), t(18))]).deadline).toBe(t(18));
  });
  it('extension after a miss does not erase the miss', () => {
    const r = applicableDeadline([due(1, t(1), t(12)), due(2, t(14), t(18))]);
    expect(r.deadline).toBe(t(12));
    expect(r.extendedAfterMiss).toEqual([{ at: t(14), to: t(18) }]);
  });
});

describe('shift windows', () => {
  const day = { shift: { start_min: 9 * 60, end_min: 17 * 60, days_mask: 0b0011111 }, effective_from: '2026-01-01', effective_to: null };
  it('honours working days and leave', () => {
    const w = shiftWindows([day], [{ date_from: '2026-10-27', date_to: '2026-10-27' }], t(0), t(0) + 3 * 86400000);
    expect(w.map((x) => x.date)).toEqual(['2026-10-26', '2026-10-28']);
  });
  it('supports overnight shifts', () => {
    const night = { shift: { start_min: 22 * 60, end_min: 6 * 60, days_mask: 0b1111111 }, effective_from: '2026-01-01', effective_to: null };
    const [w] = shiftWindows([night], [], t(0), t(1));
    expect(w.end - w.start).toBe(8 * H);
  });
  it('uses each employee\'s own approved shift per effective date', () => {
    const early = { shift: { start_min: 9 * 60, end_min: 13 * 60, days_mask: 127 }, effective_from: '2026-01-01', effective_to: '2026-10-26' };
    const late = { shift: { start_min: 14 * 60, end_min: 20 * 60, days_mask: 127 }, effective_from: '2026-10-27', effective_to: null };
    const w = shiftWindows([early, late], [], t(0), t(0) + 2 * 86400000);
    expect(w.map((x) => [x.date, (x.end - x.start) / H])).toEqual([['2026-10-26', 4], ['2026-10-27', 6]]);
  });
});

describe('ignored statuses', () => {
  it('"payment done" after delivery neither undoes the delivery nor creates a new one', () => {
    const map = { ...DEFAULT_STATUS_MAP, 'payment done': 'ignore' };
    const E = [ev(1, 'a', t(9), 'In Progress'), ev(2, 'a', t(10), 'Ready for Upload'), ev(3, 'a', t(11), 'payment done'), ev(4, 'a', t(12), 'Uploaded')];
    expect(deliveries(E, map).map((d) => d.at)).toEqual([t(10)]);
    expect(statusTimeline(E, map).map((x) => x.status)).toEqual(['In Progress', 'Ready for Upload', 'Uploaded']); // payment done skipped
  });
});
