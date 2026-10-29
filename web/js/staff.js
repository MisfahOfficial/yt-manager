import { h, get, post, field, dialog, busy, announce, chip, empty, errBox, fmtTime, fmtDate, fmtDateTime, fmtDur, toInput, fromInput, uid, draft, localDevice, createLocalDevice, checkView } from './core.js';

// One pending request id per action: a retry after a failed save reuses it, so the server can never double-record.
const pendingId = (k) => { let v = sessionStorage.getItem('ytm-rid:' + k); if (!v) { v = uid(); sessionStorage.setItem('ytm-rid:' + k, v); } return v; };
const clearId = (k) => sessionStorage.removeItem('ytm-rid:' + k);
const sameDay = (a, b) => fmtDate(a) === fmtDate(b);

// ---------------------------------------------------------------- device card (only when something must be done)
async function deviceCard(me) {
  const local = await localDevice(me.id);
  const card = h('section', { class: 'card' });
  if (!local) {
    card.append(h('h2', {}, 'Set up this computer'), h('p', { class: 'muted' }, 'Your admin must approve it once.'));
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Set up this computer');
    b.addEventListener('click', busy(b, async () => {
      try { const rec = await createLocalDevice(me.id); await post('/api/device', { jwk: rec.jwk, label: (navigator.platform || 'Computer').slice(0, 40) }); announce('Sent. Your admin must approve this computer.'); location.reload(); }
      catch (e) { announce(e.message, 'err'); }
    }));
    card.append(b);
    return { card, ok: false };
  }
  let list;
  try { list = (await get('/api/device?fp=' + local.fp)).devices; } catch (e) { card.append(errBox(e)); return { card, ok: false }; }
  const mine = list.find((d) => d.this_device);
  if (mine?.status === 'approved') return { card: null, ok: true };
  card.append(h('h2', {}, mine?.status === 'pending' ? 'Waiting for admin approval' : 'This computer is not approved'),
    h('p', { class: 'muted' }, mine?.status === 'pending' ? 'You can clock in as soon as it is approved.' : 'Ask your admin to approve it.'));
  if (!mine || mine.status === 'revoked') {
    const b = h('button', { class: 'btn', type: 'button' }, 'Ask again');
    b.addEventListener('click', busy(b, async () => { try { const rec = await createLocalDevice(me.id); await post('/api/device', { jwk: rec.jwk, label: 'Computer' }); location.reload(); } catch (e) { announce(e.message, 'err'); } }));
    card.append(b);
  }
  return { card, ok: false };
}

// ---------------------------------------------------------------- TODAY
export async function todayPage(root, me) {
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let t;
  try { t = await get('/api/today'); } catch (e) { root.replaceChildren(errBox(e)); return; }
  const dev = await deviceCard(me);
  const loadedAt = Date.now();
  const a = t.attendance;
  const open = t.state === 'checked_in';
  const doneToday = !open && a && a.check_out_at && sameDay(a.check_out_at, t.server_time);
  const line = h('div', { class: 'date' }, `${fmtDate(t.server_time)} · ${t.shift ? `Shift ${fmtTime(t.shift.start_ms)} to ${fmtTime(t.shift.end_ms)}` : 'No shift today'}`);
  const out = [];
  const reload = () => todayPage(root, me);

  // asked to confirm a missing clock-out
  for (const q of t.asked || []) {
    const b = h('button', { class: 'btn small', type: 'button' }, 'Fix it');
    b.addEventListener('click', () => correctionDialog({ id: q.id, check_in_at: q.check_in_at, check_out_at: null }, reload));
    out.push(h('div', { class: 'warnbox row between' }, h('span', {}, `Please confirm when you left on ${fmtDate(q.check_in_at)}.`), b));
  }

  if (!open && !doneToday) {                                   // 1. before clock-in
    const hero = h('section', { class: 'card hero' }, line, h('div', { class: 'state' }, 'Not clocked in'));
    const msg = h('div', { 'aria-live': 'polite' });
    if (dev.ok) {
      const b = h('button', { class: 'btn go xl', type: 'button' }, 'Clock in');
      b.addEventListener('click', busy(b, async () => {
        msg.replaceChildren();
        try { await post('/api/checkin', { request_id: pendingId('checkin') }, { sign: true }); clearId('checkin'); announce('Clocked in ✓'); reload(); }
        catch (e) { msg.replaceChildren(errBox(e)); if (e.status && e.status < 500 && e.code !== 'device_nonce_invalid') clearId('checkin'); }
      }));
      hero.append(b, msg);
    }
    out.push(hero);
    if (dev.card) out.push(dev.card);
  } else if (open) {                                           // 2. working
    const mins = h('div', { class: 'muted', id: 'elapsed' }, fmtDur(t.server_time - a.check_in_at));
    const co = h('button', { class: 'btn stop xl', type: 'button' }, 'Clock out');
    co.addEventListener('click', () => clockOutDialog(me, t, reload));
    out.push(h('section', { class: 'card hero' }, line, h('div', { class: 'state' }, `Clocked in ${fmtTime(a.check_in_at)}`), mins, co));
    out.push(myWorkCard(me, t, reload, loadedAt));
    if (t.created) out.push(titlesCard(t.created));
    clearInterval(todayPage.t);
    todayPage.t = setInterval(() => { mins.textContent = fmtDur(t.server_time - a.check_in_at + (Date.now() - loadedAt)); }, 30000);
  } else {                                                     // 4. after clock-out
    const link = h('a', { href: '#history' }, 'View');
    out.push(h('section', { class: 'card hero' }, line, h('div', { class: 'state' }, `Clocked out ${fmtTime(a.check_out_at)}`),
      h('div', { class: 'muted' }, fmtDur(a.check_out_at - a.check_in_at)), h('p', {}, chip('✓ Work saved', 'ok'), ' ', link)));
    if (t.created) out.push(titlesCard(t.created));
  }
  root.replaceChildren(...out);
}

