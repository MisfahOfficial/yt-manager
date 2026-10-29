import { h, get, post, syncUntilDone, checkView, checksSection, field, dialog, busy, announce, chip, empty, errBox, fmtTime, fmtDate, fmtDateTime, fmtDur, toInput, fromInput, todayYmd } from './core.js';

const ATT = { checked_in: ['Clocked in', 'ok'], done_for_today: ['Done for today', ''], not_in: ['Not in yet', 'warn'], missing_checkout: ['Missing clock-out', 'bad'] };
const short = (s, n = 90) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

// ---------------------------------------------------------------- TEAM
export async function teamPage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let t, hl, devs = null;
  try { [t, hl] = await Promise.all([get('/api/team'), get('/api/admin/clickup/health')]); if (me.role === 'admin') devs = (await get('/api/admin/devices')).devices.filter((d) => d.status === 'pending'); }
  catch (e) { root.replaceChildren(errBox(e)); return; }
  const stale = hl.stale || hl.last_error;
  const sync = h('section', { class: 'card slim' }, h('div', { class: 'row between' },
    h('div', {}, h('strong', {}, 'ClickUp: '), hl.connected ? (hl.last_ok_ms ? `updated ${fmtDateTime(hl.last_ok_ms)}` : 'never updated') : 'not connected', ' ', stale ? chip(hl.last_error ? 'Problem' : 'Out of date', 'warn') : chip('Up to date', 'ok'), hl.last_error ? h('div', { class: 'warn-text small' }, hl.last_error) : null),
    (() => { const b = h('button', { class: 'btn small', type: 'button' }, 'Sync now'); b.addEventListener('click', busy(b, async () => { try { const r = await syncUntilDone((p) => announce(`Updating… (${p * 100} tasks)`)); announce(r.ok ? 'ClickUp updated ✓' : r.error || 'Not finished', r.ok ? 'ok' : 'err'); teamPage(root, me); } catch (e) { announce(e.message, 'err'); } })); return b; })()));
  const out = [sync];
  if (devs?.length) out.push(h('div', { class: 'warnbox' }, `${devs.length} computer${devs.length > 1 ? 's' : ''} waiting for approval · `, h('a', { href: '#people' }, 'Review')));
  const card = h('section', { class: 'card' }, h('h2', {}, 'Team'));
  if (!t.people.length) card.append(empty('No team members yet.'));
  for (const p of t.people) {
    const [label, kind] = ATT[p.attendance];
    const open = p.active_task?.id || p.latest_update?.task_id;
    const btn = open ? h('a', { class: 'btn small', href: '#task/' + encodeURIComponent(open) }, 'Open') : null;
    card.append(h('div', { class: 'item row between' }, h('div', {},
      h('div', {}, h('strong', {}, p.name), ' ', chip(label, kind), p.job_role ? h('span', { class: 'muted small' }, ' ' + p.job_role) : null),
      p.active_task ? h('div', { class: 'small' }, p.active_task.name || p.active_task.id, p.active_task.kind === 'revision' ? ' (revision)' : '', p.active_task.due_ms ? h('span', { class: 'muted' }, ` · due ${fmtDate(p.active_task.due_ms)}`) : null)
        : h('div', { class: 'small muted' }, p.clickup_linked ? 'No timed task' : 'Not linked to ClickUp'),
      p.latest_update ? h('div', { class: 'small muted' }, `“${short(p.latest_update.text)}” · ${fmtDateTime(p.latest_update.at)}`) : null,
      p.missing_submission ? h('div', { class: 'small warn-text' }, 'No update yet today') : null,
      p.blockers.length ? h('div', { class: 'small' }, chip('Blocked', 'warn'), ' ', p.blockers.map((b) => h('a', { class: 'tag', href: '#task/' + encodeURIComponent(b.id) }, b.name))) : null), btn));
  }
  out.push(card);
  const chk = h('details', { class: 'card' }, h('summary', {}, 'Script & title checks'));
  checksSection('', () => teamPage(root, me)).then((c) => { c.querySelector('h2')?.remove(); chk.append(...c.childNodes); });
  out.push(chk);
  root.replaceChildren(...out);
}

