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
  root.replaceChildren(await devicesBlock(() => peoplePage(root, me)), card);
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

// Computers (device approvals) live inside People: only needed at set-up and when someone changes computer.
async function devicesBlock(reload) {
  let r; try { r = await get('/api/admin/devices'); } catch (e) { return errBox(e); }
  const pend = r.devices.filter((d) => d.status === 'pending'), appr = r.devices.filter((d) => d.status === 'approved');
  const hasApproved = (id) => appr.some((a) => a.employee_id === id);
  const wrap = h('div', {});
  if (pend.length) {
    const c1 = h('section', { class: 'card' }, h('h2', {}, 'Computers waiting for approval'), h('p', { class: 'muted small' }, 'Approve a computer only after you saw the person set it up. One computer per person.'));
    for (const d of pend) {
      const b = h('button', { class: 'btn primary small', type: 'button' }, hasApproved(d.employee_id) ? 'Approve & replace old' : 'Approve');
      b.addEventListener('click', busy(b, async () => {
        if (hasApproved(d.employee_id) && !confirm(`${d.employee} already has an approved computer. Replace it? The old one stops working.`)) return;
        try { await post(`/api/admin/devices/${d.id}/approve`, { replace: hasApproved(d.employee_id) }); announce('Approved ✓'); reload(); } catch (e) { announce(e.message, 'err'); }
      }));
      const rj = h('button', { class: 'btn small', type: 'button' }, 'Reject'); rj.addEventListener('click', () => revokeDialog(d, reload));
      c1.append(h('div', { class: 'item row between' }, h('div', {}, h('strong', {}, d.employee), h('div', { class: 'muted small' }, `${d.label || 'Computer'} · ${fmtDateTime(d.created_at)}`)), h('div', { class: 'row' }, rj, b)));
    }
    wrap.append(c1);
  }
  const c2 = h('details', { class: 'card' }, h('summary', {}, `Approved computers (${appr.length})`));
  for (const d of appr) { const b = h('button', { class: 'btn small', type: 'button' }, 'Remove'); b.addEventListener('click', () => revokeDialog(d, reload)); c2.append(h('div', { class: 'item row between' }, h('div', {}, h('strong', {}, d.employee), h('div', { class: 'muted small' }, `${d.label || 'Computer'} · approved ${fmtDateTime(d.decided_at)}`)), b)); }
  if (!appr.length) c2.append(empty('None yet.'));
  wrap.append(c2);
  return wrap;
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
  me0 = me;
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let s, ex, hl, shifts, rf; try { [s, ex, hl, shifts, rf] = await Promise.all([get('/api/admin/settings'), get('/api/admin/network-exceptions'), get('/api/admin/clickup/health'), get('/api/admin/shifts'), get('/api/admin/network-refusals').catch(() => ({ refusals: [] }))]); } catch (e) { root.replaceChildren(errBox(e)); return; }
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
      s.detected_ip && !s.on_vpn && !ips.includes(v6to64(s.detected_ip)) ? (() => { const b = h('button', { class: 'btn', type: 'button' }, 'Add my current address'); b.addEventListener('click', () => confirm(`Only do this while you are in the office on the office network. Add ${v6to64(s.detected_ip)}?`) && save({ office_ips: [...ips, v6to64(s.detected_ip)] })); return b; })() : null),
    s.on_vpn ? h('div', { class: 'warnbox' }, 'You are connected through a VPN (Cloudflare WARP), so this is not your office address. Turn the VPN off, reload, then add the office address.') : null,
    refusedBlock(rf.refusals, ips, save));

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
  const out = h('section', { class: 'card' }, h('h2', {}, 'Imported old records'), h('p', { class: 'muted' }, 'Paste the old app\'s exported data (JSON) to keep its history. Old passwords are never imported.'), h('p', {}, h('a', { href: '#legacy' }, 'Browse old records')), importBox());
  const sm = await statusCard(s.settings);
  const sck = scriptCheckCard(s.settings.script_checks, reload);
  const bkCard = await backupsCard();
  const chCard = await channelsCard();
  const catCard = await categoriesCard();
  const ctj = h('input', { type: 'text', value: (s.settings.created_tracking_jobs || []).join(', '), placeholder: 'e.g. Title finder' });
  const createdCard = h('section', { class: 'card' }, h('h2', {}, 'Jobs that create tasks (titles, ideas)'),
    h('p', { class: 'muted' }, 'For jobs that add each title or idea as a new ClickUp task instead of moving tasks through statuses. The app counts the tasks they create, per channel code (the start of the task name, like V4--), per day, week and month. It flags names without a code and titles that may repeat. Titles are not scored.'),
    field('Jobs counted this way', ctj, 'Comma separated, same names as the Job field under People.'),
    (() => { const b = h('button', { class: 'btn primary', type: 'button' }, 'Save'); b.addEventListener('click', busy(b, async () => { try { await post('/api/admin/settings', { created_tracking_jobs: ctj.value.split(',').map((x) => x.trim()).filter(Boolean) }); announce('Saved ✓ Press Sync now to load recent tasks.'); } catch (e) { announce(e.message, 'err'); } })); return b; })());
  const aud = h('section', { class: 'card' }, h('h2', {}, 'Audit history'), h('p', { class: 'muted' }, 'Every correction, approval and setting change.'), h('a', { class: 'btn', href: '#audit' }, 'Open audit history'));
  const secs = [[net, 'Office network'], [outage, 'Outage'], [cuCard, 'ClickUp'], [sm, 'Statuses'], [chCard, 'Channels'], [catCard, 'Work categories'], [sck, 'Script checks'], [createdCard, 'Titles'], [shiftCard, 'Shifts'], [rep, 'Reports'], [bkCard, 'Backups'], [aud, 'Audit']];
  secs.forEach(([el, l], i) => { el.id = 'sec' + i; });
  const jump = h('nav', { class: 'jump', 'aria-label': 'Settings sections' }, secs.map(([, l], i) => h('a', { href: '#settings', onclick: (ev) => { ev.preventDefault(); document.getElementById('sec' + i)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, l)));
  root.replaceChildren(jump, ...secs.map(([el]) => el), out);
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
    // The server accepts small requests, so the old data is sent in pieces of 100 records. Running it twice is safe: duplicates are ignored.
    const kinds = ['attendance', 'workLogs', 'tasks', 'calVideos', 'videos'];
    const people = []; let archived = 0, created = 0;
    try {
      const first = await post('/api/admin/import-legacy', { members: (data.members || []).slice(0, 200) });
      created += first.employees.length; archived += first.archived; people.push(...first.temp_passwords);
      for (const k of kinds) {
        const rows = Array.isArray(data[k]) ? data[k] : [];
        for (let i = 0; i < rows.length; i += 100) {
          announce(`Importing ${k}… ${Math.min(i + 100, rows.length)} of ${rows.length}`);
          archived += (await post('/api/admin/import-legacy', { [k]: rows.slice(i, i + 100) })).archived;
        }
      }
      announce(`Imported ${created} people and ${archived} records ✓`);
      if (people.length) dialog('Temporary passwords (shown once)', h('div', { class: 'stack' }, h('p', {}, 'Imported people need a real email set under People, then this password.'), h('pre', { class: 'mono' }, people.map((t) => `${t.name}: ${t.temp_password}`).join('\n'))), (close) => [h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Done')]);
    } catch (e) { announce(e.message + ' You can run the import again: nothing is duplicated.', 'err'); }
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

const CHECK_TYPES = [
  ['desc_links', 'A link in the ClickUp task description (script Doc, voice-over…)'],
  ['desc_items', 'Number of list lines in the description (titles, ideas…)'],
  ['desc_words', 'Minimum words in the description'],
  ['ref_images', 'Reference images in the Google Doc (embedded or image links)'],
  ['images', 'Embedded images in the Google Doc'],
  ['links', 'Links inside the Google Doc'],
  ['text', 'Google Doc must contain these words'],
  ['words', 'Minimum words in the Google Doc'],
];
function scriptCheckCard(cfg, reload) {
  const jobs = JSON.parse(JSON.stringify(cfg.jobs || {}));
  let current = Object.keys(jobs)[0] || '';
  const card = h('section', { class: 'card' }, h('h2', {}, 'Script & title checks'),
    h('p', { class: 'muted' }, 'When a task reaches a Finished status for someone with that job (for example "ready to edit" for a writer), the app reads the ClickUp task description and the Google Doc linked in it, and checks your list. It never blocks anyone. The result is shown to the person, the manager and in reports. Docs must be shared as "Anyone with the link can view".'));
  const body = h('div', { class: 'stack' });
  card.append(body);
  const render = () => {
    const sel = h('select', { 'aria-label': 'Job' }, Object.keys(jobs).map((j) => h('option', { value: j, selected: j === current }, j)));
    sel.addEventListener('change', () => { current = sel.value; render(); });
    const newJob = h('input', { type: 'text', placeholder: 'Add a job, e.g. Writer or Title finder', list: 'jobroles2' });
    const dl = h('datalist', { id: 'jobroles2' }, ['Writer', 'Title finder', 'Designer', 'Editor'].map((x) => h('option', { value: x })));
    const addJob = h('button', { class: 'btn', type: 'button', onclick: () => { const k = newJob.value.trim().toLowerCase(); if (!k) return; jobs[k] ||= { rules: [] }; current = k; render(); } }, 'Add job');
    const rows = h('div', { class: 'stack' });
    const rules = jobs[current]?.rules || [];
    rules.forEach((r, i) => {
      const label = h('input', { type: 'text', value: r.label, placeholder: 'Check name, e.g. Voice-over link' });
      const type = h('select', {}, CHECK_TYPES.map(([v, l]) => h('option', { value: v, selected: v === r.type }, l)));
      const min = h('input', { type: 'number', min: 1, value: r.min ?? 1, 'aria-label': 'Minimum' });
      const val = h('input', { type: 'text', value: r.value || '', placeholder: 'Words, comma separated (e.g. drive.google.com, vocaroo.com)' });
      const sync = () => { rules[i] = { label: label.value, type: type.value, min: type.value === 'text' ? null : +min.value || 1, value: val.value }; };
      [label, type, min, val].forEach((el) => el.addEventListener('input', sync));
      const del = h('button', { class: 'btn small', type: 'button', onclick: () => { rules.splice(i, 1); render(); } }, 'Remove');
      rows.append(h('div', { class: 'item col' }, label, h('div', { class: 'row' }, type, h('span', { class: 'muted small' }, 'at least'), min), val, del));
    });
    const addRule = h('button', { class: 'btn', type: 'button', onclick: () => { (jobs[current] ||= { rules: [] }).rules.push({ label: '', type: 'desc_links', min: 1, value: '' }); render(); } }, 'Add a check');
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save all checks');
    save.addEventListener('click', busy(save, async () => {
      try { await post('/api/admin/settings', { script_checks: { jobs } }); announce('Saved ✓'); reload(); } catch (e) { announce(e.message, 'err'); }
    }));
    body.replaceChildren(Object.keys(jobs).length ? field('Checks for job', sel) : h('p', { class: 'muted' }, 'No job has checks yet.'),
      h('div', { class: 'row' }, newJob, addJob, dl), current ? rows : null, current ? addRule : null, save);
  };
  render();
  return card;
}

// ---------------------------------------------------------------- CHANNELS (recognised from the start of a ClickUp task name)
async function channelsCard() {
  const card = h('section', { class: 'card' }, h('h2', {}, 'Channels'),
    h('p', { class: 'muted' }, 'The channel is read from the start of a ClickUp task name, like V4-… or {C1-…} (braces = thumbnails made by automation). Used by the Calendar, title counts and reports.'));
  let r; try { r = await get('/api/channels'); } catch (e) { card.append(errBox(e)); return card; }
  const rows = r.channels.map((c) => ({ ...c }));
  const body = h('div', { class: 'stack' });
  const draw = () => {
    body.replaceChildren(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Code', 'Name', 'Colour', 'Tasks', 'On', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((c, i) => {
      const code = h('input', { type: 'text', value: c.code, maxlength: 12, 'aria-label': 'Code' }); code.addEventListener('input', () => { c.code = code.value.toUpperCase(); });
      const name = h('input', { type: 'text', value: c.name, maxlength: 60, 'aria-label': 'Name' }); name.addEventListener('input', () => { c.name = name.value; });
      const col = h('input', { type: 'color', value: c.color || '#6c93ff', 'aria-label': 'Colour' }); col.addEventListener('input', () => { c.color = col.value; });
      const on = h('input', { type: 'checkbox', checked: !!c.active, 'aria-label': 'Active' }); on.addEventListener('change', () => { c.active = on.checked ? 1 : 0; });
      const del = h('button', { class: 'btn small', type: 'button', onclick: () => { rows.splice(i, 1); draw(); } }, 'Remove');
      return h('tr', {}, h('td', {}, code), h('td', {}, name), h('td', {}, col), h('td', {}, String(c.tasks ?? '')), h('td', {}, on), h('td', {}, del));
    })))));
    if (r.suggestions?.length) body.append(h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Found in ClickUp but not listed:'), ...r.suggestions.map((s0) => { const b = h('button', { class: 'btn small', type: 'button' }, `+ ${s0.code} (${s0.tasks})`); b.addEventListener('click', () => { rows.push({ code: s0.code, name: s0.code, color: '#6c93ff', active: 1, tasks: s0.tasks }); r.suggestions = r.suggestions.filter((x) => x.code !== s0.code); draw(); }); return b; })));
    const add = h('button', { class: 'btn', type: 'button', onclick: () => { rows.push({ code: '', name: '', color: '#6c93ff', active: 1 }); draw(); } }, 'Add a channel');
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save channels');
    save.addEventListener('click', busy(save, async () => { try { await post('/api/admin/channels', { channels: rows.map((c) => ({ code: c.code, name: c.name || c.code, color: c.color, active: !!c.active })) }); announce('Saved ✓'); } catch (e) { announce(e.message, 'err'); } }));
    body.append(h('div', { class: 'row' }, add, save));
  };
  draw(); card.append(body);
  return card;
}

