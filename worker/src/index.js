import { HttpError, json, readJson, forbidden } from './http.js';
import * as auth from './auth.js';
import * as att from './attendance.js';
import * as work from './work.js';
import * as cl from './clickup.js';
import * as rep from './reports.js';
import * as adm from './admin.js';
import { sweepMissingCheckouts } from './engine.js';

const E = 'employee', M = 'manager', A = 'admin';
// [method, path, handler, who]  who: 'public' | roles allowed
const ROUTES = [
  ['POST', '/api/bootstrap', auth.bootstrap, 'public'],
  ['POST', '/api/login', auth.login, 'public'],
  ['POST', '/api/webhooks/clickup', cl.webhook, 'public', { raw: true }],
  ['GET', '/api/health', async (c) => json({ ok: true, needs_setup: !(await c.env.DB.prepare("SELECT 1 FROM employees WHERE role='admin'").first()) }), 'public'],
  ['POST', '/api/logout', auth.logout, [E, M, A]],
  ['GET', '/api/me', (c) => json({ me: { id: c.emp.id, name: c.emp.name, email: c.emp.email, role: c.emp.role, can_correct: !!c.emp.can_correct, must_change_pw: !!c.emp.must_change_pw, clickup_linked: !!c.emp.clickup_user_id } }), [E, M, A]],
  ['POST', '/api/password', auth.changePassword, [E, M, A]],
  ['GET', '/api/challenge', auth.issueChallenge, [E, M, A]],
  ['POST', '/api/device', auth.registerDevice, [E, M, A]],
  ['GET', '/api/device', auth.myDeviceStatus, [E, M, A]],

  ['GET', '/api/today', att.today, [E, M, A]],
  ['POST', '/api/checkin', att.checkIn, [E, M, A]],
  ['POST', '/api/checkout', att.checkOut, [E, M, A]],
  ['GET', '/api/history', att.myHistory, [E, M, A]],
  ['GET', '/api/tasks/mine', work.myTasks, [E, M, A]],
  ['POST', '/api/deposits', work.createDeposit, [E, M, A]],
  ['POST', '/api/active-task', work.chooseActive, [E, M, A]],
  ['GET', '/api/tasks/:id', work.taskDetail, [E, M, A]],

  ['GET', '/api/team', work.teamOverview, [M, A]],
  ['GET', '/api/submissions', work.submissions, [M, A]],
  ['GET', '/api/team/tasks', work.teamTasks, [M, A]],
  ['POST', '/api/tasks/:id/changes', work.requestChanges, [M, A]],
  ['POST', '/api/deposits/:id/note', work.reviewNote, [M, A]],
  ['GET', '/api/reports', rep.getReport, [M, A]],
  ['GET', '/api/attendance', adm.attendanceList, [M, A]],
  ['POST', '/api/attendance', att.addMissingAttendance, [M, A]],
  ['POST', '/api/attendance/:id/correct', att.correctAttendance, [M, A]],

  ['GET', '/api/admin/employees', adm.listEmployees, [A]],
  ['POST', '/api/admin/employees', adm.createEmployee, [A]],
  ['POST', '/api/admin/employees/:id', adm.updateEmployee, [A]],
  ['POST', '/api/admin/employees/:id/reset-password', adm.resetPassword, [A]],
  ['POST', '/api/admin/employees/:id/shift', adm.assignShift, [A]],
  ['POST', '/api/admin/employees/:id/leave', adm.addLeave, [A]],
  ['POST', '/api/admin/employees/:id/overtime', adm.addOvertime, [A]],
  ['GET', '/api/admin/shifts', adm.listShifts, [A]],
  ['POST', '/api/admin/shifts', adm.saveShift, [A]],
  ['GET', '/api/admin/devices', adm.listDevices, [A]],
  ['POST', '/api/admin/devices/:id/approve', adm.approveDevice, [A]],
  ['POST', '/api/admin/devices/:id/revoke', adm.revokeDevice, [A]],
  ['GET', '/api/admin/settings', adm.getSettings, [A]],
  ['GET', '/api/admin/statuses', adm.statusList, [A]],
  ['POST', '/api/admin/settings', adm.putSettings, [A]],
  ['GET', '/api/admin/network-exceptions', adm.listNetworkExceptions, [A]],
  ['POST', '/api/admin/network-exceptions', adm.createNetworkException, [A]],
  ['POST', '/api/admin/network-exceptions/:id/revoke', adm.revokeNetworkException, [A]],
  ['GET', '/api/admin/audit', adm.auditList, [A]],
  ['GET', '/api/admin/clickup/health', cl.health, [M, A]],
  ['POST', '/api/admin/clickup/token', cl.saveToken, [A]],
  ['POST', '/api/admin/clickup/oauth', cl.oauthStart, [A]],
  ['GET', '/api/clickup/callback', cl.oauthCallback, 'public'],
  ['GET', '/api/admin/clickup/members', cl.members, [A]],
  ['POST', '/api/admin/clickup/webhook', cl.createWebhook, [A]],
  ['POST', '/api/admin/clickup/sync', cl.syncNow, [M, A]],
  ['POST', '/api/admin/import-legacy', adm.importLegacy, [A]],
  ['GET', '/api/admin/legacy', adm.legacyList, [A]],
].map(([method, path, handler, who, opts]) => ({
  method, handler, who, opts: opts || {},
  re: new RegExp('^' + path.replace(/:[a-z]+/g, '([^/]+)') + '$'), names: [...path.matchAll(/:([a-z]+)/g)].map((m) => m[1]),
}));