// ---------------------------------------------------------------- TASK DETAIL (one place for everything about a task)
export async function taskPage(root, me, id) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let d; try { d = await get('/api/tasks/' + encodeURIComponent(id)); } catch (e) { root.replaceChildren(h('p', {}, h('a', { href: '#team' }, '‹ Team')), errBox(e)); return; }
  const tab = taskPage.tab || 'work';
  const f = d.facts, t = d.task;
  const fact = (l, v) => h('div', { class: 'fact' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v));
  const head = h('section', { class: 'card' }, h('div', { class: 'row between' }, h('div', {}, h('h2', { style: null }, t.name),
    h('div', { class: 'muted small' }, d.assignees.map((a) => a.name).join(', ') || 'Nobody assigned', ' · ', t.url ? h('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in ClickUp') : null)), chip(t.status || '', 'ok')),
    h('div', { class: 'facts' }, fact('Deadline', f.deadline_ms ? fmtDate(f.deadline_ms) : 'None'), fact('Ready for Upload', f.first_ready_ms ? fmtDate(f.first_ready_ms) : 'Not yet'), fact('Time on task', fmtDur(f.original_ms + f.revision_ms)), fact('Last update', f.last_update_ms ? fmtDateTime(f.last_update_ms) : 'None')),
    h('div', { class: 'row', style: null }, (() => { const b = h('button', { class: 'btn small', type: 'button' }, 'Request changes'); b.addEventListener('click', () => changesDialog({ task_id: id }, () => taskPage(root, me, id))); return b; })()));
  const tabs = h('div', { class: 'tabs' }, [['work', 'Work'], ['time', 'Time'], ['hist', 'History']].map(([k, l]) => { const b = h('button', { class: 'btn' + (tab === k ? ' on' : ''), type: 'button' }, l); b.addEventListener('click', () => { taskPage.tab = k; taskPage(root, me, id); }); return b; }));
  const body = h('section', { class: 'card' });
  if (tab === 'work') {
    if (!d.submissions.length) body.append(empty('No updates yet.'));
    for (const s of d.submissions) body.append(h('div', { class: 'sub' }, h('div', { class: 'row between' }, h('strong', {}, `${s.employee} · ${fmtDateTime(s.created_at)}`), chip(s.review_note ? 'Reviewed' : 'Not reviewed')),
      h('div', {}, s.completed), s.pending ? h('div', { class: 'small muted' }, 'Left: ' + s.pending) : null,
      h('div', { class: 'row' }, h('a', { href: s.link, target: '_blank', rel: 'noopener noreferrer' }, 'Project link'), (() => { const b = h('button', { class: 'btn small', type: 'button' }, s.review_note ? 'Edit note' : 'Add note'); b.addEventListener('click', () => noteDialog(s, () => taskPage(root, me, id))); return b; })()),
      s.review_note ? h('div', { class: 'note' }, s.review_note) : null, checkView(s.check_json, s.id, () => taskPage(root, me, id))));
  } else if (tab === 'time') {
    if (!d.time_by_day.length) body.append(empty('No recorded time yet.'));
    else body.append(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Day', 'On the task', ''].map((x) => h('th', {}, x)))), h('tbody', {}, d.time_by_day.map((r) => h('tr', {}, h('td', {}, fmtDate(Date.parse(r.date + 'T00:00:00Z') - 5 * 3600000 + 12 * 3600000)), h('td', {}, fmtDur(r.original_ms + r.revision_ms)), h('td', { class: 'muted small' }, r.revision_ms ? `incl. ${fmtDur(r.revision_ms)} revision` : '')))),
      h('tfoot', {}, h('tr', {}, h('th', {}, 'Total'), h('th', {}, fmtDur(f.original_ms + f.revision_ms)), h('th', {}, f.revision_ms ? `Revision ${fmtDur(f.revision_ms)}` : ''))))), h('p', { class: 'muted small' }, 'Only while clocked in and the task was In Progress.'));
  } else {
    if (!d.story.length) body.append(empty('Nothing yet.'));
    for (const s of d.story) body.append(h('div', { class: 'item row between' }, h('span', {}, s.text, s.to_ms ? ` ${s.from_ms ? fmtDate(s.from_ms) + ' → ' : ''}${fmtDate(s.to_ms)}` : '', s.before_due === true ? h('span', { class: 'muted small' }, ' (before it was due)') : s.before_due === false ? h('span', { class: 'warn-text small' }, ' (after it was due)') : null, s.note ? h('span', { class: 'muted small' }, ` “${short(s.note)}”`) : null), h('span', { class: 'muted small' }, fmtDateTime(s.at))));
  }
  root.replaceChildren(h('p', {}, h('a', { href: '#team' }, '‹ Team')), head, tabs, body);
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