function myWorkCard(me, t, reload, loadedAt) {
  const card = h('section', { class: 'card' });
  const active = t.my_work.find((x) => x.active);
  card.append(h('div', { class: 'row between' }, h('h2', {}, 'My Work'), h('span', { class: 'muted small' }, `Today ${fmtDur(t.recorded_ms_today + (active ? Date.now() - loadedAt : 0))}`)));
  if (t.needs_task_choice.length) {
    card.append(h('p', { class: 'warn-text' }, 'Which task are you on?'));
    for (const c of t.needs_task_choice) {
      const b = h('button', { class: 'btn', type: 'button' }, c.name);
      b.addEventListener('click', busy(b, async () => { try { await post('/api/active-task', { task_id: c.id }); reload(); } catch (e) { announce(e.message, 'err'); } }));
      card.append(h('div', { class: 'row', style: null }, b));
    }
  } else if (active) {
    const up = h('button', { class: 'btn small', type: 'button' }, 'Update');
    up.addEventListener('click', () => updateDialog(t, active.id, reload));
    card.append(h('div', { class: 'row between' }, h('div', {}, h('strong', {}, active.name),
      h('div', { class: 'row small' }, chip(active.status || '', 'ok'), t.active_task?.kind === 'revision' ? chip('Revision', 'warn') : null, h('span', { class: 'muted' }, active.due_ms ? `Due ${fmtDate(active.due_ms)}` : 'No deadline'),
        active.url ? h('a', { href: active.url, target: '_blank', rel: 'noopener noreferrer' }, 'ClickUp') : null)), up));
  } else if (t.unverified_tasks?.length) {
    card.append(h('div', { class: 'warnbox' }, `"${t.unverified_tasks[0].name}" is not timed yet. Move it out of In Progress and back in ClickUp.`));
  } else card.append(empty(t.my_work.length ? 'Nothing is In Progress.' : 'No tasks assigned to you.'));
  const others = t.my_work.filter((x) => !x.active);
  if (others.length) {
    const d = h('details', { class: 'more' }, h('summary', { class: 'muted' }, `${others.length} more task${others.length > 1 ? 's' : ''}`));
    for (const x of others) {
      let right;
      if (x.can_switch) { right = h('button', { class: 'btn small', type: 'button', title: 'Count your time on this task instead' }, 'Switch'); right.addEventListener('click', busy(right, async () => { try { await post('/api/active-task', { task_id: x.id }); reload(); } catch (e) { announce(e.message, 'err'); } })); }
      else right = chip(x.class === 'paused' ? 'Blocked' : x.status || 'To Do', x.class === 'paused' ? 'warn' : '');
      d.append(h('div', { class: 'item row between' }, h('div', {}, x.name, x.due_ms ? h('span', { class: 'muted small' }, ` · ${fmtDate(x.due_ms)}`) : null), right));
    }
    d.append(h('p', { class: 'muted small' }, 'Switch = count your time on that task instead. Only one task is timed. A task still To Do is started in ClickUp.'));
    card.append(d);
  }
  return card;
}

