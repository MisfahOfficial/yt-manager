import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { Client, setupTeam, makeEmployee, approve, rid, OFFICE_IP, HOME_IP } from './helpers.js';

let admin, alice, bob;
beforeAll(async () => {
  admin = await setupTeam();
  alice = await makeEmployee(admin, 'Alice');
  bob = await makeEmployee(admin, 'Bob');
  await approve(admin, alice);
  await approve(admin, bob);
});

describe('authentication', () => {
  it('bootstrap is one-time and needs the secret', async () => {
    const c = new Client();
    const r = await c.post('/api/bootstrap', { token: 'test-bootstrap-token', name: 'Evil', email: 'e@x.test', password: 'password-123456' });
    expect(r.status).toBe(403);
  });
  it('no cookie -> 401 on every protected route family', async () => {
    const c = new Client();
    for (const p of ['/api/today', '/api/team', '/api/admin/employees', '/api/reports', '/api/history']) {
      expect((await c.get(p)).status).toBe(401);
    }
  });
  it('wrong password fails with a generic message; lockout after 5 failures', async () => {
    const c = new Client();
    const bad = await c.post('/api/login', { email: 'alice@x.test', password: 'nope-nope-nope' });
    expect(bad.status).toBe(401);
    expect(bad.data.error.message).toMatch(/^Email or password is wrong/);
    await admin.post('/api/admin/employees', { name: 'Lockme', email: 'lockme@x.test' });
    for (let i = 0; i < 5; i++) await c.post('/api/login', { email: 'lockme@x.test', password: 'x' + i });
    expect((await c.post('/api/login', { email: 'lockme@x.test', password: 'x' })).status).toBe(429);
    // made-up emails are never locked and never written (cannot be used to burn the free write quota)
    for (let i = 0; i < 7; i++) expect((await c.post('/api/login', { email: 'nobody@x.test', password: 'x' + i })).status).toBe(401);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM login_attempts WHERE email='nobody@x.test'").first()).n).toBe(0);
  });
  it('passwords are stored only as salted hashes', async () => {
    const row = await env.DB.prepare('SELECT pw_hash,pw_salt FROM employees WHERE email=?').bind('alice@x.test').first();
    expect(row.pw_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.pw_hash).not.toContain('new-password');
  });
  it('first login with a temp password forces a change', async () => {
    const c = await admin.post('/api/admin/employees', { name: 'Carol', email: 'carol@x.test' });
    const cl = new Client();
    await cl.post('/api/login', { email: 'carol@x.test', password: c.data.temp_password });
    expect((await cl.get('/api/today')).data.error.code).toBe('must_change_password');
  });
  it('CSRF: missing custom header is rejected', async () => {
    const r = await alice.post('/api/logout', {}, { headers: { 'x-requested-with': 'other' } });
    expect(r.status).toBe(403);
  });
});

describe('role enforcement is server side', () => {
  it('employee cannot reach manager/admin APIs even by calling them directly', async () => {
    for (const [m, p] of [['GET', '/api/team'], ['GET', '/api/admin/employees'], ['GET', '/api/admin/audit'], ['GET', '/api/reports'], ['POST', '/api/admin/settings']]) {
      const r = await alice.req(m, p, m === 'POST' ? {} : undefined);
      expect(r.status).toBe(403);
    }
  });
  it('employee cannot read a coworker\'s task or changes endpoint', async () => {
    const r = await alice.post('/api/tasks/abc/changes', { notes: 'x' });
    expect(r.status).toBe(403);
  });
});