// ---------------------------------------------------------------- WORK CATEGORIES (for "by work type" in reports)
async function categoriesCard() {
  const card = h('section', { class: 'card' }, h('h2', {}, 'Work categories'),
    h('p', { class: 'muted' }, 'Reports group finished work and time by category. A category belongs to a job, so a person\'s work goes under their job\'s category. Thumbnails made by automation are shown separately.'));
  let r; try { r = await get('/api/admin/categories'); } catch (e) { card.append(errBox(e)); return card; }
  const rows = r.categories.map((c) => ({ name: c.name, job_role: c.job_role || '', active: !!c.active }));
  const body = h('div', { class: 'stack' });
  const draw = () => {
    body.replaceChildren(...rows.map((c, i) => {
      const name = h('input', { type: 'text', value: c.name, maxlength: 60, placeholder: 'Category, e.g. Video editing' }); name.addEventListener('input', () => { c.name = name.value; });
      const job = h('input', { type: 'text', value: c.job_role, maxlength: 40, list: 'jobroles3', placeholder: 'Job' }); job.addEventListener('input', () => { c.job_role = job.value; });
      return h('div', { class: 'row' }, h('div', { class: 'grow' }, name), h('div', { class: 'grow' }, job), h('button', { class: 'btn small', type: 'button', onclick: () => { rows.splice(i, 1); draw(); } }, 'Remove'));
    }), h('datalist', { id: 'jobroles3' }, ['Editor', 'Writer', 'Designer', 'Title finder', 'Voice-over', 'Uploader'].map((x) => h('option', { value: x }))));
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save categories');
    save.addEventListener('click', busy(save, async () => { try { await post('/api/admin/categories', { categories: rows.filter((c) => c.name.trim()).map((c) => ({ name: c.name, job_role: c.job_role || null, active: true })) }); announce('Saved ✓'); } catch (e) { announce(e.message, 'err'); } }));
    body.append(h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => { rows.push({ name: '', job_role: '', active: true }); draw(); } }, 'Add a category'), save));
  };
  draw(); card.append(body);
  return card;
}

