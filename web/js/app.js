import { h, $, get, post, field, busy, announce, errBox, setAuthLostHandler, setCurrentUser } from './core.js';
import { todayPage, historyPage } from './staff.js';
import { teamPage, taskPage, calendarPage, reportsPage, fixesPage } from './manager.js';
import { peoplePage, settingsPage, auditPage, legacyPage } from './admin.js';

const main = $('#main');
let me = null;

// Everyone who works (employees, and managers/the Owner when they have tasks) gets the same two work tabs first.
const OWN = [['today', 'Today', todayPage], ['history', 'My History & Reports', historyPage]];
const MGR = [['team', 'Team', teamPage], ['calendar', 'Calendar', calendarPage], ['reports', 'Reports', reportsPage], ['fixes', 'Corrections', fixesPage]];
const ADM = [['people', 'People', peoplePage], ['settings', 'Settings', settingsPage]];
const HIDDEN = [['audit', 'Audit history', auditPage], ['legacy', 'Old records', legacyPage]]; // reached from Settings

const pagesFor = (m) => (m.role === 'employee' ? { groups: [OWN] } : m.role === 'manager' ? { groups: [OWN, MGR] } : { groups: [OWN, [...MGR, ...ADM]] });

function authScreen(children) { $('#top').hidden = true; $('#sub').hidden = true; main.replaceChildren(h('div', { class: 'auth' }, h('h1', {}, 'YT Manager'), ...children)); }

async function boot() {
  let health; try { health = await get('/api/health'); } catch (e) { authScreen([errBox(e)]); return; }
  try { me = (await get('/api/me')).me; } catch { me = null; }
  if (!me) return health.needs_setup ? setupScreen() : loginScreen();
  setCurrentUser(me.id);
  if (me.must_change_pw) return passwordScreen(true);
  shell();
}
setAuthLostHandler(() => { if (me) { me = null; announce('Please sign in again.', 'err'); loginScreen(); } });

function loginScreen() {
  const email = h('input', { type: 'email', required: true, autocomplete: 'username', autofocus: true });
  const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const err = h('div', { 'aria-live': 'polite' });
  const go = h('button', { class: 'btn primary xl', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'card stack' }, field('Email', email), field('Password', pw), err, go);
  form.addEventListener('submit', busy(go, async (ev) => {
    ev.preventDefault(); err.replaceChildren();
    try { await post('/api/login', { email: email.value, password: pw.value }); await boot(); } catch (e) { err.replaceChildren(errBox(e)); }
  }));
  authScreen([form]);
}
function setupScreen() {
  const code = h('input', { type: 'password', required: true, autocomplete: 'off' });
  const name = h('input', { type: 'text', required: true }), email = h('input', { type: 'email', required: true });
  const pw = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  const err = h('div', { 'aria-live': 'polite' });
  const go = h('button', { class: 'btn primary xl', type: 'submit' }, 'Create owner account');
  const form = h('form', { class: 'card stack' }, h('p', {}, 'First-time setup. Enter the setup code you stored in Cloudflare.'), field('Setup code', code), field('Your name', name), field('Your email', email), field('Password (10+ characters)', pw), err, go);
  form.addEventListener('submit', busy(go, async (ev) => {
    ev.preventDefault(); err.replaceChildren();
    try { await post('/api/bootstrap', { token: code.value, name: name.value, email: email.value, password: pw.value }); await post('/api/login', { email: email.value, password: pw.value }); await boot(); } catch (e) { err.replaceChildren(errBox(e)); }
  }));
  authScreen([form]);
}
function passwordScreen(forced) {
  const cur = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const nw = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  const err = h('div', { 'aria-live': 'polite' });
  const go = h('button', { class: 'btn primary xl', type: 'submit' }, 'Save new password');
  const form = h('form', { class: 'card stack' }, h('p', {}, forced ? 'Choose your own password before you continue.' : 'Change password'), field(forced ? 'Temporary password' : 'Current password', cur), field('New password (10+ characters)', nw), err, go);
  form.addEventListener('submit', busy(go, async (ev) => {
    ev.preventDefault(); err.replaceChildren();
    try { await post('/api/password', { current: cur.value, next: nw.value }); announce('Password changed ✓'); await boot(); } catch (e) { err.replaceChildren(errBox(e)); }
  }));
  authScreen([form]);
}

function shell() {
  const pg = pagesFor(me);
  $('#top').hidden = false; $('#sub').hidden = true; $('#whoName').textContent = me.name;
  const all = [...pg.groups.flat(), ...(me.role === 'admin' ? HIDDEN : [])];
  const route = () => {
    const raw = (location.hash || '').slice(1);
    const [id, arg] = raw.split('/');
    clearInterval(todayPage.t);
    if (id === 'task' && arg && me.role !== 'employee') {
      renderNav('team'); taskPage(main, me, decodeURIComponent(arg)); main.focus({ preventScroll: true }); return;
    }
    const alias = { devices: 'people', tasks: 'today', deposit: 'today', submissions: 'team' }[id] || id;
    const page = all.find((p) => p[0] === alias) || pg.groups[0][0];
    if (!location.hash || page[0] !== id) history.replaceState(null, '', '#' + page[0]);
    renderNav(page[0]);
    page[2](main, me);
    main.focus({ preventScroll: true });
  };
  const renderNav = (cur) => {
    const nodes = [];
    pg.groups.forEach((g, i) => {
      if (i) nodes.push(h('span', { class: 'sep', 'aria-hidden': 'true' }));
      for (const p of g) nodes.push(h('a', { href: '#' + p[0], class: p[0] === cur ? 'on' : '', 'aria-current': p[0] === cur ? 'page' : null }, p[1]));
    });
    $('#nav').replaceChildren(...nodes);
  };
  window.onhashchange = route; route();
}
$('#logout').addEventListener('click', async () => { try { await post('/api/logout'); } catch {} me = null; location.hash = ''; loginScreen(); });
// let people change their own password later
window.addEventListener('keydown', (e) => { if (e.altKey && e.key === 'p' && me) passwordScreen(false); });
boot();
