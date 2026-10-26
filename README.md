# YT Manager

Attendance, work deposits, ClickUp task time and weekly/monthly reports for a small editing team (about 8 people).
Runs on free tiers only: **Cloudflare Workers + D1** (backend and website) — nothing on GitHub Pages and no Google Apps Script.

This is an independent fork of `AbdulHaseebAwan/Misfah-YT-Manger`. The old single-file app is kept as `legacy-index.html` for reference only. It is not connected to anyone else's backend.

## What it does
| Role | Sees |
|---|---|
| Employee | Today (check in/out, current task, recorded time) · My Tasks · Work Deposit · My History |
| Manager | Team overview · Work Submissions (+ optional "Request changes") · Weekly/Monthly Reports · Attendance (corrections only if granted) |
| Owner/Admin | Everything above + People · Computers · Settings (office network, ClickUp, shifts, reports) · Audit history |

Permissions are enforced by the server on every request (`worker/src/index.js` route table + per-handler team scoping). Hiding a button is never the protection.

## How the rules are enforced
* **Identity** comes only from a server session cookie (HttpOnly, Secure, SameSite=Strict). No employee id is ever accepted from the page.
* **Passwords**: PBKDF2-SHA256 with per-user salt. Admin-issued passwords are random and must be changed at first sign-in. Nothing is stored or listed in plain text. 5 failed logins lock an email for 15 minutes.
* **One approved computer per person**: each computer creates a non-extractable ECDSA P-256 key in the browser. Attendance requests must be signed with a single-use server nonce, the HTTP method, path and body hash. The server verifies the signature against *that employee's* approved key. Registering the same key for two people is rejected. Replacing a computer needs an explicit, audited admin action.
* **Office network**: the Worker reads the client address Cloudflare puts in `CF-Connecting-IP`. The address typed in the page or sent in any other header is ignored. If no office address is configured, check-in is refused. Genuine outages: admin creates a time-boxed, reasoned, audited exception.
* **Server time**: every attendance time is the server clock (stored as UTC milliseconds, shown as Asia/Karachi).
* **Saved means saved**: the page shows "saved" only after the server confirmed. A failed save keeps the form content and the same request id, so a retry can never create a second record. Check-out and its work deposit are written in one database transaction.
* **Recorded task time** is a pure function of facts (`worker/src/lib/timer.js`): attendance ∩ approved shift window ∩ task in an eligible ClickUp status ∩ assigned to the person, with at most one timed task per person. Event time is ClickUp's own timestamp, never arrival or sync time. It is called "recorded task time", not proof of focused editing.
* **ClickUp**: ClickUp stays the source of truth. Live status history comes from signed webhooks (HMAC-SHA256 `X-Signature`, de-duplicated, order-independent). One scheduled end-of-day reconcile at an admin-set Karachi time plus a "Sync now" button. If webhooks missed a change, the gap is labelled and **not counted**.

## Honest limits
Read `docs/LIMITATIONS.md` before relying on this. In short: device binding proves "the approved browser profile on that computer", not "the person"; browser data cleared ⇒ the computer must be re-approved (by design); IPv6/CGNAT office networks need care; the free Workers CPU limit (10 ms) has to be confirmed after deploy.

## Run the tests
```bash
cd worker
npm install
npm test
```

## Deploy
Follow `docs/DEPLOY.md` (plain-language steps, about 20 minutes). Migration from the old app and rollback: `docs/MIGRATION.md`.
