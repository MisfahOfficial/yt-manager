import { h, get, post, syncUntilDone, field, dialog, busy, announce, chip, empty, errBox, fmtDateTime, fmtTime, toInput, fromInput, todayYmd, ApiError } from './core.js';

// A home/office IPv6 address changes per device, so trust the whole /64 network instead of one address.
function v6to64(ip) {
  if (!ip.includes(':')) return ip;
  let [head, tail] = ip.split('::');
  const h1 = head ? head.split(':') : [], t1 = tail ? tail.split(':') : [];
  const groups = [...h1, ...Array(Math.max(0, 8 - h1.length - t1.length)).fill('0'), ...t1].map((g) => g.replace(/^0+(?=.)/, ''));
  return groups.slice(0, 4).join(':') + '::/64';
}
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const minToStr = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const strToMin = (s) => { const [a, b] = s.split(':').map(Number); return a * 60 + b; };
const cancelBtn = (close) => h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel');
function secretDialog(title, name, pw, email) {
  const box = h('input', { type: 'text', readonly: true, value: pw, class: 'mono', 'aria-label': 'Temporary password' });
  dialog(title, h('div', { class: 'stack' }, h('p', {}, `Give ${name} these sign-in details. The password is shown only once and they must choose a new one at first sign-in.`), email ? h('p', {}, 'Email (exactly as typed): ', h('strong', { class: 'mono' }, email)) : null, box), (close) => {
    const c = h('button', { class: 'btn', type: 'button' }, 'Copy');
    c.addEventListener('click', async () => { try { await navigator.clipboard.writeText(pw); announce('Copied'); } catch { box.select(); } });
    return [c, h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Done')];
  });
}

export async function peoplePage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let emps, shifts; try { [emps, shifts] = await Promise.all([get('/api/admin/employees').then((r) => r.employees), get('/api/admin/shifts').then((r) => r.shifts)]); } catch (e) { root.replaceChildren(errBox(e)); return; }
  const card = h('section', { class: 'card' }, h('div', { class: 'row between' }, h('h2', {}, 'People'),
    (() => { const b = h('button', { class: 'btn primary', type: 'button' }, 'Add person'); b.addEventListener('click', () => personDialog(null, emps, () => peoplePage(root, me))); return b; })()));
  const shiftName = (id) => shifts.find((s) => s.id === id)?.name || '—';
  card.append(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Access', 'Job', 'Computer', 'Shift', 'ClickUp', ''].map((x) => h('th', {}, x)))),
    h('tbody', {}, emps.map((e) => h('tr', { class: e.active ? '' : 'off' }, h('td', {}, h('strong', {}, e.name), h('div', { class: 'muted small' }, e.email)),
      h('td', {}, e.role === 'admin' ? 'Owner/Admin' : e.role === 'manager' ? 'Manager' : 'Employee', e.can_correct ? chip('Can correct') : null, !e.active ? chip('Inactive', 'warn') : null),
      h('td', {}, e.job_role || chip('Not set', 'warn')),
      h('td', {}, e.device === 'approved' ? chip('Approved', 'ok') : e.device === 'pending' ? chip('Waiting', 'warn') : chip('None')),
      h('td', {}, shiftName([...e.shifts].reverse().find((s) => !s.effective_to)?.shift_id)),
      h('td', {}, e.clickup_user_id ? chip('Linked', 'ok') : chip('Not linked', 'warn')),
      h('td', {}, (() => { const b = h('button', { class: 'btn small', type: 'button' }, 'Manage'); b.addEventListener('click', () => personDialog(e, emps, () => peoplePage(root, me), shifts)); return b; })())))))));
  root.replaceChildren(card);
}

