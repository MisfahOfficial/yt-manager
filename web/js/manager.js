import { h, get, post, syncUntilDone, checkView, checksSection, field, dialog, busy, announce, chip, empty, errBox, fmtTime, fmtDate, fmtDateTime, fmtDur, toInput, fromInput, todayYmd } from './core.js';
import { depositItem } from './staff.js';

const ATT = { checked_in: ['Checked in', 'ok'], done_for_today: ['Done for today', ''], not_in: ['Not in yet', 'warn'], missing_checkout: ['Missing check-out', 'bad'] };

export async function teamPage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let t, hl;
  try { [t, hl] = await Promise.all([get('/api/team'), get('/api/admin/clickup/health')]); } catch (e) { root.replaceChildren(errBox(e)); return; }
  const sync = h('section', { class: 'card slim' });
  const stale = hl.stale || hl.last_error;
  sync.append(h('div', { class: 'row between' },
    h('div', {}, h('strong', {}, 'ClickUp tasks: '), hl.connected ? (hl.last_ok_ms ? `updated ${fmtDateTime(hl.last_ok_ms)}` : 'never updated') : 'not connected', ' ', stale ? chip(hl.last_error ? 'Problem' : 'Out of date', 'warn') : chip('Up to date', 'ok'),
      hl.last_error ? h('div', { class: 'warn-text' }, hl.last_error) : null),
    (() => { const b = h('button', { class: 'btn', type: 'button' }, 'Sync now'); b.addEventListener('click', busy(b, async () => { try { const r = await syncUntilDone((p) => announce(`Updating from ClickUp… (${p * 100} tasks so far)`)); announce(r.ok ? 'ClickUp updated ✓' : r.error || 'Sync did not finish', r.ok ? 'ok' : 'err'); teamPage(root, me); } catch (e) { announce(e.message, 'err'); } })); return b; })()));
  const grid = h('div', { class: 'grid' });
  if (!t.people.length) grid.append(empty('No team members yet.'));
  for (const p of t.people) {
    const [label, kind] = ATT[p.attendance];
    grid.append(h('section', { class: 'card person' },
      h('div', { class: 'row between' }, h('h3', {}, p.name), chip(label, kind)),
      p.job_role ? h('p', { class: 'muted small' }, p.job_role) : null,
      p.since && p.attendance === 'checked_in' ? h('p', { class: 'muted' }, 'Since ' + fmtTime(p.since)) : null,
      p.active_task ? h('p', {}, 'Working on: ', h('a', { href: p.active_task.url || '#', target: '_blank', rel: 'noopener noreferrer' }, p.active_task.name || p.active_task.id), p.active_task.kind === 'revision' ? chip('Revision', 'warn') : null)
        : h('p', { class: 'muted' }, p.clickup_linked ? 'No timed task right now' : 'Not linked to ClickUp'),
      p.missing_submission ? h('p', { class: 'warn-text' }, 'No work deposit yet today') : null,
      p.blockers.length ? h('div', {}, h('strong', {}, 'Blocked: '), p.blockers.map((b) => h('a', { class: 'tag', href: b.url || '#', target: '_blank', rel: 'noopener noreferrer' }, b.name))) : null));
  }
  root.replaceChildren(sync, grid);
}