// ---------------------------------------------------------------- OLD RECORDS (read-only archive of the original app's data)
export async function legacyPage(root) {
  const kinds = [['member', 'People'], ['attendance', 'Attendance'], ['workLog', 'Work logs'], ['task', 'Tasks'], ['video', 'Videos']];
  const kind = legacyPage.kind || 'attendance';
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let r; try { r = await get('/api/admin/legacy?kind=' + kind); } catch (e) { root.replaceChildren(errBox(e)); return; }
  const tabs = h('div', { class: 'tabs' }, kinds.map(([k, l]) => { const b = h('button', { class: 'btn' + (k === kind ? ' on' : ''), type: 'button' }, l); b.addEventListener('click', () => { legacyPage.kind = k; legacyPage(root); }); return b; }));
  const card = h('section', { class: 'card' }, h('p', {}, h('a', { href: '#settings' }, '‹ Settings')), h('h2', {}, 'Old records'), h('p', { class: 'muted' }, 'Read-only archive from the original app. Not used in reports. Old passwords are never kept.'));
  if (!r.records.length) card.append(empty('Nothing imported for this tab. Import the old app\'s data in Settings → Imported old records.'));
  else {
    const cols = [...new Set(r.records.flatMap((x) => Object.keys(x)))].filter((c) => !['employee_id', 'password', 'sheetPassword', 'color'].includes(c)).slice(0, 8);
    card.append(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), h('tbody', {}, r.records.slice(0, 300).map((x) => h('tr', {}, cols.map((c) => h('td', {}, String(x[c] ?? '').slice(0, 80)))))))), h('p', { class: 'muted small' }, `Showing ${Math.min(300, r.records.length)} of ${r.records.length}.`));
  }
  root.replaceChildren(tabs, card);
}