async function personDialog(e, emps, done, shifts = []) {
  const isNew = !e;
  const name = h('input', { type: 'text', required: true, maxlength: 100, value: e?.name || '' });
  const email = h('input', { type: 'email', required: true, value: e?.email || '' });
  const jobRole = h('input', { type: 'text', list: 'jobroles', maxlength: 40, value: e?.job_role || '', placeholder: 'e.g. Editor, Writer, Designer, Title finder' });
  const jobList = h('datalist', { id: 'jobroles' }, ['Editor', 'Writer', 'Designer', 'Title finder', 'Voice-over', 'Uploader'].map((x) => h('option', { value: x })));
  const role = h('select', {}, [['employee', 'Employee'], ['manager', 'Manager'], ['admin', 'Owner/Admin']].map(([v, l]) => h('option', { value: v, selected: e?.role === v }, l)));
  const mgr = h('select', {}, h('option', { value: '' }, 'No manager'), emps.filter((x) => x.role !== 'employee' && x.id !== e?.id).map((x) => h('option', { value: x.id, selected: e?.manager_id === x.id }, x.name)));
  const canFix = h('input', { type: 'checkbox', checked: !!e?.can_correct });
  const active = h('input', { type: 'checkbox', checked: e ? e.active : true });
  const cu = h('input', { type: 'text', value: e?.clickup_user_id || '', placeholder: 'ClickUp user id', inputmode: 'numeric' });
  let members = []; try { const r = await get('/api/admin/clickup/members'); members = r.teams.flatMap((t) => t.members); } catch {}
  const cuPick = members.length ? h('select', {}, h('option', { value: '' }, 'Pick from ClickUp…'), members.map((m) => h('option', { value: m.id }, `${m.name} (${m.email})`))) : null;
  if (cuPick) cuPick.addEventListener('change', () => { if (cuPick.value) cu.value = cuPick.value; });
  const body = h('div', { class: 'stack' }, field('Name', name), field('Email (used to sign in)', email), field('Job (what they do)', jobRole, 'Decides how their ClickUp statuses are read.'), jobList, field('Access level', role), field('Manager', mgr),
    h('label', { class: 'check' }, canFix, ' May correct attendance (managers only)'),
    field('ClickUp account', cu, 'Links this person to their ClickUp tasks.'), cuPick, !isNew ? h('label', { class: 'check' }, active, ' Can sign in') : null);
  dialog(isNew ? 'Add person' : e.name, body, (close) => {
    const save = h('button', { class: 'btn primary', type: 'button' }, isNew ? 'Add' : 'Save');
    save.addEventListener('click', busy(save, async () => {
      try {
        const payload = { name: name.value, email: email.value, role: role.value, job_role: jobRole.value.trim() || null, manager_id: mgr.value || null, can_correct: canFix.checked, clickup_user_id: cu.value.trim() || null, active: active.checked };
        if (isNew) { const r = await post('/api/admin/employees', payload); close(); secretDialog('Person added', name.value, r.temp_password, email.value.trim().toLowerCase()); }
        else { await post('/api/admin/employees/' + e.id, payload); announce('Saved ✓'); close(); }
        done();
      } catch (er) { announce(er.message, 'err'); }
    }));
    const extra = [];
    if (!isNew) {
      const mk = (label, fn) => { const b = h('button', { class: 'btn small', type: 'button' }, label); b.addEventListener('click', () => fn()); return b; };
      extra.push(mk('Shift', () => shiftDialog(e, shifts, done)), mk('Leave', () => leaveDialog(e)), mk('Overtime', () => overtimeDialog(e)),
        mk('Reset password', async () => { if (!confirm(`Reset ${e.name}'s password? They will be signed out.`)) return; try { const r = await post(`/api/admin/employees/${e.id}/reset-password`); close(); secretDialog('Password reset', e.name, r.temp_password, e.email); } catch (er) { announce(er.message, 'err'); } }));
    }
    return [...extra, cancelBtn(close), save];
  });
}
function shiftDialog(e, shifts, done) {
  const sel = h('select', {}, shifts.map((s) => h('option', { value: s.id }, `${s.name} (${minToStr(s.start_min)}–${minToStr(s.end_min)})`)));
  const from = h('input', { type: 'date', value: todayYmd(), required: true });
  if (!shifts.length) { announce('Create a shift in Settings first.', 'err'); return; }
  dialog(`Shift for ${e.name}`, h('div', { class: 'stack' }, field('Approved shift', sel), field('Starts on', from, 'Earlier days keep their old shift.')), (close) => {
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    b.addEventListener('click', busy(b, async () => { try { await post(`/api/admin/employees/${e.id}/shift`, { shift_id: sel.value, effective_from: from.value }); announce('Shift saved ✓'); close(); done(); } catch (er) { announce(er.message, 'err'); } }));
    return [cancelBtn(close), b];
  });
}
function leaveDialog(e) {
  const a = h('input', { type: 'date', value: todayYmd(), required: true }), b = h('input', { type: 'date', value: todayYmd(), required: true }), r = h('input', { type: 'text', maxlength: 200, placeholder: 'e.g. Exam, sick' });
  dialog(`Approved leave for ${e.name}`, h('div', { class: 'stack' }, field('From', a), field('To (inclusive)', b), field('Reason', r)), (close) => {
    const s = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    s.addEventListener('click', busy(s, async () => { try { await post(`/api/admin/employees/${e.id}/leave`, { date_from: a.value, date_to: b.value, reason: r.value }); announce('Leave saved ✓'); close(); } catch (er) { announce(er.message, 'err'); } }));
    return [cancelBtn(close), s];
  });
}
function overtimeDialog(e) {
  const a = h('input', { type: 'datetime-local', required: true }), b = h('input', { type: 'datetime-local', required: true }), r = h('input', { type: 'text', required: true, minlength: 5, placeholder: 'Why is overtime needed?' });
  dialog(`Authorise overtime for ${e.name}`, h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Time outside the shift is only recorded inside an authorised window. Pakistan time.'), field('From', a), field('To', b), field('Reason', r)), (close) => {
    const s = h('button', { class: 'btn primary', type: 'button' }, 'Authorise');
    s.addEventListener('click', busy(s, async () => { try { await post(`/api/admin/employees/${e.id}/overtime`, { start_ms: fromInput(a.value), end_ms: fromInput(b.value), reason: r.value }); announce('Overtime authorised ✓'); close(); } catch (er) { announce(er.message, 'err'); } }));
    return [cancelBtn(close), s];
  });
}