export async function submissionsPage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let r; try { r = await get('/api/submissions?days=14'); } catch (e) { root.replaceChildren(errBox(e)); return; }
  const card = h('section', { class: 'card' }, h('h2', {}, 'Work submissions'), h('p', { class: 'muted' }, 'A link is not proof of quality. Request changes only if something needs fixing.'));
  if (!r.submissions.length) card.append(empty('Nothing submitted in the last 14 days.'));
  for (const s of r.submissions) {
    const item = h('div', { class: 'item col' },
      h('div', {}, h('strong', {}, s.employee), ' · ', s.task_name ? h('a', { href: s.task_url || '#', target: '_blank', rel: 'noopener noreferrer' }, s.task_name) : h('span', {}, s.taskless_reason || 'No task'), ' ',
        h('span', { class: 'muted' }, fmtDateTime(s.created_at)), ' ', s.task_status ? chip(s.task_status) : null, s.is_complete ? chip('Finished', 'ok') : null),
      h('div', {}, s.completed), s.pending ? h('div', { class: 'muted' }, 'Pending: ' + s.pending) : null,
      h('a', { href: s.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open work link'),
      s.review_note ? h('div', { class: 'note' }, 'Note: ' + s.review_note) : null,
      checkView(s.check_json, s.id, () => submissionsPage(root, me)),
      (() => {
        const row = h('div', { class: 'row' });
        const note = h('button', { class: 'btn small', type: 'button' }, 'Add note');
        note.addEventListener('click', () => noteDialog(s, () => submissionsPage(root, me)));
        row.append(note);
        if (s.task_id) { const c = h('button', { class: 'btn small', type: 'button' }, 'Request changes'); c.addEventListener('click', () => changesDialog(s, () => submissionsPage(root, me))); row.append(c); }
        return row;
      })(),
      r.revisions.filter((v) => v.task_id === s.task_id).slice(0, 2).map((v) => h('div', { class: 'note' }, `Changes requested ${fmtDateTime(v.created_at)}: ${v.notes}`)));
    card.append(item);
  }
  root.replaceChildren(card, await checksSection('Scripts & titles: automatic checks', () => submissionsPage(root, me)));
}
function noteDialog(s, done) {
  const t = h('textarea', { rows: 3, maxlength: 1000, required: true });
  dialog('Add a note', field('Note (the employee will see it)', t), (close) => {
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Save note');
    b.addEventListener('click', busy(b, async () => { try { await post(`/api/deposits/${s.id}/note`, { note: t.value }); announce('Saved ✓'); close(); done(); } catch (e) { announce(e.message, 'err'); } }));
    return [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), b];
  });
}
function changesDialog(s, done) {
  const notes = h('textarea', { rows: 4, maxlength: 4000, required: true, placeholder: 'What needs to change?' });
  const links = h('input', { type: 'url', placeholder: 'Reference link (optional)' });
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'This is optional and does not block anyone. If ClickUp is connected, the task is moved to your Revisions status and the notes are added as a comment.'), field('Notes', notes), field('Reference link', links));
  dialog('Request changes', body, (close) => {
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Send request');
    b.addEventListener('click', busy(b, async () => {
      try {
        const r = await post(`/api/tasks/${encodeURIComponent(s.task_id)}/changes`, { notes: notes.value, links: links.value ? [links.value] : [] });
        announce(r.clickup === 'written' ? 'Requested ✓ and ClickUp updated' : r.clickup === 'skipped' ? 'Saved ✓ (ClickUp not updated: no Revisions status set)' : 'Saved ✓ but ClickUp was not updated. Change it there by hand.', r.clickup.startsWith('failed') ? 'err' : 'ok');
        close(); done();
      } catch (e) { announce(e.message, 'err'); }
    }));
    return [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), b];
  });
}

// ---------------- reports ----------------
const PK = 5 * 3600000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const addD = (s, n) => ymd(Date.parse(s + 'T00:00:00Z') + n * 86400000);
const mondayOf = (s) => addD(s, -((new Date(s + 'T00:00:00Z').getUTCDay() + 6) % 7));