const titlesCard = (c) => h('section', { class: 'card' }, h('h2', {}, 'Titles you added'), h('p', { class: 'big2' }, `${c.today} today · ${c.week} this week`),
  h('p', { class: 'muted' }, Object.keys(c.by_code).length ? Object.entries(c.by_code).sort().map(([k, v]) => `${k}: ${v}`).join(' · ') : 'Nothing this week yet.'));

// ---------------------------------------------------------------- UPDATE (progress on one task)
function updateDialog(t, taskId, reload) {
  const tasks = t.my_work;
  const sel = h('select', {}, tasks.map((x) => h('option', { value: x.id, selected: x.id === taskId }, x.name)), h('option', { value: '' }, 'Other work (no task)'));
  const why = h('input', { type: 'text', maxlength: 300, placeholder: 'What kind of work?' });
  const link = h('input', { type: 'url', required: true, placeholder: 'https://drive.google.com/…', inputmode: 'url' });
  const did = h('textarea', { rows: 3, required: true, maxlength: 4000, placeholder: 'e.g. Intro and 12 sections edited; 8 remaining' });
  const pend = h('textarea', { rows: 2, maxlength: 4000 });
  const whyF = field('Kind of work', why); whyF.hidden = true;
  const prefill = () => { whyF.hidden = sel.value !== ''; const w = t.worked_tasks.find((x) => x.id === sel.value); const d = draft.get('upd:' + sel.value) || {}; link.value = d.link || w?.last_link || ''; did.value = d.did || ''; pend.value = d.pend || ''; };
  sel.addEventListener('change', prefill); prefill();
  const form = h('form', { class: 'stack', novalidate: true, id: 'upd-form' }, field('Task', sel), whyF, field('Link', link), field('What did you do?', did), h('details', {}, h('summary', { class: 'muted small' }, 'Pending or blocked?'), pend));
  form.addEventListener('input', () => draft.set('upd:' + sel.value, { link: link.value, did: did.value, pend: pend.value }));
  const err = h('div', { 'aria-live': 'polite' }); form.append(err);
  dialog('Update', form, (close) => {
    const go = h('button', { class: 'btn primary', type: 'submit', form: 'upd-form' }, 'Save');
    form.addEventListener('submit', busy(go, async (ev) => {
      ev.preventDefault(); err.replaceChildren();
      if (!form.reportValidity()) return;
      try {
        await post('/api/progress', { request_id: pendingId('upd'), task_id: sel.value || null, taskless_reason: sel.value ? null : why.value, link: link.value, completed: did.value, pending: pend.value });
        clearId('upd'); draft.del('upd:' + sel.value); announce('Saved ✓'); close(); reload();
      } catch (e) { err.replaceChildren(errBox(e)); if (e.status && e.status < 500) clearId('upd'); }
    }));
    return [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), go];
  });
}