export async function devicesPage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let r; try { r = await get('/api/admin/devices'); } catch (e) { root.replaceChildren(errBox(e)); return; }
  const pend = r.devices.filter((d) => d.status === 'pending'), appr = r.devices.filter((d) => d.status === 'approved');
  const hasApproved = (id) => appr.some((a) => a.employee_id === id);
  const c1 = h('section', { class: 'card' }, h('h2', {}, 'Waiting for approval'), h('p', { class: 'muted' }, 'Approve a computer only when you have seen the person set it up. One computer per person. A computer cannot be shared.'));
  if (!pend.length) c1.append(empty('No requests.'));
  for (const d of pend) {
    const b = h('button', { class: 'btn primary', type: 'button' }, hasApproved(d.employee_id) ? 'Approve & replace old' : 'Approve');
    b.addEventListener('click', busy(b, async () => {
      if (hasApproved(d.employee_id) && !confirm(`${d.employee} already has an approved computer. Replace it? The old one stops working.`)) return;
      try { await post(`/api/admin/devices/${d.id}/approve`, { replace: hasApproved(d.employee_id) }); announce('Approved ✓'); devicesPage(root, me); } catch (e) { announce(e.message, 'err'); }
    }));
    const rj = h('button', { class: 'btn', type: 'button' }, 'Reject'); rj.addEventListener('click', () => revokeDialog(d, () => devicesPage(root, me)));
    c1.append(h('div', { class: 'item' }, h('div', {}, h('strong', {}, d.employee), h('div', { class: 'muted' }, `${d.label || 'Computer'} · requested ${fmtDateTime(d.created_at)}`)), h('div', { class: 'row' }, rj, b)));
  }
  const c2 = h('section', { class: 'card' }, h('h2', {}, 'Approved computers'));
  if (!appr.length) c2.append(empty('None yet.'));
  for (const d of appr) { const b = h('button', { class: 'btn small', type: 'button' }, 'Remove'); b.addEventListener('click', () => revokeDialog(d, () => devicesPage(root, me)));
    c2.append(h('div', { class: 'item' }, h('div', {}, h('strong', {}, d.employee), h('div', { class: 'muted' }, `${d.label || 'Computer'} · approved ${fmtDateTime(d.decided_at)}`)), b)); }
  root.replaceChildren(c1, c2);
}
function revokeDialog(d, done) {
  const why = h('input', { type: 'text', required: true, minlength: 3, maxlength: 200, placeholder: 'Reason (saved in the audit history)' });
  dialog(`Remove ${d.employee}'s computer`, field('Reason', why), (close) => {
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Remove');
    b.addEventListener('click', busy(b, async () => { try { await post(`/api/admin/devices/${d.id}/revoke`, { reason: why.value }); announce('Removed ✓'); close(); done(); } catch (e) { announce(e.message, 'err'); } }));
    return [cancelBtn(close), b];
  });
}

