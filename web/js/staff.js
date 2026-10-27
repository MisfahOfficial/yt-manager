import { h, get, post, api, checkView, checksSection, field, dialog, busy, announce, chip, empty, errBox, fmtTime, fmtDate, fmtDateTime, fmtDur, uid, draft, localDevice, createLocalDevice, ApiError } from './core.js';

// One pending request id per action: a retry after a failed save reuses it, so the server can never double-record.
const pendingId = (k) => { let v = sessionStorage.getItem('ytm-rid:' + k); if (!v) { v = uid(); sessionStorage.setItem('ytm-rid:' + k, v); } return v; };
const clearId = (k) => sessionStorage.removeItem('ytm-rid:' + k);

function depositForm(tasks, key, { requirePending = true } = {}) {
  const saved = draft.get(key) || {};
  const sel = h('select', { id: key + '-task', required: true }, h('option', { value: '' }, 'Choose a task…'),
    tasks.map((t) => h('option', { value: t.id }, t.name)), h('option', { value: '__none' }, 'No task (support / other work)'));
  const why = h('input', { type: 'text', maxlength: 300, placeholder: 'What kind of work was it?' });
  const whyField = field('Why is there no task?', why); whyField.hidden = true;
  const link = h('input', { type: 'url', required: true, placeholder: 'https://drive.google.com/…', inputmode: 'url' });
  const done = h('textarea', { rows: 3, required: true, maxlength: 4000, placeholder: 'e.g. Rough cut of acts 1 and 2' });
  const pend = h('textarea', { rows: 2, maxlength: 4000, placeholder: 'e.g. Colour, music, final export' });
  const complete = h('input', { type: 'checkbox' });
  const sync = () => { whyField.hidden = sel.value !== '__none'; pend.disabled = complete.checked; pend.required = !complete.checked && requirePending; };
  const values = () => ({ task: sel.value, why: why.value, link: link.value, done: done.value, pend: pend.value, complete: complete.checked });
  sel.value = saved.task ?? ''; why.value = saved.why || ''; link.value = saved.link || ''; done.value = saved.done || ''; pend.value = saved.pend || ''; complete.checked = !!saved.complete;
  if (sel.value !== saved.task) sel.value = '';
  const el = h('div', { class: 'stack' },
    field('Which task?', sel), whyField,
    field('Link to your current work', link, 'A Drive, project or preview link. An unfinished video is fine.'),
    field('What did you complete?', done),
    h('label', { class: 'check' }, complete, ' This work is finished'),
    field('What is still pending?', pend));
  el.addEventListener('input', () => { sync(); draft.set(key, values()); }); // never lose what was typed
  sel.addEventListener('change', sync); sync();
  el.payload = () => ({
    task_id: sel.value && sel.value !== '__none' ? sel.value : null,
    taskless_reason: sel.value === '__none' ? why.value : null,
    link: link.value, completed: done.value, pending: pend.value, is_complete: complete.checked,
    _valid: () => el.closest('form')?.reportValidity?.() ?? true,
  });
  el.clear = () => { draft.del(key); [why, link, done, pend].forEach((i) => { i.value = ''; }); sel.value = ''; complete.checked = false; sync(); };
  return el;
}

async function deviceCard(me) {
  const local = await localDevice(me.id);
  const card = h('section', { class: 'card' });
  if (!local) {
    card.append(h('h2', {}, 'Set up this computer'),
      h('p', {}, 'To check in you must use your own approved computer. Click once, then ask your admin to approve it.'));
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Set up this computer');
    b.addEventListener('click', busy(b, async () => {
      try {
        const rec = await createLocalDevice(me.id);
        await post('/api/device', { jwk: rec.jwk, label: (navigator.platform || 'Computer').slice(0, 40) });
        announce('Request sent. Your admin must approve this computer.');
        location.reload();
      } catch (e) { announce(e.message, 'err'); }
    }));
    card.append(b);
    return { card, ok: false };
  }
  let list;
  try { list = (await get('/api/device?fp=' + local.fp)).devices; } catch (e) { card.append(errBox(e)); return { card, ok: false }; }
  const mine = list.find((d) => d.this_device);
  if (mine?.status === 'approved') return { card: null, ok: true };
  card.append(h('h2', {}, mine?.status === 'pending' ? 'Waiting for admin approval' : 'This computer is not approved'),
    h('p', {}, mine?.status === 'pending' ? 'Your request was sent. You can check in as soon as your admin approves it.'
      : mine?.status === 'revoked' ? 'This computer was removed by your admin.' : 'This computer is not registered to you.'));
  if (!mine || mine.status === 'revoked') {
    const b = h('button', { class: 'btn', type: 'button' }, 'Request approval again');
    b.addEventListener('click', busy(b, async () => {
      try { const rec = await createLocalDevice(me.id); await post('/api/device', { jwk: rec.jwk, label: 'Computer' }); location.reload(); } catch (e) { announce(e.message, 'err'); }
    }));
    card.append(b);
  }
  return { card, ok: false };
}

