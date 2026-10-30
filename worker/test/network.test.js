import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Client, setupTeam, makeEmployee, approve, giveShift, rid, OFFICE_IP } from './helpers.js';
import { handle } from '../src/index.js';
import { localMidnightMs } from '../src/lib/time.js';

const T0 = localMidnightMs('2026-12-21') + 10 * 3600000;
let admin, emp;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0);
  admin = await setupTeam();
  emp = await makeEmployee(admin, 'NetEmp');
  await approve(admin, emp); await giveShift(admin, emp.id, { start: 0, end: 1439, days: 127 });
});
afterAll(() => vi.useRealTimers());

// A request that Cloudflare would have labelled as coming from its own WARP network
async function viaWarp(client, method, path, body, sign) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers = { 'x-requested-with': 'ytm', 'content-type': 'application/json', 'cf-connecting-ip': '2a09:bac5:5020:2541::3b6:76', cookie: client.cookie };
  if (sign) Object.assign(headers, await client.signHeaders(method, path, text ?? '{}'));
  const res = await handle(new Request('https://ytm.test' + path, { method, headers, body: method === 'GET' ? undefined : (text ?? '{}'), cf: { asn: 13335 } }), env, { waitUntil() {} });
  return { status: res.status, data: await res.json() };
}

describe('VPN (Cloudflare WARP) and refused networks', () => {
  it('a person on a VPN is told to turn it off, not that their address is wrong', async () => {
    const r = await viaWarp(emp, 'POST', '/api/checkin', { request_id: rid() }, true);
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe('vpn_detected');
    expect(r.data.error.message).toMatch(/VPN.*turn it off/i);
  });
  it('the Owner cannot save a VPN address as the office; a normal address is still fine', async () => {
    const bad = await viaWarp(admin, 'POST', '/api/admin/settings', { office_ips: ['2a09:bac5:5020:2541::/64'] });
    expect(bad.status).toBe(400); expect(bad.data.error.code).toBe('vpn_address');
    const s = await viaWarp(admin, 'GET', '/api/admin/settings');
    expect(s.data.on_vpn).toBe(true);
    expect((await admin.post('/api/admin/settings', { office_ips: [OFFICE_IP] })).status).toBe(200);
    expect((await admin.get('/api/admin/settings')).data.on_vpn).toBe(false);
  });
  it('a refused attempt from an approved computer is listed for the Owner, with the VPN flag, and can be allowed in one click', async () => {
    const home = new Client('198.51.100.20'); home.cookie = emp.cookie; home.keys = emp.keys;
    expect((await home.post('/api/checkin', { request_id: rid() }, { sign: true })).data.error.code).toBe('not_office_network');
    const list = (await admin.get('/api/admin/network-refusals')).data.refusals;
    const home1 = list.find((x) => x.ip === '198.51.100.20'), vpn1 = list.find((x) => x.ip.startsWith('2a09:bac5'));
    expect(home1).toMatchObject({ name: 'NetEmp', is_vpn: 0, already_allowed: false });
    expect(vpn1.is_vpn).toBe(1);
    // allow it as the office, then the same person can check in from there
    expect((await admin.post('/api/admin/settings', { office_ips: [OFFICE_IP, '198.51.100.20'] })).status).toBe(200);
    expect((await home.post('/api/checkin', { request_id: rid() }, { sign: true })).status).toBe(200);
    expect((await admin.get('/api/admin/network-refusals')).data.refusals.find((x) => x.ip === '198.51.100.20').already_allowed).toBe(true);
  });
  it('the refusal log is bounded: repeated attempts update one row, outsiders and employees cannot read it', async () => {
    const home = new Client('203.0.113.77'); home.cookie = emp.cookie; home.keys = emp.keys;
    await env.DB.prepare("UPDATE attendance SET status='closed',check_out_at=check_in_at+1000 WHERE employee_id=?").bind(emp.id).run();
    await admin.post('/api/admin/settings', { office_ips: [OFFICE_IP] });
    for (let i = 0; i < 5; i++) { vi.setSystemTime(T0 + i * 61000 + 3600000); await home.post('/api/checkin', { request_id: rid() }, { sign: true }); }
    const rows = (await env.DB.prepare("SELECT count FROM network_refusals WHERE ip='203.0.113.77'").all()).results;
    expect(rows).toHaveLength(1); expect(rows[0].count).toBe(5);
    expect((await emp.get('/api/admin/network-refusals')).status).toBe(403);
    expect((await new Client().get('/api/admin/network-refusals')).status).toBe(401);
  });
});