export async function settingsPage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let s, ex, hl, shifts; try { [s, ex, hl, shifts] = await Promise.all([get('/api/admin/settings'), get('/api/admin/network-exceptions'), get('/api/admin/clickup/health'), get('/api/admin/shifts')]); } catch (e) { root.replaceChildren(errBox(e)); return; }
  const reload = () => settingsPage(root, me);
  const save = async (patch, msg = 'Saved ✓') => { try { await post('/api/admin/settings', patch); announce(msg); reload(); } catch (e) { announce(e.message, 'err'); } };

  // office network
  const ips = s.settings.office_ips;
  const addIp = h('input', { type: 'text', placeholder: 'e.g. 203.0.113.7', 'aria-label': 'Office address' });
  const net = h('section', { class: 'card' }, h('h2', {}, 'Office network'),
    h('p', { class: 'muted' }, 'Check-in works only from these addresses. Staff phones on the office Wi-Fi share the same address, so a person also needs their approved computer.'),
    s.detected_ip ? h('p', {}, 'The server currently sees you at ', h('strong', {}, s.detected_ip), '. ') : null,
    ips.length ? h('ul', {}, ips.map((ip) => { const b = h('button', { class: 'btn small', type: 'button' }, 'Remove'); b.addEventListener('click', () => confirm(`Remove ${ip}? Nobody will be able to check in from it.`) && save({ office_ips: ips.filter((x) => x !== ip) })); return h('li', { class: 'row between' }, h('span', { class: 'mono' }, ip), b); }))
      : h('div', { class: 'warnbox' }, 'No office address is set, so nobody can check in.'),
    h('div', { class: 'row' }, addIp, (() => { const b = h('button', { class: 'btn', type: 'button' }, 'Add'); b.addEventListener('click', () => addIp.value && save({ office_ips: [...ips, addIp.value.trim()] })); return b; })(),
      s.detected_ip && !ips.includes(v6to64(s.detected_ip)) ? (() => { const b = h('button', { class: 'btn', type: 'button' }, 'Add my current address'); b.addEventListener('click', () => confirm(`Only do this while you are in the office on the office network. Add ${v6to64(s.detected_ip)}?`) && save({ office_ips: [...ips, v6to64(s.detected_ip)] })); return b; })() : null));

  const exWhy = h('input', { type: 'text', minlength: 10, maxlength: 300, placeholder: 'Why? e.g. Office internet is down' });
  const exHours = h('select', {}, [1, 2, 4, 8, 24].map((n) => h('option', { value: n, selected: n === 4 }, `${n} hour${n > 1 ? 's' : ''}`)));
  const active = ex.exceptions.filter((x) => !x.revoked_at && x.expires_at > Date.now());
  const outage = h('section', { class: 'card' }, h('h2', {}, 'Office network outage'), h('p', { class: 'muted' }, 'If the office internet or address changes, allow check-in for a short time. It is recorded and expires by itself.'),
    active.map((x) => { const b = h('button', { class: 'btn small', type: 'button' }, 'Stop now'); b.addEventListener('click', busy(b, async () => { try { await post(`/api/admin/network-exceptions/${x.id}/revoke`); reload(); } catch (e) { announce(e.message, 'err'); } })); return h('div', { class: 'item' }, h('div', {}, chip('Active', 'warn'), ' ', x.reason, h('div', { class: 'muted' }, `until ${fmtDateTime(x.expires_at)} · ${x.employee_id ? 'one person' : 'everyone'}`)), b); }),
    h('div', { class: 'stack' }, field('Reason', exWhy), field('For how long', exHours), (() => { const b = h('button', { class: 'btn', type: 'button' }, 'Allow check-in from anywhere'); b.addEventListener('click', busy(b, async () => {
      if (!confirm('Everyone with an approved computer can check in from any network until this expires. Continue?')) return;
      try { await post('/api/admin/network-exceptions', { reason: exWhy.value, hours: +exHours.value }); announce('Exception started'); reload(); } catch (e) { announce(e.message, 'err'); } })); return b; })()));

  // clickup
  const token = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste ClickUp API token (pk_…)' });
  const syncTime = h('input', { type: 'time', value: minToStr(s.settings.sync_time_min) });
  const revStatus = h('input', { type: 'text', value: s.settings.revisions_status || '', placeholder: 'e.g. Revisions (leave empty to skip writing to ClickUp)' });
  const cuCard = h('section', { class: 'card' }, h('h2', {}, 'ClickUp'),
    h('p', {}, hl.connected ? chip('Connected', 'ok') : chip('Not connected', 'warn'), ' ', hl.webhook_ready ? chip('Live updates on', 'ok') : chip('Live updates off', 'warn'), ' ', hl.team_id ? chip('Workspace chosen', 'ok') : chip('No workspace', 'warn')),
    hl.last_ok_ms ? h('p', { class: 'muted' }, `Last successful update: ${fmtDateTime(hl.last_ok_ms)}.${hl.last_webhook_ms ? ' Last live event: ' + fmtDateTime(hl.last_webhook_ms) + '.' : ''}`) : null,
    hl.last_error ? h('div', { class: 'warnbox' }, hl.last_error) : null, hl.gap_count ? h('div', { class: 'warnbox' }, `${hl.gap_count} task(s) have a gap in their history where exact times are unknown.`) : null,
    h('div', { class: 'stack' },
      (() => { const b = h('button', { class: 'btn primary', type: 'button' }, 'Connect with ClickUp (recommended)'); b.addEventListener('click', busy(b, async () => { try { const r = await post('/api/admin/clickup/oauth'); location.href = r.url; } catch (e) { announce(e.message, 'err'); } })); return b; })(),
      field('1. Or connect with an API token', token, 'Create it in ClickUp: Settings → Apps → API Token. It is stored encrypted on the server and never shown again.'),
      (() => { const b = h('button', { class: 'btn', type: 'button' }, 'Save token'); b.addEventListener('click', busy(b, async () => { try { await post('/api/admin/clickup/token', { token: token.value }); token.value = ''; announce('Token saved ✓'); reload(); } catch (e) { announce(e.message, 'err'); } })); return b; })(),
      (() => { const b = h('button', { class: 'btn', type: 'button' }, '2. Choose workspace'); b.addEventListener('click', busy(b, async () => { try { const r = await get('/api/admin/clickup/members'); teamPick(r.teams, (id) => save({ clickup_team_id: id })); } catch (e) { announce(e.message, 'err'); } })); return b; })(),
      (() => { const b = h('button', { class: 'btn', type: 'button' }, '3. Turn on live updates'); b.addEventListener('click', busy(b, async () => { try { await post('/api/admin/clickup/webhook'); announce('Live updates on ✓'); reload(); } catch (e) { announce(e.message, 'err'); } })); return b; })(),
      field('End-of-day update time (Pakistan time)', syncTime), field('"Request changes" moves tasks to this status', revStatus),
      (() => { const b = h('button', { class: 'btn primary', type: 'button' }, 'Save ClickUp settings'); b.addEventListener('click', () => save({ sync_time_min: strToMin(syncTime.value || '18:30'), revisions_status: revStatus.value })); return b; })(),
      (() => { const b = h('button', { class: 'btn', type: 'button' }, 'Sync now'); b.addEventListener('click', busy(b, async () => { try { const r = await syncUntilDone((p) => announce(`Updating from ClickUp… (${p * 100} tasks so far)`)); announce(r.ok ? 'Updated ✓' : r.error || 'Not finished', r.ok ? 'ok' : 'err'); reload(); } catch (e) { announce(e.message, 'err'); } })); return b; })()));

  // shifts
  const sn = h('input', { type: 'text', maxlength: 60, placeholder: 'e.g. Afternoon (college)' });
  const st = h('input', { type: 'time', value: '09:00' }), en = h('input', { type: 'time', value: '17:00' });
  const dayBoxes = DAYS.map((d, i) => ({ d, i, el: h('input', { type: 'checkbox', checked: i < 5 }) }));
  const grace = h('input', { type: 'number', min: 0, max: 120, value: 10 });
  const shiftCard = h('section', { class: 'card' }, h('h2', {}, 'Shifts'), h('p', { class: 'muted' }, 'Each person is compared with their own approved shift. Assign shifts under People.'),
    shifts.shifts.length ? h('ul', {}, shifts.shifts.map((x) => h('li', {}, `${x.name}: ${minToStr(x.start_min)}–${minToStr(x.end_min)}, ${DAYS.filter((_, i) => (x.days_mask >> i) & 1).join(' ')}`))) : empty('No shifts yet.'),
    h('div', { class: 'stack' }, field('Name', sn), h('div', { class: 'row' }, field('Starts', st), field('Ends', en), field('Late after (min)', grace)),
      h('div', { class: 'row wrap' }, dayBoxes.map((x) => h('label', { class: 'check' }, x.el, ' ' + x.d))),
      (() => { const b = h('button', { class: 'btn', type: 'button' }, 'Add shift'); b.addEventListener('click', busy(b, async () => { try { await post('/api/admin/shifts', { name: sn.value, start_min: strToMin(st.value), end_min: strToMin(en.value), days_mask: dayBoxes.reduce((m, x) => m | (x.el.checked ? 1 << x.i : 0), 0), grace_min: +grace.value }); announce('Shift added ✓'); reload(); } catch (e) { announce(e.message, 'err'); } })); return b; })()));

  const auto = h('input', { type: 'checkbox', checked: s.settings.auto_reports });
  auto.addEventListener('change', () => save({ auto_reports: auto.checked }));
  const rep = h('section', { class: 'card' }, h('h2', {}, 'Reports'), h('label', { class: 'check' }, auto, ' Prepare the weekly and monthly reports automatically when a period ends'), h('p', { class: 'muted' }, 'Reports are shown in the app only. No daily report is made and nothing is emailed.'));
  const out = h('section', { class: 'card' }, h('h2', {}, 'Imported old records'), h('p', { class: 'muted' }, 'Paste the old app\'s exported data (JSON) to keep its history. Old passwords are never imported.'), importBox());
  const sm = await statusCard(s.settings);
  const aud = h('section', { class: 'card' }, h('h2', {}, 'Audit history'), h('p', { class: 'muted' }, 'Every correction, approval and setting change.'), h('a', { class: 'btn', href: '#audit' }, 'Open audit history'));
  root.replaceChildren(net, outage, cuCard, sm, shiftCard, rep, aud, out);
}
function teamPick(teams, onPick) {
  const sel = h('select', {}, teams.map((t) => h('option', { value: t.id }, t.name)));
  dialog('Choose your ClickUp workspace', field('Workspace', sel), (close) => {
    const b = h('button', { class: 'btn primary', type: 'button', onclick: () => { onPick(sel.value); close(); } }, 'Use this one');
    return [cancelBtn(close), b];
  });
}
function importBox() {
  const ta = h('textarea', { rows: 4, placeholder: '{"members":[…],"attendance":[…],"workLogs":[…]}' });
  const b = h('button', { class: 'btn', type: 'button' }, 'Import');
  b.addEventListener('click', busy(b, async () => {
    let data; try { data = JSON.parse(ta.value); } catch { announce('That is not valid JSON.', 'err'); return; }
    try {
      const r = await post('/api/admin/import-legacy', data);
      announce(`Imported ${r.employees.length} people and ${r.archived} records ✓`);
      if (r.temp_passwords.length) dialog('Temporary passwords (shown once)', h('div', { class: 'stack' }, h('p', {}, 'Imported people need a real email set under People, then this password.'), h('pre', { class: 'mono' }, r.temp_passwords.map((t) => `${t.name}: ${t.temp_password}`).join('\n'))), (close) => [h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Done')]);
    } catch (e) { announce(e.message, 'err'); }
  }));
  return h('div', { class: 'stack' }, ta, b);
}

export async function auditPage(root) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let r; try { r = await get('/api/admin/audit?limit=200'); } catch (e) { root.replaceChildren(errBox(e)); return; }
  const short = (j) => { if (!j) return ''; const s = String(j); return s.length > 140 ? s.slice(0, 140) + '…' : s; };
  root.replaceChildren(h('section', { class: 'card' }, h('h2', {}, 'Audit history'), h('p', { class: 'muted' }, 'Every correction, approval and setting change. Newest first.'),
    h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'What', 'Before → After', 'Reason'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.audit.map((a) => h('tr', {}, h('td', {}, fmtDateTime(a.at_ms)), h('td', {}, a.actor_name || '—'), h('td', {}, a.action.replaceAll('_', ' ')), h('td', { class: 'small mono' }, `${short(a.before_json)} → ${short(a.after_json)}`), h('td', {}, a.reason || '')))))))); 
}