export async function todayPage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let t, tasks = [];
  try { [t, tasks] = await Promise.all([get('/api/today'), get('/api/tasks/mine').then((r) => r.tasks)]); }
  catch (e) { root.replaceChildren(errBox(e)); return; }
  const dev = await deviceCard(me);
  const loadedAt = Date.now();
  const checkedIn = t.state === 'checked_in';
  const a = t.attendance;

  const status = h('section', { class: 'card hero' },
    h('div', { class: 'big' }, checkedIn ? 'You are checked in' : (a && a.status === 'closed' && a.check_out_at > Date.now() - 12 * 3600000 ? 'Checked out' : 'Not checked in')),
    h('p', { class: 'muted' }, checkedIn ? `Since ${fmtTime(a.check_in_at)}` : (a?.check_out_at ? `Last check-out ${fmtDateTime(a.check_out_at)}` : 'Check in when you start work at the office.')));
  const out = [status];
  if (dev.card) out.push(dev.card);

  if (dev.ok) {
    if (!checkedIn) {
      const b = h('button', { class: 'btn primary xl', type: 'button' }, 'Check in');
      b.addEventListener('click', busy(b, async () => {
        const key = 'checkin';
        try { await post('/api/checkin', { request_id: pendingId(key) }, { sign: true }); clearId(key); announce('Checked in ✓ (saved)'); todayPage(root, me); }
        catch (e) { announce(e.message + (e.status === 0 ? ' Press the button again to retry.' : ''), 'err'); if (e.status && e.status < 500 && e.code !== 'device_nonce_invalid') clearId(key); }
      }));
      out.push(h('div', { class: 'actions' }, b));
    } else {
      const b = h('button', { class: 'btn primary xl', type: 'button' }, 'Deposit work & check out');
      b.addEventListener('click', () => checkoutDialog(root, me, tasks, t));
      out.push(h('div', { class: 'actions' }, b, h('p', { class: 'muted' }, t.deposit_count ? `${t.deposit_count} work deposit(s) saved today.` : 'Before you check out you will share a link to your current work.')));
    }
  }

  // current task + recorded time
  const rec = h('span', { id: 'rec' }, fmtDur(t.recorded_ms_today));
  const tick = () => { rec.textContent = fmtDur(t.recorded_ms_today + (t.active_task && checkedIn ? Date.now() - loadedAt : 0)); };
  const taskCard = h('section', { class: 'card' }, h('h2', {}, 'Current task'));
  if (!checkedIn) taskCard.append(empty('Your task timer starts by itself when you check in and your task is In Progress in ClickUp.'));
  else if (t.active_task) taskCard.append(h('p', { class: 'big2' }, t.active_task.name), h('p', {}, t.active_task.kind === 'revision' ? chip('Revision', 'warn') : chip('Editing'), ' ',
    h('a', { href: t.active_task.url || '#', target: '_blank', rel: 'noopener noreferrer' }, 'Open in ClickUp')));
  else if (t.needs_task_choice.length) {
    taskCard.append(h('p', { class: 'warn-text' }, 'More than one of your tasks is In Progress. Which one are you working on now? Only one is timed.'));
    for (const c of t.needs_task_choice) {
      const b = h('button', { class: 'btn', type: 'button' }, c.name);
      b.addEventListener('click', busy(b, async () => { try { await post('/api/active-task', { task_id: c.id }); announce('Got it'); todayPage(root, me); } catch (e) { announce(e.message, 'err'); } }));
      taskCard.append(h('div', { class: 'row' }, b));
    }
  } else taskCard.append(empty('No task is In Progress for you in ClickUp right now.'));
  if (checkedIn && !t.active_task && t.unverified_tasks?.length) taskCard.append(h('div', { class: 'warnbox' }, `ClickUp has not told us when "${t.unverified_tasks[0].name}" started, so it is not timed yet. Move it to another status and back to In Progress in ClickUp to start the timer.`));
  taskCard.append(h('p', { class: 'muted' }, 'Recorded task time today: ', rec, ' — counted only while you are checked in.'));
  out.push(taskCard);
  root.replaceChildren(...out);
  clearInterval(todayPage.t); if (t.active_task && checkedIn) todayPage.t = setInterval(tick, 30000);
}