// ---------------------------------------------------------------- CLOCK OUT (one dialog, several tasks)
function clockOutDialog(me, t, reload) {
  const rows = t.worked_tasks.map((w) => ({ w, kind: 'task' }));
  const form = h('form', { class: 'stack', novalidate: true, id: 'co-form' });
  const err = h('div', { 'aria-live': 'polite' });
  const entries = []; // { w, link, did, pend, include, el }

  const addRow = (w, other = false) => {
    const key = 'co:' + (w?.id || 'other:' + entries.length);
    const d = draft.get(key) || {};
    const link = h('input', { type: 'url', placeholder: 'https://…', value: d.link || w?.last_link || '', inputmode: 'url' });
    const did = h('textarea', { rows: 2, maxlength: 4000, placeholder: 'One sentence', value: d.did || '' }); did.value = d.did || '';
    const pend = h('textarea', { rows: 2, maxlength: 4000 }); pend.value = d.pend || '';
    const why = h('input', { type: 'text', maxlength: 300, placeholder: 'What kind of work?', value: d.why || '' });
    const done = !other && w.has_update;
    const body = h('div', { class: 'stack' }, other ? field('Kind of work', why) : null, field('Link', link), field('What did you do?', did), h('details', {}, h('summary', { class: 'muted small' }, 'Pending or blocked?'), pend));
    const el = h('div', { class: 'item' });
    const e = { w, other, link, did, pend, why, key, el, optional: done, skipped: false, body };
    const head = h('div', { class: 'row between' }, h('strong', {}, other ? 'Other work' : w.name),
      done ? h('span', {}, chip('Update saved ✓', 'ok'), ' ', (() => { const x = h('button', { class: 'btn small', type: 'button' }, 'Add more'); x.addEventListener('click', () => { body.hidden = !body.hidden; }); return x; })())
        : (!other ? (() => { const x = h('button', { class: 'btn small', type: 'button' }, 'Not today'); x.addEventListener('click', () => { e.skipped = !e.skipped; body.hidden = e.skipped; x.textContent = e.skipped ? 'Add' : 'Not today'; }); return x; })() : null));
    body.hidden = done;
    el.append(head, body);
    const save = () => draft.set(key, { link: link.value, did: did.value, pend: pend.value, why: why.value });
    el.addEventListener('input', save);
    entries.push(e); form.insertBefore(el, moreLink || err);
  };
  const moreLink = h('a', { href: '#', class: 'small', onclick: (ev) => { ev.preventDefault(); addRow(null, true); } }, '+ Other work');
  form.append(moreLink, err);
  for (const r of rows) addRow(r.w);
  if (!rows.length) addRow(null, true);

  const exc = h('details', { class: 'exception' }, h('summary', { class: 'muted small' }, "Can't submit?"),
    h('p', { class: 'muted small' }, 'You are clocked out now with the real time. Your manager sees the reason.'),
    field('What went wrong?', h('input', { type: 'text', id: 'exc', maxlength: 500 })));
  form.append(exc);

  dialog('Clock out', form, (close) => {
    const go = h('button', { class: 'btn stop', type: 'submit', form: 'co-form' }, 'Submit & clock out');
    form.addEventListener('submit', busy(go, async (ev) => {
      ev.preventDefault(); err.replaceChildren();
      const exception = exc.open && form.querySelector('#exc').value.trim();
      const body = { request_id: pendingId('checkout') };
      if (exception) body.exception_reason = exception;
      else {
        const updates = [];
        for (const e of entries) {
          const filled = e.did.value.trim() || e.link.value.trim();
          if (e.skipped || (!filled && (e.optional || e.other))) continue;
          if (!e.link.value.trim() || !e.did.value.trim()) { err.replaceChildren(errBox({ message: `Add a link and one sentence for ${e.other ? 'the other work' : e.w.name}, or choose "Not today".` })); return; }
          updates.push({ task_id: e.other ? null : e.w.id, taskless_reason: e.other ? (e.why.value || 'Other work') : null, link: e.link.value, completed: e.did.value, pending: e.pend.value });
        }
        if (updates.length) body.updates = updates;
        else if (!t.deposit_count) { err.replaceChildren(errBox({ message: 'Add one update before you clock out.' })); return; }
      }
      try {
        const r = await post('/api/checkout', body, { sign: true });
        clearId('checkout'); entries.forEach((e) => draft.del(e.key));
        announce((r.exception ? 'Clocked out ✓ Your manager sees the problem.' : 'Saved ✓ Clocked out') + (r.check?.status === 'ok' && !r.check.passed ? ' Script check: items missing, see My History.' : ''));
        close(); reload();
      } catch (e) { err.replaceChildren(errBox(e)); if (e.status && e.status < 500 && e.code !== 'device_nonce_invalid') clearId('checkout'); }
    }));
    return [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), go];
  });
}

// ---------------------------------------------------------------- correction request (employee asks, never edits)
export function correctionDialog(att, done) {
  const day = att.check_in_at;
  const out = h('input', { type: 'time', required: true, value: att.check_out_at ? fmtTime(att.check_out_at) : '' });
  const inn = h('input', { type: 'time', value: fmtTime(att.check_in_at) });
  const why = h('input', { type: 'text', required: true, minlength: 5, maxlength: 500, placeholder: 'One sentence' });
  const toMs = (hhmm, base) => (hhmm ? fromInput(`${new Date(base + 5 * 3600000).toISOString().slice(0, 10)}T${hhmm}`) : null);
  const err = h('div', { 'aria-live': 'polite' });
  dialog(`Correction · ${fmtDate(day)}`, h('div', { class: 'stack' }, field('Clock-in should be', inn), field('Clock-out should be', out), field('Reason', why), err), (close) => {
    const go = h('button', { class: 'btn primary', type: 'button' }, 'Send');
    go.addEventListener('click', busy(go, async () => {
      err.replaceChildren();
      try {
        const body = { attendance_id: att.id, check_out_at: toMs(out.value, day), reason: why.value };
        if (inn.value && inn.value !== fmtTime(att.check_in_at)) body.check_in_at = toMs(inn.value, day);
        await post('/api/correction-requests', body);
        announce('Sent ✓'); close(); done?.();
      } catch (e) { err.replaceChildren(errBox(e)); }
    }));
    return [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), go];
  });
}