describe('device binding', () => {
  it('unapproved device cannot check in', async () => {
    const d = await makeEmployee(admin, 'Dave');
    const r = await d.post('/api/checkin', { request_id: rid() }, { sign: true });
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe('device_not_approved');
  });
  it('unsigned check-in is refused', async () => {
    const r = await alice.post('/api/checkin', { request_id: rid() });
    expect(r.data.error.code).toBe('device_signature_missing');
  });
  it("Bob's correct password on Alice's registered device cannot check in as Bob", async () => {
    const imposter = new Client();
    imposter.keys = alice.keys; // physically on Alice's laptop
    await imposter.post('/api/login', { email: 'bob@x.test', password: bob.password });
    const r = await imposter.post('/api/checkin', { request_id: rid() }, { sign: true });
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe('device_mismatch');
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM attendance WHERE employee_id=?').bind(bob.id).first()).n).toBe(0);
  });
  it("Alice's key cannot be registered to Bob", async () => {
    const r = await bob.post('/api/device', { jwk: alice.jwk });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('device_taken');
  });
  it('clearing browser data (new key) creates only a PENDING device that cannot check in', async () => {
    const wiped = new Client();
    await wiped.post('/api/login', { email: 'alice@x.test', password: alice.password });
    await wiped.genKeys();
    const reg = await wiped.post('/api/device', { jwk: wiped.jwk, label: 'after clearing data' });
    expect(reg.data.status).toBe('pending');
    const r = await wiped.post('/api/checkin', { request_id: rid() }, { sign: true });
    expect(r.status).toBe(403); // signature fails against Alice's approved key
  });
  it('replacing an approved device needs explicit confirmation and is audited', async () => {
    const e = await makeEmployee(admin, 'Erin');
    await approve(admin, e);
    const e2 = new Client(); e2.cookie = e.cookie; await e2.genKeys();
    const reg = await e2.post('/api/device', { jwk: e2.jwk, label: 'new laptop' });
    const noConfirm = await admin.post(`/api/admin/devices/${reg.data.id}/approve`, {});
    expect(noConfirm.status).toBe(409);
    expect((await admin.post(`/api/admin/devices/${reg.data.id}/approve`, { replace: true })).status).toBe(200);
    const a = await env.DB.prepare("SELECT action FROM audit_log WHERE entity='device' AND entity_id=? ORDER BY id DESC").bind(reg.data.id).first();
    expect(a.action).toBe('device_replaced');
    // old key now useless
    const old = await e.post('/api/checkin', { request_id: rid() }, { sign: true });
    expect(old.status).toBe(403);
  });
  it('a nonce cannot be replayed', async () => {
    const body = JSON.stringify({ request_id: rid() });
    const hdr = await alice.signHeaders('POST', '/api/checkin', body);
    const first = await alice.req('POST', '/api/checkin', undefined, { raw: body, headers: hdr });
    expect(first.status).toBe(200);
    await alice.post('/api/checkout', { exception_reason: 'cleanup after replay test' }, { sign: true });
    const replay = await alice.req('POST', '/api/checkin', undefined, { raw: body, headers: hdr });
    expect(replay.status).toBe(401);
    expect(replay.data.error.code).toBe('device_nonce_invalid');
  });
  it('a signature for one body cannot be reused with a different body', async () => {
    const hdr = await bob.signHeaders('POST', '/api/checkin', JSON.stringify({ request_id: 'aaaaaaaa-1' }));
    const r = await bob.req('POST', '/api/checkin', undefined, { raw: JSON.stringify({ request_id: 'bbbbbbbb-2' }), headers: hdr });
    expect(r.data.error.code).toBe('device_mismatch');
  });
});

describe('office network', () => {
  it('approved device from outside the office is refused', async () => {
    const home = new Client(HOME_IP); home.cookie = alice.cookie; home.keys = alice.keys;
    const r = await home.post('/api/checkin', { request_id: rid() }, { sign: true });
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe('not_office_network');
  });
  it('a client-supplied X-Forwarded-For does not grant access', async () => {
    const home = new Client(HOME_IP); home.cookie = bob.cookie; home.keys = bob.keys;
    const r = await home.post('/api/checkin', { request_id: rid() }, { sign: true, headers: { 'x-forwarded-for': OFFICE_IP, 'x-real-ip': OFFICE_IP } });
    expect(r.data.error.code).toBe('not_office_network');
  });
  it('a client-supplied ip in the JSON body is ignored', async () => {
    const home = new Client(HOME_IP); home.cookie = bob.cookie; home.keys = bob.keys;
    const r = await home.post('/api/checkin', { request_id: rid(), ip: OFFICE_IP }, { sign: true });
    expect(r.data.error.code).toBe('not_office_network');
  });
  it('time-boxed admin exception allows attendance and is audited; revoking closes it', async () => {
    const home = new Client(HOME_IP); home.cookie = bob.cookie; home.keys = bob.keys;
    const ex = await admin.post('/api/admin/network-exceptions', { reason: 'Office internet outage today', hours: 2, employee_id: bob.id });
    expect(ex.status).toBe(200);
    const ok = await home.post('/api/checkin', { request_id: rid() }, { sign: true });
    expect(ok.status).toBe(200);
    const row = await env.DB.prepare('SELECT network_exception_id FROM attendance WHERE employee_id=?').bind(bob.id).first();
    expect(row.network_exception_id).toBe(ex.data.id);
    await home.post('/api/checkout', { exception_reason: 'closing out after outage test' }, { sign: true });
    await admin.post(`/api/admin/network-exceptions/${ex.data.id}/revoke`, {});
    const again = await home.post('/api/checkin', { request_id: rid() }, { sign: true });
    expect(again.data.error.code).toBe('not_office_network');
  });
  it('fails closed when no office network is configured', async () => {
    await admin.post('/api/admin/settings', { office_ips: [] });
    const r = await alice.post('/api/checkin', { request_id: rid() }, { sign: true });
    expect(r.data.error.code).toBe('network_not_configured');
    await admin.post('/api/admin/settings', { office_ips: [OFFICE_IP] });
  });
});
