// Pure recorded-task-time engine. No I/O. Everything is [start, end) in epoch ms.
// recorded time = (task in an eligible status) ∩ (employee assigned) ∩ (checked in) ∩ (inside approved counting window)
// with at most ONE counted task at any instant.
import { localDate, localMidnightMs, addDays, dow } from './time.js';

export const DEFAULT_STATUS_MAP = {
  'in progress': 'active', 'editing': 'active',
  'revisions': 'revision', 'revision': 'revision', 'changes requested': 'revision',
  'blocked': 'paused', 'on hold': 'paused', 'waiting': 'paused',
  'ready for upload': 'done', 'ready to upload': 'done', 'ready to uploading': 'done', 'ready for uploading': 'done', 'rendered': 'done', 'delivered': 'done', 'complete': 'done', 'closed': 'done', 'uploaded': 'done',
};
export function classify(status, map = DEFAULT_STATUS_MAP) {
  if (status == null) return 'unknown';
  return map[String(status).trim().toLowerCase()] || 'other';
}

// ---------- interval algebra ----------
export function normalize(list) {
  const a = list.filter((i) => i.end > i.start).map((i) => ({ start: i.start, end: i.end })).sort((x, y) => x.start - y.start);
  const out = [];
  for (const i of a) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}
export function intersect(A, B) {
  A = normalize(A); B = normalize(B);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    const s = Math.max(A[i].start, B[j].start), e = Math.min(A[i].end, B[j].end);
    if (e > s) out.push({ start: s, end: e });
    if (A[i].end < B[j].end) i++; else j++;
  }
  return out;
}
export const total = (list) => normalize(list).reduce((n, i) => n + (i.end - i.start), 0);

// ---------- shift counting windows ----------
// assignments: [{shift:{start_min,end_min,days_mask}, effective_from, effective_to}]
// leaves: [{date_from,date_to}]
export function shiftWindows(assignments, leaves, fromMs, toMs) {
  const out = [];
  let d = addDays(localDate(fromMs), -1);
  const last = localDate(toMs);
  while (d <= last) {
    const a = assignments.find((x) => x.effective_from <= d && (!x.effective_to || d <= x.effective_to));
    const onLeave = leaves.some((l) => l.date_from <= d && d <= l.date_to);
    if (a && !onLeave && (a.shift.days_mask >> dow(d)) & 1) {
      const mid = localMidnightMs(d);
      const start = mid + a.shift.start_min * 60000;
      let end = mid + a.shift.end_min * 60000;
      if (a.shift.end_min <= a.shift.start_min) end += 86400000; // overnight
      if (end > fromMs && start < toMs) out.push({ start, end, date: d });
    }
    d = addDays(d, 1);
  }
  return out;
}

// ---------- status history ----------
// events: task_events rows for ONE task (any order). Returns class intervals; the last is open (end=null) until the next event.
// Reconcile-sourced "approx" events open an 'unverified' interval: never counted, reported as a gap.
export function statusTimeline(events, map = DEFAULT_STATUS_MAP) {
  const ev = events.filter((e) => e.kind === 'status' || e.kind === 'deleted' || e.kind === 'created')
    .slice().sort((a, b) => a.at_ms - b.at_ms || a.id - b.id);
  const out = [];
  for (const e of ev) {
    const cls = e.kind === 'deleted' ? 'deleted'
      : e.kind === 'created' ? classify(e.to_val, map)
      : (e.source === 'reconcile' && e.note === 'approx') ? 'unverified' : classify(e.to_val, map);
    const prev = out[out.length - 1];
    if (prev && prev.cls === cls && prev.status === e.to_val) continue;
    if (prev) prev.end = e.at_ms;
    out.push({ start: e.at_ms, end: null, cls, status: e.to_val });
  }
  return out;
}

// ---------- deliveries & deadlines ----------
export function deliveries(events, map = DEFAULT_STATUS_MAP) {
  const tl = statusTimeline(events, map);
  const out = [];
  let prevDone = false;
  for (const seg of tl) {
    const done = seg.cls === 'done';
    if (done && !prevDone) out.push({ at: seg.start, seq: out.length, kind: out.length === 0 ? 'original' : 'revision' });
    prevDone = done;
  }
  return out;
}
// Deadline in force when judging a delivery. A deadline change only counts if it was made BEFORE the
// deadline then in force had passed, so a late "extension" cannot erase an already-missed deadline.
export function applicableDeadline(dueChanges, asOfMs = Infinity) {
  const ch = dueChanges.slice().sort((a, b) => a.at_ms - b.at_ms || a.id - b.id);
  if (!ch.length) return { deadline: null, extendedAfterMiss: [] };
  let d = ch[0].to_val == null ? null : +ch[0].to_val;
  const late = [];
  for (const c of ch.slice(1)) {
    if (c.at_ms > asOfMs) break;
    const nv = c.to_val == null ? null : +c.to_val;
    if (d == null || c.at_ms <= d) d = nv; else late.push({ at: c.at_ms, to: nv });
  }
  return { deadline: d, original: ch[0].to_val == null ? null : +ch[0].to_val, extendedAfterMiss: late };
}