// ---------------------------------------------------------------- REPORTS (Owner customises; comparison is Owner only)
const PK = 5 * 3600000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const addD = (s, n) => ymd(Date.parse(s + 'T00:00:00Z') + n * 86400000);
const mondayOf = (s) => addD(s, -((new Date(s + 'T00:00:00Z').getUTCDay() + 6) % 7));
const COLS = [['goal', 'Goal achieved'], ['delivered', 'Tasks delivered'], ['days', 'Days present'], ['time', 'Recorded time'], ['late', 'Late arrivals'], ['titles', 'Titles created']];

export async function reportsPage(root, me) {
  const st = reportsPage.st ||= { kind: 'weekly', period: addD(mondayOf(todayYmd()), -7) };
  const tabs = h('div', { class: 'tabs', style: null }, ['weekly', 'monthly'].map((k) => {
    const b = h('button', { class: 'btn' + (st.kind === k ? ' on' : ''), type: 'button' }, k === 'weekly' ? 'Weekly' : 'Monthly');
    b.addEventListener('click', () => { st.kind = k; st.period = k === 'weekly' ? addD(mondayOf(todayYmd()), -7) : addD(todayYmd().slice(0, 8) + '01', -1).slice(0, 7); reportsPage(root, me); });
    return b;
  }));
  const step = (n) => { st.period = st.kind === 'weekly' ? addD(st.period, 7 * n) : (() => { const [y, m] = st.period.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); })(); reportsPage(root, me); };
  const nav = h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', 'aria-label': 'Previous period', onclick: () => step(-1) }, '‹'), h('strong', {}, st.kind === 'weekly' ? `Week of ${st.period}` : st.period), h('button', { class: 'btn small', type: 'button', 'aria-label': 'Next period', onclick: () => step(1) }, '›'));
  const bar = h('section', { class: 'card slim row between' }, tabs, nav);
  root.replaceChildren(bar, h('p', { class: 'muted' }, 'Building report…'));
  let r; try { r = await get(`/api/reports?kind=${st.kind}&period=${st.period}`); } catch (e) { root.replaceChildren(bar, errBox(e)); return; }
  const owner = me.role === 'admin';
  const L = r.layout;
  const cols = COLS.filter(([k]) => L.columns[k]);
  const cmp = L.compare?.enabled;
  const cell = (e, k) => k === 'goal' ? (e.goal ? h('div', { class: 'row' }, h('span', { class: 'pct' }, `${e.goal.pct}%`), h('div', { class: 'bar sm' }, h('i', { class: 'w' + Math.min(100, e.goal.pct) }))) : '–')
    : k === 'delivered' ? `${e.delivery.delivered}` : k === 'days' ? `${e.attendance.present_days} of ${e.attendance.scheduled_days}` : k === 'time' ? fmtDur(e.recorded_time.original_ms + e.recorded_time.revision_ms)
    : k === 'late' ? `${e.attendance.late_arrivals}${e.attendance.late_minutes ? ` (${e.attendance.late_minutes} min)` : ''}` : (e.created ? String(e.created.total) : '–');
  const delta = (c) => { if (!c) return '–'; const n = c.goal_pct_delta ?? null; const d = c.delivered_delta; const s = `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)} task${Math.abs(d) === 1 ? '' : 's'}${n != null ? ` · ${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}%` : ''}`; return h('span', { class: d > 0 ? 'up' : d < 0 ? 'down' : '' }, d === 0 && !n ? 'same' : s); };
  const body = [];
  if (r.incomplete_period) body.push(h('div', { class: 'warnbox' }, 'This period is not finished yet. Numbers are partial.'));
  const top = h('section', { class: 'card' }, h('div', { class: 'row between' }, h('h2', { style: null }, 'Team results'),
    owner ? h('span', { class: 'row' }, cmp ? chip(`Owner view · compared with ${r.previous?.label || 'the previous period'}`, 'owner') : chip('Owner view', 'owner'), (() => { const b = h('button', { class: 'btn small', type: 'button' }, 'Customise reports'); b.addEventListener('click', () => customiseDialog(L, () => reportsPage(root, me))); return b; })()) : h('span', { class: 'muted small' }, 'Set up by the Owner')));
  top.append(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, [h('th', {}, 'Person'), ...cols.map(([, l]) => h('th', {}, l)), cmp ? h('th', {}, 'Compared') : null])),
    h('tbody', {}, r.employees.map((e) => h('tr', {}, h('td', {}, h('strong', {}, e.employee.name), h('div', { class: 'muted small' }, e.employee.job_role || '')), ...cols.map(([k]) => h('td', {}, cell(e, k))), cmp ? h('td', {}, delta(e.comparison)) : null))))));
  top.append(h('p', { class: 'muted small' }, 'Goal = the weekly target the Owner set for each job. Shifts and task size differ, so this is not a ranking.'));
  body.push(top);
  const need = r.employees.flatMap((e) => e.attention.map((a) => `${e.employee.name}: ${a}`));
  body.push(h('section', { class: 'card' }, h('h2', {}, 'Needs your attention'), need.length ? h('ul', {}, need.map((n) => h('li', {}, n))) : empty('Nothing flagged.')));
  for (const e of r.employees) body.push(employeeBlock(e, r.kind));
  if (r.kind === 'monthly') {
    if (r.by_role) body.push(h('section', { class: 'card' }, h('h2', {}, 'By job'), h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Job', 'People', 'Finished', 'On time / late', 'Original time', 'Revision time'].map((x) => h('th', {}, x)))), h('tbody', {}, Object.entries(r.by_role).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, String(v.people)), h('td', {}, String(v.delivered)), h('td', {}, `${v.on_time} / ${v.overdue}`), h('td', {}, fmtDur(v.original_ms)), h('td', {}, fmtDur(v.revision_ms)))))))));
    if (r.repeated_blockers?.length) body.push(h('section', { class: 'card' }, h('h2', {}, 'Repeated blockers'), h('ul', {}, r.repeated_blockers.map((b) => h('li', {}, `Task ${b.task_id}: blocked ${b.times} times`)))));
  }
  body.push(h('p', { class: 'muted small' }, r.notes.join(' '), ` Generated ${fmtDateTime(r.generated_at)}.`));
  root.replaceChildren(bar, ...body);
}

function customiseDialog(L, done) {
  const boxes = COLS.map(([k, l]) => ({ k, el: h('input', { type: 'checkbox', checked: !!L.columns[k] }), l }));
  const cmpOn = h('input', { type: 'checkbox', checked: !!L.compare?.enabled });
  const against = h('select', {}, [['previous', 'the previous period'], ['same_week_last_month', 'the same week last month (weekly only)']].map(([v, l]) => h('option', { value: v, selected: v === (L.compare?.against || 'previous') }, l)));
  const goalsBox = h('div', { class: 'row' });
  const gin = {};
  get('/api/admin/settings').then((r) => {
    const goals = r.settings.job_goals || {};
    const jobs = new Set(['Editor', 'Writer', 'Designer', 'Title finder', ...Object.keys(goals).map((j) => j.replace(/^./, (c) => c.toUpperCase()))]);
    for (const j of jobs) { const i = h('input', { type: 'number', min: 0, value: goals[j.toLowerCase()] ?? '' }); gin[j] = i; goalsBox.append(h('label', { class: 'field grow' }, h('span', { class: 'lbl small' }, j), i)); }
  }).catch(() => {});
  const body = h('div', { class: 'stack' }, h('strong', {}, 'Columns managers see'), ...boxes.map((b) => h('label', { class: 'check' }, b.el, ' ' + b.l)),
    h('div', { class: 'subbox' }, h('strong', {}, 'Comparison (Owner only)'), h('label', { class: 'check' }, cmpOn, ' Show comparison with an earlier period'), field('Compare with', against)),
    h('div', { class: 'subbox' }, h('strong', {}, 'Weekly goal per job'), h('div', { class: 'muted small' }, 'Tasks delivered per week (titles created for title finders). Empty = no goal.'), goalsBox));
  dialog('Customise reports', body, (close) => {
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    save.addEventListener('click', busy(save, async () => {
      try {
        const goals = {}; for (const [j, i] of Object.entries(gin)) if (i.value !== '') goals[j.toLowerCase()] = +i.value;
        await post('/api/admin/settings', { report_layout: { columns: Object.fromEntries(boxes.map((b) => [b.k, b.el.checked])), compare: { enabled: cmpOn.checked, against: against.value } }, job_goals: goals });
        announce('Reports updated ✓'); close(); done();
      } catch (e) { announce(e.message, 'err'); }
    }));
    return [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), save];
  });
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
    e.created ? h('div', {}, h('strong', {}, 'Tasks created (titles / ideas)'), h('p', {}, `${e.created.total} created` + (Object.keys(e.created.by_code).length ? ': ' + Object.entries(e.created.by_code).sort().map(([k, v]) => `${k} ${v}`).join(', ') : '')),
      e.created.days.length ? h('p', { class: 'muted small' }, 'Per day: ' + e.created.days.map((d) => `${d.date.slice(5)}: ${d.count}`).join(' · ')) : null,
      e.created.no_code.length ? h('div', { class: 'warnbox' }, 'No channel code: ', e.created.no_code.map((t) => h('a', { class: 'tag', href: t.url || '#', target: '_blank', rel: 'noopener noreferrer' }, t.name))) : null,
      e.created.duplicates.length ? h('div', { class: 'warnbox' }, 'May repeat an existing title: ', e.created.duplicates.map((t) => h('a', { class: 'tag', href: t.url || '#', target: '_blank', rel: 'noopener noreferrer' }, t.name))) : null,
      h('p', { class: 'muted small' }, e.created.note)) : null,
    e.script_checks && (e.script_checks.checked || e.script_checks.unavailable) ? h('div', {}, h('strong', {}, 'Script checks'), h('p', {}, `${e.script_checks.passed} of ${e.script_checks.checked} script(s) passed all checks` + (e.script_checks.unavailable ? ` (${e.script_checks.unavailable} could not be read: private or not a Google Doc)` : '')),
      h('ul', {}, Object.entries(e.script_checks.by_rule).map(([k, v]) => h('li', {}, `${k}: ${v.passed} of ${v.total}`))),
      e.script_checks.failing.length ? h('ul', {}, e.script_checks.failing.map((f) => h('li', {}, h('a', { href: f.link, target: '_blank', rel: 'noopener noreferrer' }, 'Script'), ' — missing: ' + f.missing.join(', ')))) : null) : null,
    e.blockers.length ? h('div', {}, h('strong', {}, 'Blockers'), h('ul', {}, e.blockers.map((b) => h('li', {}, `${b.name || b.task_id}: ${fmtDur(b.ms)} — ${b.reason}`)))) : null,
    e.gaps.length ? h('div', {}, h('strong', {}, 'Missing ClickUp history'), h('ul', {}, e.gaps.map((g) => h('li', {}, `${g.name || g.task_id}: ${g.reason}`)))) : null,
    h('details', {}, h('summary', {}, 'Day by day'), h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, a.days.map((x) => h('tr', {}, h('td', {}, x.date), h('td', {}, x.status === 'absent' ? chip('Absent', 'bad') : 'Present'), h('td', {}, x.late_min ? `Late ${x.late_min} min` : ''), h('td', {}, x.early_min ? `Left ${x.early_min} min early` : ''), h('td', {}, x.missing_checkout ? chip('Missing check-out', 'bad') : '')))))))); }