function checkoutDialog(root, me, tasks, t) {
  const form = h('form', { class: 'stack', novalidate: true, id: 'checkout-form' });
  const dep = depositForm(tasks, 'checkout-deposit');
  const need = !t.deposit_count;
  const note = h('p', { class: 'muted' }, need ? 'Share your current work first. This is saved together with your check-out.' : 'You already deposited work today. You can add another, or just check out.');
  const err = h('div', { 'aria-live': 'polite' });
  form.append(note, need ? dep : h('details', {}, h('summary', {}, 'Add another deposit'), dep), err);
  const exc = h('details', { class: 'exception' }, h('summary', {}, "Something is broken and I can't submit my work"),
    h('p', { class: 'muted' }, 'You will be checked out now with the real time. Your manager will see the reason and can ask you for the work later.'),
    field('What went wrong?', h('input', { type: 'text', id: 'exc', maxlength: 500, placeholder: 'e.g. Drive upload keeps failing' })));
  form.append(exc);
  const dlg = dialog('Check out', form, (close) => {
    const cancel = h('button', { class: 'btn', type: 'button', onclick: close }, 'Not yet');
    const go = h('button', { class: 'btn primary', type: 'submit', form: 'checkout-form' }, 'Check out');
    form.addEventListener('submit', busy(go, async (ev) => {
      ev.preventDefault(); err.replaceChildren();
      const exception = exc.open && $v(form, '#exc');
      if (!exception && (need || dep.payload().link) && !form.reportValidity()) return;
      const body = { request_id: pendingId('checkout') };
      if (exception) body.exception_reason = exception;
      else if (need || dep.payload().link) { const p = dep.payload(); delete p._valid; body.deposit = p; }
      try {
        const r = await post('/api/checkout', body, { sign: true });
        clearId('checkout'); dep.clear();
        announce((r.exception ? 'Checked out (saved). Your manager will see the technical problem.' : 'Work deposited and checked out ✓ (saved)') + (r.check?.status === 'ok' ? (r.check.passed ? ' Script check passed.' : ' Script check: items missing, see My History.') : ''));
        close(); todayPage(root, me);
      } catch (e) {
        err.replaceChildren(errBox(e)); // inputs stay as typed
        if (e.status && e.status < 500 && e.code !== 'device_nonce_invalid') clearId('checkout');
      }
    }));
    return [cancel, go];
  });
}
const $v = (root, sel) => root.querySelector(sel)?.value?.trim() || '';

export async function tasksPage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let r; try { r = await get('/api/tasks/mine'); } catch (e) { root.replaceChildren(errBox(e)); return; }
  if (!r.linked) { root.replaceChildren(h('section', { class: 'card' }, h('h2', {}, 'My tasks'), h('p', {}, 'Your account is not linked to ClickUp yet. Ask your admin.'))); return; }
  const list = h('section', { class: 'card' }, h('h2', {}, 'My tasks'), h('p', { class: 'muted' }, 'Tasks and deadlines come from ClickUp. Change them there.'));
  if (!r.tasks.length) list.append(empty('Nothing assigned to you right now.'));
  for (const t of r.tasks) list.append(h('div', { class: 'item' },
    h('div', {}, h('strong', {}, t.name), h('div', { class: 'muted' }, t.due_ms ? `Due ${fmtDate(t.due_ms)}` : 'No deadline')),
    h('div', { class: 'right' }, chip(t.status || '—', t.class === 'active' ? 'ok' : t.class === 'paused' ? 'warn' : t.class === 'revision' ? 'warn' : ''), ' ',
      t.url ? h('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer' }, 'ClickUp') : null)));
  root.replaceChildren(list, await checksSection('My script / title checks', () => tasksPage(root, me)));
}