function match(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (m) return { r, params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}
const pathExists = (pathname) => ROUTES.some((r) => r.re.test(pathname));

export async function handle(request, env, execCtx) {
  const url = new URL(request.url);
  const now = Date.now();
  try {
    const m = match(request.method, url.pathname);
    if (!m) {
      if (pathExists(url.pathname)) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      throw new HttpError(404, 'not_found', 'Not found.');
    }
    const { r, params } = m;
    const ctx = { env, req: request, url, now, params, emp: null, body: {}, rawBody: '', waitUntil: (p) => execCtx?.waitUntil(p) };
    const mutating = request.method !== 'GET' && request.method !== 'HEAD';
    if (mutating && !r.opts.raw) {
      // CSRF: custom header cannot be sent cross-site without CORS approval (we send none); Origin must match when present.
      if (request.headers.get('x-requested-with') !== 'ytm') throw forbidden('csrf', 'Bad request origin.');
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) throw forbidden('csrf', 'Bad request origin.');
    }
    if (mutating) {
      const parsed = await readJson(request, r.opts.raw ? 512 * 1024 : 64 * 1024);
      ctx.body = parsed.body; ctx.rawBody = parsed.text;
      if (typeof ctx.body !== 'object' || ctx.body === null || Array.isArray(ctx.body)) ctx.body = {};
    }
    if (r.who !== 'public') {
      ctx.emp = await auth.loadSession(ctx);
      if (!ctx.emp) throw new HttpError(401, 'not_logged_in', 'Please sign in.');
      if (!r.who.includes(ctx.emp.role)) throw forbidden();
      const allowedWhileTemp = ['/api/password', '/api/logout', '/api/me'];
      if (ctx.emp.must_change_pw && !allowedWhileTemp.includes(url.pathname)) throw new HttpError(403, 'must_change_password', 'Please choose a new password first.');
    }
    const res = await r.handler(ctx);
    return res;
  } catch (e) {
    if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message, ...(e.extra ? { details: e.extra } : {}) } }, e.status);
    console.error('unhandled', e && e.stack || e);
    return json({ error: { code: 'server_error', message: 'Something went wrong on our side. Nothing was saved. Please try again.' } }, 500);
  }
}

// keep tables small: nothing here is needed after it expires
async function housekeeping(db, now) {
  await db.batch([
    db.prepare('DELETE FROM nonces WHERE expires_at<?').bind(now),
    db.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now),
    db.prepare('DELETE FROM login_attempts WHERE at<?').bind(now - 86400000),
    db.prepare('DELETE FROM idempotency WHERE at_ms<?').bind(now - 14 * 86400000),
  ]);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handle(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    const now = Date.now();
    ctx.waitUntil((async () => {
      await sweepMissingCheckouts(env.DB, now);
      await housekeeping(env.DB, now);
      await cl.cronTick(env, now);
      await rep.autoReports(env, now);
    })());
  },
};