// ---------------------------------------------------------------- MY HISTORY & REPORTS
export async function historyPage(root, me) {
  const kind = historyPage.kind || 'weekly';
  root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  let r, hist;
  try { [r, hist] = await Promise.all([get('/api/me/report?kind=' + kind), get('/api/history?days=30')]); } catch (e) { root.replaceChildren(errBox(e)); return; }
  const week = kind === 'weekly';
  const tab = (k, l) => { const b = h('button', { class: 'btn' + (kind === k ? ' on' : ''), type: 'button' }, l); b.addEventListener('click', () => { historyPage.kind = k; historyPage(root, me); }); return b; };
  const g = r.goal;
  const goalCard = h('section', { class: 'card' }, h('div', { class: 'muted small' }, `${week ? 'Weekly' : 'Monthly'} goal`));
  if (g) goalCard.append(h('div', { class: 'row' }, h('span', { class: 'big' }, `${g.pct}%`), h('span', { class: 'muted' }, `${g.count} of ${g.target} ${g.metric}`)), h('div', { class: 'bar' }, h('i', { style: null })));
  else goalCard.append(h('p', { class: 'muted' }, 'No goal is set for your job yet.'));
  if (g) goalCard.querySelector('.bar i').style.width = Math.min(100, g.pct) + '%';
  goalCard.append(h('div', { class: 'facts' },
    h('div', { class: 'fact' }, h('div', { class: 'l' }, 'Days present'), h('div', { class: 'v' }, `${r.days_present} of ${r.days_scheduled}`)),
    h('div', { class: 'fact' }, h('div', { class: 'l' }, 'Tasks delivered'), h('div', { class: 'v' }, String(r.tasks_done.length))),
    h('div', { class: 'fact' }, h('div', { class: 'l' }, 'Recorded task time'), h('div', { class: 'v' }, fmtDur(r.recorded_ms)))));
  if (r.incomplete_period) goalCard.append(h('p', { class: 'muted small' }, 'Period not finished yet.'));

  const done = h('section', { class: 'card' }, h('h2', {}, 'Tasks done'));
  if (!r.tasks_done.length) done.append(empty('None yet.'));
  for (const t of r.tasks_done) done.append(h('div', { class: 'item row between' }, h('a', { href: t.url || '#', target: '_blank', rel: 'noopener noreferrer' }, t.name || t.task_id), chip(`Ready for Upload · ${fmtDate(t.delivered_at)}`, 'ok')));
  if (r.created) done.append(h('p', { class: 'muted' }, `Titles created: ${r.created.total}`));

  const days = h('section', { class: 'card' }, h('h2', {}, 'Days'));
  if (!r.attendance.length) days.append(empty('No days yet.'));
  else days.append(h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, r.attendance.map((a) => h('tr', {},
    h('td', {}, fmtDate(a.check_in_at)), h('td', {}, `${fmtTime(a.check_in_at)} to ${a.check_out_at ? fmtTime(a.check_out_at) : a.status === 'missing_checkout' ? 'missing' : 'now'}`),
    h('td', {}, a.check_out_at ? fmtDur(a.check_out_at - a.check_in_at) : ''), h('td', {}, `${a.updates} update${a.updates === 1 ? '' : 's'}`),
    h('td', {}, a.correction_pending ? chip('Request sent') : (() => { const x = h('a', { href: '#' }, 'Request correction'); x.addEventListener('click', (ev) => { ev.preventDefault(); correctionDialog(a, () => historyPage(root, me)); }); return x; })())))))));

  const ups = h('details', { class: 'card' }, h('summary', {}, 'My updates (30 days)'));
  if (!hist.deposits.length) ups.append(empty('None yet.'));
  for (const d of hist.deposits) ups.append(h('div', { class: 'item col' }, h('div', {}, h('strong', {}, d.task_name || d.taskless_reason || 'Other work'), ' ', h('span', { class: 'muted small' }, fmtDateTime(d.created_at))), h('div', {}, d.completed), d.pending ? h('div', { class: 'muted small' }, 'Pending: ' + d.pending) : null,
    h('a', { href: d.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open link'), d.review_note ? h('div', { class: 'note' }, 'Note: ' + d.review_note) : null, checkView(d.check_json, d.id, () => historyPage(root, me))));
  root.replaceChildren(h('div', { class: 'tabs' }, tab('weekly', 'This week'), tab('monthly', 'This month')), goalCard, done, days, ups);
}