const CLASSES = [['other', 'Not timed'], ['active', 'Timed work (In Progress)'], ['revision', 'Revision work (timed)'], ['paused', 'Blocked / on hold (paused)'], ['done', 'Finished (Ready for Upload)'], ['ignore', 'Ignore (not our step, e.g. payment)']];
async function statusCard(settings) {
  const card = h('section', { class: 'card' }, h('h2', {}, 'ClickUp status names'),
    h('p', { class: 'muted' }, 'Tell the app what each ClickUp status means. Writers, designers and title finders can each have their own meaning for a status (for example "script done" is Finished for a writer). "Everyone" is the default; a job role only changes the ones you set for it.'));
  const body = h('div', {});
  const rolePick = h('select', { 'aria-label': 'Job role' });
  card.append(field('For', rolePick), body);
  let roles = [];
  async function show(role) {
    body.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    let r; try { r = await get('/api/admin/statuses' + (role ? '?role=' + encodeURIComponent(role) : '')); } catch (e) { body.replaceChildren(errBox(e)); return; }
    if (!r.statuses.length) { body.replaceChildren(empty('Statuses appear here after the first ClickUp sync of the people with this job role.')); return; }
    const sels = r.statuses.map((x) => ({ x, el: h('select', {}, CLASSES.map(([v, l]) => h('option', { value: v, selected: v === x.class }, l))) }));
    const save = h('button', { class: 'btn primary', type: 'button' }, role ? `Save for ${role}` : 'Save for everyone');
    save.addEventListener('click', busy(save, async () => {
      const chosen = Object.fromEntries(sels.map(({ x, el }) => [x.status, el.value]));
      try {
        if (role) await post('/api/admin/settings', { role_status_maps: { ...(settings.role_status_maps || {}), [role.toLowerCase()]: { ...((settings.role_status_maps || {})[role.toLowerCase()] || {}), ...chosen } } });
        else await post('/api/admin/settings', { status_map: { ...(settings.status_map || {}), ...chosen } });
        announce('Saved ✓ Recorded time was recalculated.');
      } catch (e) { announce(e.message, 'err'); }
    }));
    body.replaceChildren(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['ClickUp status', 'Tasks', 'Means'].map((t) => h('th', {}, t)))),
      h('tbody', {}, sels.map(({ x, el }) => h('tr', {}, h('td', {}, x.status), h('td', {}, String(x.count)), h('td', {}, el)))))), save);
    if (!roles.length && r.roles.length) { roles = r.roles; fillRoles(role); }
  }
  const fillRoles = (cur) => { rolePick.replaceChildren(h('option', { value: '' }, 'Everyone (default)'), ...roles.map((x) => h('option', { value: x, selected: x === cur }, x))); };
  rolePick.addEventListener('change', () => show(rolePick.value));
  fillRoles('');
  await show('');
  return card;
}