export async function depositPage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let tasks, today, hist;
  try { [tasks, today, hist] = await Promise.all([get('/api/tasks/mine'), get('/api/today'), get('/api/history?days=1')]); } catch (e) { root.replaceChildren(errBox(e)); return; }
  const form = h('form', { class: 'stack' });
  const dep = depositForm(tasks.tasks, 'page-deposit');
  const err = h('div', { 'aria-live': 'polite' });
  const go = h('button', { class: 'btn primary', type: 'submit' }, 'Save work deposit');
  form.append(dep, err, go);
  form.addEventListener('submit', busy(go, async (ev) => {
    ev.preventDefault(); err.replaceChildren();
    if (!form.reportValidity()) return;
    const p = dep.payload(); delete p._valid;
    try { const r = await post('/api/deposits', { request_id: pendingId('deposit'), ...p }); clearId('deposit'); dep.clear(); announce('Work deposit saved ✓' + (r.check?.status === 'ok' ? (r.check.passed ? ' Script check passed.' : ' Script check: items missing, see below.') : '')); depositPage(root, me); }
    catch (e) { err.replaceChildren(errBox(e)); if (e.status && e.status < 500) clearId('deposit'); }
  }));
  const card = h('section', { class: 'card' }, h('h2', {}, 'Work deposit'),
    today.state === 'checked_in' ? form : empty('Check in first, then deposit your work here (or when you check out).'));
  const todays = h('section', { class: 'card' }, h('h2', {}, "Today's deposits"));
  if (!hist.deposits.length) todays.append(empty('None yet.'));
  for (const d of hist.deposits) todays.append(depositItem(d, () => depositPage(root, me)));
  root.replaceChildren(card, todays);
}

function depositItem(d, onChange) {
  return h('div', { class: 'item col' },
    h('div', {}, h('strong', {}, d.task_name || d.taskless_reason || 'No task'), ' ', h('span', { class: 'muted' }, fmtTime(d.created_at)), ' ', d.is_complete ? chip('Finished', 'ok') : chip('In progress')),
    h('div', {}, d.completed), d.pending ? h('div', { class: 'muted' }, 'Pending: ' + d.pending) : null,
    h('a', { href: d.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open work link'),
    d.review_note ? h('div', { class: 'note' }, 'Manager note: ' + d.review_note) : null,
    checkView(d.check_json, d.id, onChange));
}

export async function historyPage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let r; try { r = await get('/api/history?days=30'); } catch (e) { root.replaceChildren(errBox(e)); return; }
  const att = h('section', { class: 'card' }, h('h2', {}, 'My attendance (30 days)'));
  if (!r.attendance.length) att.append(empty('No attendance yet.'));
  else att.append(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Day', 'In', 'Out', ''].map((x) => h('th', {}, x)))),
    h('tbody', {}, r.attendance.map((a) => h('tr', {}, h('td', {}, fmtDate(a.check_in_at)), h('td', {}, fmtTime(a.check_in_at)),
      h('td', {}, a.check_out_at ? fmtTime(a.check_out_at) : a.status === 'missing_checkout' ? 'Missing' : 'Open'),
      h('td', {}, [a.corrected ? chip('Corrected') : null, a.checkout_exception ? chip('Tech problem', 'warn') : null, a.status === 'missing_checkout' ? chip('Needs fix', 'warn') : null]))))))); 
  const dep = h('section', { class: 'card' }, h('h2', {}, 'My work deposits'));
  if (!r.deposits.length) dep.append(empty('None yet.')); r.deposits.forEach((d) => dep.append(h('div', {}, h('div', { class: 'muted' }, fmtDateTime(d.created_at)), depositItem(d, () => historyPage(root, me)))));
  const ses = h('section', { class: 'card' }, h('h2', {}, 'Recorded task time'), h('p', { class: 'muted' }, 'Counted only while checked in and the task was In Progress. Not proof of focused editing.'));
  if (!r.sessions.length) ses.append(empty('None yet.'));
  r.sessions.forEach((s) => ses.append(h('div', { class: 'item' }, h('div', {}, h('strong', {}, s.task_name || s.task_id), ' ', s.kind === 'revision' ? chip('Revision', 'warn') : null),
    h('div', { class: 'right muted' }, `${fmtDate(s.start_ms)} ${fmtTime(s.start_ms)}–${s.end_ms ? fmtTime(s.end_ms) : 'now'} (${fmtDur((s.end_ms ?? Date.now()) - s.start_ms)})`))));
  root.replaceChildren(att, dep, ses);
}
export { depositItem };
