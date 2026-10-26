import { h, $, get, post, field, busy, announce, errBox, setAuthLostHandler, setCurrentUser } from './core.js';
import { todayPage, tasksPage, depositPage, historyPage } from './staff.js';
import { teamPage, submissionsPage, reportsPage, fixesPage } from './manager.js';
import { peoplePage, devicesPage, settingsPage, auditPage } from './admin.js';

const main = $('#main');
let me = null;

const EMP = [['today', 'Today', todayPage], ['tasks', 'My Tasks', tasksPage], ['deposit', 'Work Deposit', depositPage], ['history', 'My History', historyPage]];
const MGR = [['team', 'Team', teamPage], ['submissions', 'Work Submissions', submissionsPage], ['reports', 'Reports', reportsPage], ['fixes', 'Attendance', fixesPage]];
const ADM = [['people', 'People', peoplePage], ['devices', 'Computers', devicesPage], ['settings', 'Settings', settingsPage]];
const HIDDEN = [['audit', 'Audit history', auditPage]]; // reached from Settings

const pagesFor = (m) => (m.role === 'employee' ? { main: EMP, sub: [] } : m.role === 'manager' ? { main: MGR, sub: EMP } : { main: [...MGR, ...ADM], sub: EMP });

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
  $('#top').hidden = false; $('#whoName').textContent = me.name;
  const all = [...pg.main, ...pg.sub, ...(me.role === 'admin' ? HIDDEN : [])];
  const route = () => {
    const id = (location.hash || '').slice(1);
    const page = all.find((p) => p[0] === id) || pg.main[0];
    if (!location.hash || page[0] !== id) { history.replaceState(null, '', '#' + page[0]); }
    const link = (p, el) => h('a', { href: '#' + p[0], class: p[0] === page[0] ? 'on' : '', 'aria-current': p[0] === page[0] ? 'page' : null }, p[1]);
    $('#nav').replaceChildren(...pg.main.map((p) => link(p)));
    const sub = $('#sub'); sub.hidden = !pg.sub.length;
    sub.replaceChildren(h('span', { class: 'subl' }, 'My work:'), ...pg.sub.map((p) => link(p)));
    clearInterval(todayPage.t);
    page[2](main, me);
    main.focus({ preventScroll: true });
  };
  window.onhashchange = route; route();
}
$('#logout').addEventListener('click', async () => { try { await post('/api/logout'); } catch {} me = null; location.hash = ''; loginScreen(); });
// let people change their own password later
window.addEventListener('keydown', (e) => { if (e.altKey && e.key === 'p' && me) passwordScreen(false); });
boot();