// ---------------------------------------------------------------- CORRECTIONS (requests to decide + missing clock-outs)
export async function fixesPage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let reqs, att, team;
  try { [reqs, att, team] = await Promise.all([get('/api/correction-requests?status=pending').then((r) => r.requests), get('/api/attendance?days=30').then((r) => r.attendance), get('/api/team')]); }
  catch (e) { root.replaceChildren(errBox(e)); return; }
  const canFix = me.role === 'admin' || me.can_correct;
  const reload = () => fixesPage(root, me);
  const card = h('section', { class: 'card' }, h('h2', {}, 'Corrections'));
  const mine = reqs.filter((r) => r.employee_id === me.id);
  const theirs = reqs.filter((r) => r.employee_id !== me.id);
  if (me.role === 'manager') card.append(h('p', { class: 'muted small' }, 'Your own records are changed by the Owner only.'));
  if (mine.length && me.role !== 'admin') card.append(h('div', { class: 'warnbox' }, 'Your request is waiting for the Owner.'));
  for (const q of theirs) {
    const dec = q.can_decide;
    card.append(h('div', { class: 'item row between' }, h('div', {}, h('strong', {}, q.employee), q.employee_role === 'manager' ? chip('Manager') : null, ` asks to change ${fmtDate(q.check_in_at)} `, chip('Waiting', 'warn'),
      h('div', { class: 'small muted' }, `${q.req_check_out ? `Clock-out ${q.check_out_at ? fmtTime(q.check_out_at) : 'missing'} → ${fmtTime(q.req_check_out)}` : ''}${q.req_check_in ? ` Clock-in ${fmtTime(q.check_in_at)} → ${fmtTime(q.req_check_in)}` : ''} · “${q.reason}”`)),
      dec ? h('span', { class: 'row' }, (() => { const b = h('button', { class: 'btn small', type: 'button' }, 'Decline'); b.addEventListener('click', busy(b, async () => { try { await post(`/api/correction-requests/${q.id}/decide`, { approve: false }); announce('Declined'); reload(); } catch (e) { announce(e.message, 'err'); } })); return b; })(),
        (() => { const b = h('button', { class: 'btn small primary', type: 'button' }, 'Review'); b.addEventListener('click', () => reviewDialog(q, reload)); return b; })()) : h('span', { class: 'muted small' }, 'Owner decides')));
  }
  const rows = att.filter((a) => a.status === 'missing_checkout' && !reqs.some((q) => q.attendance_id === a.id));
  for (const a of rows) {
    const mineRec = a.employee_id === me.id;
    card.append(h('div', { class: 'item row between' }, h('div', {}, h('strong', {}, a.employee), ` · ${fmtDate(a.check_in_at)} `, chip('Missing clock-out', 'bad'), h('div', { class: 'small muted' }, `Clocked in ${fmtTime(a.check_in_at)}`)),
      !canFix || (mineRec && me.role !== 'admin') ? h('span', { class: 'muted small' }, mineRec ? 'Ask the Owner' : '') : h('span', { class: 'row' },
        (() => { const b = h('button', { class: 'btn small', type: 'button' }, 'Ask ' + a.employee.split(' ')[0]); b.addEventListener('click', busy(b, async () => { try { await post(`/api/attendance/${a.id}/ask`); announce('Asked ✓'); reload(); } catch (e) { announce(e.message, 'err'); } })); return b; })(),
        (() => { const b = h('button', { class: 'btn small primary', type: 'button' }, 'Set time'); b.addEventListener('click', () => correctDialog(a, reload)); return b; })())));
  }
  if (!theirs.length && !rows.length) card.append(empty('Nothing to fix.'));
  const all = h('details', { class: 'card' }, h('summary', {}, 'All attendance (30 days)'));
  all.append(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Who', 'Day', 'In', 'Out', '', ''].map((x) => h('th', {}, x)))), h('tbody', {}, att.map((a) => h('tr', {}, h('td', {}, a.employee), h('td', {}, fmtDate(a.check_in_at)), h('td', {}, fmtTime(a.check_in_at)), h('td', {}, a.check_out_at ? fmtTime(a.check_out_at) : '—'),
    h('td', {}, a.status === 'missing_checkout' ? chip('Missing', 'bad') : a.checkout_exception ? chip('Tech problem', 'warn') : a.corrected ? chip('Corrected') : null),
    h('td', {}, canFix && (a.employee_id !== me.id || me.role === 'admin') ? (() => { const b = h('button', { class: 'btn small', type: 'button' }, 'Correct'); b.addEventListener('click', () => correctDialog(a, reload)); return b; })() : null)))))));
  root.replaceChildren(card, all);
}
function reviewDialog(q, done) {
  const note = h('input', { type: 'text', placeholder: 'Optional' });
  const row = (l, a, b) => h('tr', {}, h('td', {}, l), h('td', {}, a), h('td', {}, h('strong', {}, b)));
  const body = h('div', { class: 'stack' }, h('table', {}, h('thead', {}, h('tr', {}, ['', 'Recorded', `${q.employee} asks`].map((x) => h('th', {}, x)))), h('tbody', {},
    row('Clock in', fmtTime(q.check_in_at), q.req_check_in ? fmtTime(q.req_check_in) : fmtTime(q.check_in_at)), row('Clock out', q.check_out_at ? fmtTime(q.check_out_at) : 'missing', q.req_check_out ? fmtTime(q.req_check_out) : q.check_out_at ? fmtTime(q.check_out_at) : 'missing'))),
    h('p', { class: 'muted small' }, `Reason: “${q.reason}”`), field('Note', note));
  dialog(`${q.employee} · ${fmtDate(q.check_in_at)}`, body, (close) => {
    const decide = (approve) => busy(approve ? ok : no, async () => { try { await post(`/api/correction-requests/${q.id}/decide`, { approve, note: note.value }); announce(approve ? 'Applied. Saved in the audit history' : 'Declined'); close(); done(); } catch (e) { announce(e.message, 'err'); } });
    const no = h('button', { class: 'btn', type: 'button' }, 'Decline');
    const ok = h('button', { class: 'btn go', type: 'button' }, 'Approve & apply');
    no.addEventListener('click', decide(false)); ok.addEventListener('click', decide(true));
    return [h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'), no, ok];
  });
}
function correctDialog(a, done) {
  const i = h('input', { type: 'datetime-local', value: toInput(a.check_in_at), required: true });
  const o = h('input', { type: 'datetime-local', value: a.check_out_at ? toInput(a.check_out_at) : '' });
  const why = h('input', { type: 'text', required: true, minlength: 5, maxlength: 500, placeholder: 'Why? (saved in the audit history)' });
  dialog(`${a.employee} · ${fmtDate(a.check_in_at)}`, h('div', { class: 'stack' }, field('Clock in', i), field('Clock out', o), field('Reason', why)), (close) => {
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    b.addEventListener('click', busy(b, async () => { try { await post(`/api/attendance/${a.id}/correct`, { check_in_at: fromInput(i.value), check_out_at: o.value ? fromInput(o.value) : null, reason: why.value }); announce('Saved ✓'); close(); done(); } catch (e) { announce(e.message, 'err'); } }));
    return [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), b];
  });
}