// ---------------------------------------------------------------- BACKUPS & DOWNLOADS
let me0 = null;
async function backupsCard() {
  const card = h('section', { class: 'card' }, h('h2', {}, 'Backups & downloads'));
  let r; try { r = await get('/api/admin/backups'); } catch (e) { card.append(errBox(e)); return card; }
  const age = r.newest_age_days;
  card.append(h('p', {}, r.running ? chip('Backup running…', 'warn') : age == null ? chip('No backup yet', 'warn') : age > 9 ? chip(`Last backup ${age} days ago`, 'warn') : chip(`Last backup ${age === 0 ? 'today' : age + ' day' + (age > 1 ? 's' : '') + ' ago'} ✓`, 'ok'), ' ',
    h('span', { class: 'muted small' }, 'An encrypted backup is made automatically every week and kept for as long as you like. It is stored in your Cloudflare account.')));
  const now = h('button', { class: 'btn primary', type: 'button' }, 'Back up now');
  now.addEventListener('click', busy(now, async () => {
    try { for (let i = 0; i < 40; i++) { const x = await post('/api/admin/backups/run'); if (x.done) break; } announce('Backup saved ✓'); settingsPage(document.getElementById('main'), me0 || {}); }
    catch (e) { announce(e.message, 'err'); }
  }));
  card.append(h('div', { class: 'row' }, now));
  if (r.backups.length) {
    card.append(h('details', { class: 'more' }, h('summary', {}, `Saved backups (${r.backups.length})`), ...r.backups.map((b) => h('div', { class: 'item row between' },
      h('div', {}, h('strong', {}, b.date), h('div', { class: 'muted small' }, `${b.rows} records · ${Math.max(1, Math.round(b.bytes / 1024))} KB`)),
      h('a', { class: 'btn small', href: `/api/admin/backups/${b.date}`, download: '' }, 'Download')))));
  }
  card.append(h('div', { class: 'subbox' }, h('strong', {}, 'Once a month: save a copy outside Cloudflare'),
    h('p', { class: 'muted small' }, 'Download the latest backup and drop it in a private Google Drive folder. It is encrypted: it can only be opened with your ENCRYPTION_KEY (keep that key in your password manager).')));
  const year = h('select', { 'aria-label': 'Year' }, [0, 1, 2].map((n) => { const y = new Date().getUTCFullYear() - n; return h('option', { value: y }, String(y)); }));
  const link = (what, label) => { const a = h('a', { class: 'btn small', href: '#', download: '' }, label); a.addEventListener('click', () => { a.href = `/api/admin/export/${what}?year=${year.value}`; }); return a; };
  card.append(h('div', { class: 'subbox' }, h('strong', {}, 'Spreadsheets (open in Google Sheets or Excel)'),
    h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Year'), year, link('attendance', 'Attendance'), link('updates', 'Work updates'), link('monthly', 'Monthly summary')),
    h('p', { class: 'muted small' }, 'In Google Sheets: File → Import → Upload. Contains employee data: keep the file private.')));
  return card;
}

// Recent refused check-ins, newest first, with a one-click "this is the office" for real networks.
function refusedBlock(list, ips, save) {
  const shown = list.filter((r) => !r.already_allowed);
  if (!shown.length) return null;
  return h('div', { class: 'subbox' }, h('strong', {}, 'Refused in the last 7 days'),
    h('p', { class: 'muted small' }, 'These people were signed in on their approved computer but their network is not on your list. Allow it only if you know it is your office.'),
    ...shown.map((r) => h('div', { class: 'item row between' }, h('div', {}, h('strong', {}, r.name), ' ', r.is_vpn ? chip('VPN', 'warn') : null, h('div', { class: 'muted small mono' }, `${r.ip} · ${r.count}× · ${fmtDateTime(r.last_at)}`)),
      r.is_vpn ? h('span', { class: 'muted small' }, 'Ask them to turn the VPN off') : (() => { const b = h('button', { class: 'btn small', type: 'button' }, 'This is the office'); b.addEventListener('click', () => confirm(`Allow ${v6to64(r.ip)} as your office network? Everyone on it will be able to check in.`) && save({ office_ips: [...ips, v6to64(r.ip)] })); return b; })())));
}