// ---------- core ----------
// input:
//  attendance: [{start,end}]          (end = now or effective end for open/missing-checkout)
//  windows:    [{start,end}]          counting windows (shift + authorised overtime)
//  tasks:      [{id, timeline:[{start,end,cls}], assigned:[{start,end}], deliveredAt:[ms]}]
//  choices:    [{task_id, at_ms}]     employee's explicit active-task picks
//  now
// output: { sessions:[{task_id,kind,start,end,reason}], ambiguous:[{start,end,tasks}] }
export function computeSessions({ attendance, windows, tasks, choices = [], now }) {
  const eligible = intersect(attendance, windows);
  const cand = []; // {task, kind, start, end}
  for (const t of tasks) {
    const asg = t.assigned;
    for (const seg of t.timeline) {
      if (seg.cls !== 'active' && seg.cls !== 'revision') continue;
      const end = seg.end == null ? now : seg.end;
      const base = intersect([{ start: seg.start, end }], asg);
      for (const piece of intersect(base, eligible)) {
        const deliveredBefore = (t.deliveredAt || []).some((d) => d <= piece.start);
        cand.push({ task: t.id, kind: seg.cls === 'revision' || deliveredBefore ? 'revision' : 'original', ...piece });
      }
    }
  }
  const cuts = new Set();
  for (const c of cand) { cuts.add(c.start); cuts.add(c.end); }
  for (const c of choices) cuts.add(c.at_ms);
  const pts = [...cuts].sort((a, b) => a - b);

  const segs = [];
  const ambiguous = [];
  let cur = null, tieStart = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const s = pts[i], e = pts[i + 1];
    const live = cand.filter((c) => c.start <= s && c.end >= e);
    const taskSet = [...new Set(live.map((c) => c.task))];
    if (taskSet.length === 0) { cur = null; tieStart = null; continue; }
    let pick = null;
    if (taskSet.length === 1) { pick = taskSet[0]; tieStart = null; }
    else {
      if (tieStart == null) { tieStart = s; if (!taskSet.includes(cur)) cur = null; }
      const ch = choices.filter((c) => c.at_ms >= tieStart && c.at_ms <= s && taskSet.includes(c.task_id))
        .sort((a, b) => b.at_ms - a.at_ms)[0];
      if (ch) pick = ch.task_id;
      else if (cur && taskSet.includes(cur)) pick = cur;
    }
    if (!pick) {
      cur = null;
      const last = ambiguous[ambiguous.length - 1];
      if (last && last.end === s) last.end = e; else ambiguous.push({ start: s, end: e, tasks: taskSet });
      continue;
    }
    cur = pick;
    const kind = live.find((c) => c.task === pick).kind;
    const last = segs[segs.length - 1];
    if (last && last.task_id === pick && last.kind === kind && last.end === s) last.end = e;
    else segs.push({ task_id: pick, kind, start: s, end: e });
  }

  const attEnds = new Set(attendance.map((a) => a.end));
  const winEnds = new Set(windows.map((w) => w.end));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const s of segs) {
    const tl = byId.get(s.task_id).timeline;
    const at = tl.find((x) => x.start === s.end);
    const taskEnded = !!at && at.cls !== 'active' && at.cls !== 'revision';
    const open = s.end >= now && attendance.some((a) => a.open) && !taskEnded;
    if (open) { s.reason = null; s.end = null; continue; }
    if (at && at.cls === 'done') s.reason = 'ready_for_upload';
    else if (at && at.cls === 'paused') s.reason = 'blocked';
    else if (at && at.cls === 'revision') s.reason = 'revision_requested';
    else if (attEnds.has(s.end)) s.reason = 'checkout';
    else if (winEnds.has(s.end)) s.reason = 'window_end';
    else if (at) s.reason = 'status_change';
    else s.reason = 'switched_or_unassigned';
  }
  return { sessions: segs, ambiguous, eligible };
}