export async function reportsPage(root, me) {
  const st = reportsPage.st ||= { kind: 'weekly', period: addD(mondayOf(todayYmd()), -7) };
  const bar = h('section', { class: 'card slim row between' });
  const tabs = h('div', { class: 'seg', role: 'tablist' }, ['weekly', 'monthly'].map((k) => {
    const b = h('button', { class: 'btn' + (st.kind === k ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': String(st.kind === k) }, k === 'weekly' ? 'Weekly' : 'Monthly');
    b.addEventListener('click', () => { st.kind = k; st.period = k === 'weekly' ? addD(mondayOf(todayYmd()), -7) : addD(todayYmd().slice(0, 8) + '01', -1).slice(0, 7); reportsPage(root, me); });
    return b;
  }));
  const step = (n) => { st.period = st.kind === 'weekly' ? addD(st.period, 7 * n) : (() => { const [y, m] = st.period.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); })(); reportsPage(root, me); };
  const label = st.kind === 'weekly' ? `Week of ${st.period}` : st.period;
  const refresh = h('button', { class: 'btn', type: 'button' }, 'Refresh');
  refresh.addEventListener('click', () => reportsPage(root, me));
  bar.append(tabs, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', 'aria-label': 'Previous period', onclick: () => step(-1) }, '‹'), h('strong', {}, label), h('button', { class: 'btn', type: 'button', 'aria-label': 'Next period', onclick: () => step(1) }, '›'), refresh));
  root.replaceChildren(bar, h('p', { class: 'muted' }, 'Building report…'));
  let r; try { r = await get(`/api/reports?kind=${st.kind}&period=${st.period}`); } catch (e) { root.replaceChildren(bar, errBox(e)); return; }
  const body = [];
  if (r.incomplete_period) body.push(h('div', { class: 'warnbox' }, 'This period is not finished yet. Numbers are partial.'));
  const T = r.totals;
  body.push(h('section', { class: 'card' }, h('h2', {}, 'Summary'), h('div', { class: 'stats' },
    stat('Present / scheduled', `${T.present_days} / ${T.scheduled_days}`), stat('Approved leave days', T.leave_days), stat('Unexplained absences', T.absent_days), stat('Late (minutes)', T.late_minutes),
    stat('Ready for Upload', T.delivered), stat('On time / late', `${T.on_time} / ${T.overdue}`), stat('Original editing time', fmtDur(T.original_ms)), stat('Revision time', fmtDur(T.revision_ms)))));
  const need = r.employees.flatMap((e) => e.attention.map((a) => `${e.employee.name}: ${a}`));
  body.push(h('section', { class: 'card' }, h('h2', {}, 'Needs your attention'), need.length ? h('ul', {}, need.map((n) => h('li', {}, n))) : empty('Nothing flagged.')));
  if (r.kind === 'monthly' && r.previous) body.push(h('section', { class: 'card' }, h('h2', {}, 'Compared with ' + r.previous.period), r.previous.comparable
    ? h('p', {}, `Present ${r.previous.totals.present_days}/${r.previous.totals.scheduled_days} days; Ready for Upload ${r.previous.totals.delivered}; on-time ${r.previous.totals.on_time}/${r.previous.totals.on_time + r.previous.totals.overdue}. ${r.previous.comparable_note}`)
    : h('p', { class: 'muted' }, r.previous.comparable_note)));
  for (const e of r.employees) body.push(employeeBlock(e, r.kind));
  if (r.kind === 'monthly') {
    if (r.repeated_blockers?.length) body.push(h('section', { class: 'card' }, h('h2', {}, 'Repeated blockers'), h('ul', {}, r.repeated_blockers.map((b) => h('li', {}, `Task ${b.task_id}: blocked ${b.times} times`)))));
    if (r.by_role) body.push(h('section', { class: 'card' }, h('h2', {}, 'By job'), h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Job', 'People', 'Finished', 'On time / late', 'Original time', 'Revision time'].map((x) => h('th', {}, x)))), h('tbody', {}, Object.entries(r.by_role).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, String(v.people)), h('td', {}, String(v.delivered)), h('td', {}, `${v.on_time} / ${v.overdue}`), h('td', {}, fmtDur(v.original_ms)), h('td', {}, fmtDur(v.revision_ms)))))))));
    body.push(h('section', { class: 'card' }, h('h2', {}, 'Review notes'), r.review_notes.map((n) => h('div', {}, h('strong', {}, n.employee), n.notes.length ? h('ul', {}, n.notes.map((x) => h('li', {}, x))) : h('p', { class: 'muted' }, 'Nothing to discuss from the data.')))));
  }
  body.push(h('p', { class: 'muted small' }, r.notes.join(' '), ` Generated ${fmtDateTime(r.generated_at)}.`));
  root.replaceChildren(bar, ...body);
}
const stat = (l, v) => h('div', { class: 'stat' }, h('div', { class: 'v' }, String(v)), h('div', { class: 'l' }, l));
function employeeBlock(e, kind) {
  const a = e.attendance, d = e.delivery;
  return h('details', { class: 'card emp' }, h('summary', {}, h('strong', {}, e.employee.name), e.employee.job_role ? ` (${e.employee.job_role})` : '', ` — ${a.present_days}/${a.scheduled_days} days, ${d.delivered} Ready for Upload`),
    e.warnings.map((w) => h('div', { class: 'warnbox' }, w)),
    h('div', { class: 'stats' }, stat('Leave days', a.approved_leave_days), stat('Unexplained absence', a.unexplained_absence_days), stat('Late arrivals', `${a.late_arrivals} (${a.late_minutes} min)`), stat('Early departures', `${a.early_departures} (${a.early_minutes} min)`),
      stat('Missing check-outs', a.missing_checkouts), stat('Corrected days', a.corrected_days), stat('Work deposits', e.deposits.count), stat('Days without deposit', e.deposits.missing_days),
      stat('On time / late', `${d.on_time} / ${d.overdue}` + (d.no_deadline ? ` (+${d.no_deadline} no deadline)` : '')), stat('Revision deliveries', d.revision_deliveries), stat('Original time', fmtDur(e.recorded_time.original_ms)), stat('Revision time', fmtDur(e.recorded_time.revision_ms))),
    h('p', { class: 'muted small' }, e.recorded_time.note + ' ' + d.label + '. On-time is measured against the deadline in force when it was due.'),
    d.tasks.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Task', 'Channel', 'Delivered', 'Deadline', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, d.tasks.map((t) => h('tr', {}, h('td', {}, h('a', { href: t.url || '#', target: '_blank', rel: 'noopener noreferrer' }, t.name || t.task_id)), h('td', {}, t.channel), h('td', {}, fmtDateTime(t.delivered_at)), h('td', {}, t.deadline ? fmtDateTime(t.deadline) : '—'),
        h('td', {}, t.on_time === true ? chip('On time', 'ok') : t.on_time === false ? chip('Late', 'bad') : chip('No deadline'), t.extended_after_miss ? chip('Extended after miss', 'warn') : null)))))) : null,
    e.script_checks && (e.script_checks.checked || e.script_checks.unavailable) ? h('div', {}, h('strong', {}, 'Script checks'), h('p', {}, `${e.script_checks.passed} of ${e.script_checks.checked} script(s) passed all checks` + (e.script_checks.unavailable ? ` (${e.script_checks.unavailable} could not be read: private or not a Google Doc)` : '')),
      h('ul', {}, Object.entries(e.script_checks.by_rule).map(([k, v]) => h('li', {}, `${k}: ${v.passed} of ${v.total}`))),
      e.script_checks.failing.length ? h('ul', {}, e.script_checks.failing.map((f) => h('li', {}, h('a', { href: f.link, target: '_blank', rel: 'noopener noreferrer' }, 'Script'), ' — missing: ' + f.missing.join(', ')))) : null) : null,
    e.blockers.length ? h('div', {}, h('strong', {}, 'Blockers'), h('ul', {}, e.blockers.map((b) => h('li', {}, `${b.name || b.task_id}: ${fmtDur(b.ms)} — ${b.reason}`)))) : null,
    e.gaps.length ? h('div', {}, h('strong', {}, 'Missing ClickUp history'), h('ul', {}, e.gaps.map((g) => h('li', {}, `${g.name || g.task_id}: ${g.reason}`)))) : null,
    h('details', {}, h('summary', {}, 'Day by day'), h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, a.days.map((x) => h('tr', {}, h('td', {}, x.date), h('td', {}, x.status === 'absent' ? chip('Absent', 'bad') : 'Present'), h('td', {}, x.late_min ? `Late ${x.late_min} min` : ''), h('td', {}, x.early_min ? `Left ${x.early_min} min early` : ''), h('td', {}, x.missing_checkout ? chip('Missing check-out', 'bad') : '')))))))); }

// ---------------- attendance fixes ----------------
export async function fixesPage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let r, team; try { [r, team] = await Promise.all([get('/api/attendance?days=30'), get('/api/team')]); } catch (e) { root.replaceChildren(errBox(e)); return; }
  const canFix = me.role === 'admin' || me.can_correct;
  const card = h('section', { class: 'card' }, h('h2', {}, 'Attendance'), canFix ? null : h('p', { class: 'muted' }, 'You can view attendance. Ask the owner if you need permission to correct it.'));
  if (canFix) { const add = h('button', { class: 'btn', type: 'button' }, 'Add a missing day'); add.addEventListener('click', () => addDialog(team.people, () => fixesPage(root, me))); card.append(add); }
  const rows = r.attendance.sort((a, b) => (b.status === 'missing_checkout') - (a.status === 'missing_checkout') || b.check_in_at - a.check_in_at);
  if (!rows.length) card.append(empty('No attendance in 30 days.'));
  else card.append(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Who', 'Day', 'In', 'Out', '', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((a) => h('tr', {},
    h('td', {}, a.employee), h('td', {}, fmtDate(a.check_in_at)), h('td', {}, fmtTime(a.check_in_at)), h('td', {}, a.check_out_at ? fmtTime(a.check_out_at) : '—'),
    h('td', {}, a.status === 'missing_checkout' ? chip('Missing check-out', 'bad') : a.checkout_exception ? chip('Tech problem', 'warn') : a.corrected ? chip('Corrected') : null),
    h('td', {}, canFix ? (() => { const b = h('button', { class: 'btn small', type: 'button' }, 'Correct'); b.addEventListener('click', () => correctDialog(a, () => fixesPage(root, me))); return b; })() : null)))))));
  root.replaceChildren(card);
}
function correctDialog(a, done) {
  const i = h('input', { type: 'datetime-local', value: toInput(a.check_in_at), required: true });
  const o = h('input', { type: 'datetime-local', value: a.check_out_at ? toInput(a.check_out_at) : '' });
  const why = h('input', { type: 'text', required: true, minlength: 5, maxlength: 500, placeholder: 'Why? (saved in the audit history)' });
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, `${a.employee}. Times are Pakistan time. The original values are kept in the audit history.`), field('Check-in', i), field('Check-out', o), field('Reason', why));
  dialog('Correct attendance', body, (close) => {
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Save correction');
    b.addEventListener('click', busy(b, async () => {
      try { await post(`/api/attendance/${a.id}/correct`, { check_in_at: fromInput(i.value), check_out_at: o.value ? fromInput(o.value) : null, reason: why.value }); announce('Correction saved ✓'); close(); done(); } catch (e) { announce(e.message, 'err'); }
    }));
    return [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), b];
  });
}
function addDialog(people, done) {
  const who = h('select', {}, people.map((p) => h('option', { value: p.id }, p.name)));
  const i = h('input', { type: 'datetime-local', required: true }), o = h('input', { type: 'datetime-local', required: true });
  const why = h('input', { type: 'text', required: true, minlength: 5, placeholder: 'Why? (saved in the audit history)' });
  dialog('Add a missing attendance record', h('div', { class: 'stack' }, field('Who', who), field('Check-in', i), field('Check-out', o), field('Reason', why)), (close) => {
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Add record');
    b.addEventListener('click', busy(b, async () => { try { await post('/api/attendance', { employee_id: who.value, check_in_at: fromInput(i.value), check_out_at: fromInput(o.value), reason: why.value }); announce('Added ✓'); close(); done(); } catch (e) { announce(e.message, 'err'); } }));
    return [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), b];
  });
}
