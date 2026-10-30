# Security and real-world test report (2026-10-29)

Everything below was done on the free tier. The throwaway staging copy used for the live attack was deleted afterwards.

## How it was tested
1. **135 automated tests** (23 are adversarial) run on every change.
2. **Live attack and load test on a real Cloudflare copy** (35 checks, all passed), using real HTTPS, the real Cloudflare edge and real free-tier limits. The script is `scripts/livetest/attack-live.mjs`.
3. **Real browser test** with hostile names and values, on desktop and phone width.
4. **Non-destructive checks on the live site** (no logins, no data changes) after release.

## What an attacker or a careless user tried, and what happened
| Attack | Result |
|---|---|
| Every route as outsider / employee / manager / admin (190+ combinations) | Outsiders always 401, wrong roles always 403, right roles never wrongly refused, nothing crashed |
| One employee reading, noting, correcting or re-checking another person's records; one manager reaching another team | Refused every time, no data leaked |
| A manager changing or approving their own record, or another manager's | Refused (Owner only) |
| SQL injection and hostile strings in ~11 places x 7 payloads | No effect, no crash, tables intact |
| Stored XSS (`<img onerror>`, `<script>`) as names/updates, checked in a real browser | Shown as plain text, nothing executed |
| `javascript:`, `data:`, `file:` links | Refused |
| Oversized bodies, invalid JSON | 413 / 400 |
| Cross-site request forgery, foreign Origin | Refused |
| Cookie theft by script / over plain HTTP | Cookie is HttpOnly + Secure + SameSite=Strict; plain HTTP is redirected to HTTPS; HSTS on |
| Replaying a signed check-in, firing it twice at the same instant, using another person's nonce, expired nonce, using a check-in signature for check-out | Only one request wins; all others refused |
| Another person's password on someone's registered computer; unapproved or revoked computer | Refused |
| Faking the office network with `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`, `True-Client-IP`, `Forwarded`, a JSON field | **Verified on real Cloudflare:** Cloudflare itself answers 403 to a client-supplied `CF-Connecting-IP`; every other header is ignored; the server always used the real address |
| Forged, unsigned, tampered, malformed, oversized ClickUp webhooks | Refused (401/413) or handled without a crash |
| 100 shuffled ClickUp events with 20 duplicates | All accepted, duplicates ignored, every task ended in its true latest status |
| Guessing one account's password | Locked after 5 tries for 15 minutes |
| Flooding the login | Throttled per address; a whole office signing in normally is not slowed |
| 8 people clocking in, updating and clocking out at the same moment | 8 correct attendance rows, no duplicates, no cross-talk |
| Reading hashes/tokens/secrets from any API response | None present |
| Reloading a page 100 times to burn the free database write quota | Repeat loads now write nothing |

## Problems found and fixed during this testing
1. A malformed (but signed) ClickUp payload could crash the webhook handler (500).
2. An admin screen crashed (500) when ClickUp was not connected yet.
3. The site was reachable over plain HTTP, so a password typed on an `http://` link could travel unencrypted. Now every request is redirected to HTTPS.
4. Repeated page loads and a flood of fake-email logins could waste the free database write quota. Fixed (no-op rebuilds; no rows for unknown emails).
5. Added HSTS and a per-address and per-user flood guard.
6. Earlier: the ClickUp sync could be killed by the free CPU limit (now chunked); sign-in on the free CPU limit is fine (about 0.4 s, 15 in a row, no errors).

## Honest limits (not a guarantee of zero bugs)
- **Device binding proves the approved browser on a computer, not the person.** A person who lends their logged-in laptop cannot be detected.
- **Anyone who knows an email can lock that account for 15 minutes** with 5 wrong passwords. Accepted for a team of 8.
- **Flood protection is best-effort and free.** There is no paid firewall; Cloudflare's own network protection is the baseline. Free-tier daily limits (100,000 requests, 100,000 database writes) can in theory be exhausted by a determined attacker.
- **Single Owner = single point of failure.** Create a second admin account. Without one, recovering a lost Owner password needs the Cloudflare account.
- **The ClickUp token is powerful** (it can read your workspace). It is stored encrypted; if it leaks, regenerate it in ClickUp.
- **Not tested:** the ClickUp OAuth button (an API token is used), reading a real shared Google Doc, other people's real laptops and browsers, screen readers, and a professional human penetration test.
- **Backups are not active until you complete the three-secret setup in BACKUP.md.** Cloudflare keeps only 7 days of history on the free plan.

---

# Round 2 (2026-10-30): team-scale baseline, abuse and integrity audit

Scope: local test instance and automated fixtures only. No paid calls, no live data changed, nothing deployed yet. 158 tests pass (was 135).

## Confirmed findings (reproduced first, then fixed)
| # | Severity | Finding | Evidence before -> after | Fix (files / functions) |
|---|---|---|---|---|
| F1 | High | Reports and rebuilds made one or more database calls per task. At 8 people x 150 tasks a monthly report with comparison needed **7,351 calls / 1.8 s**; Cloudflare Free allows about 1,000 internal calls per request, so the Owner's Reports page and the 6-hourly report job would start failing after a month or two of history | 7,351 -> **263** calls, 1,802 -> **134 ms**; rebuild one person 70 -> 13 calls; rebuild all 8 688 -> 112 | `engine.js` new `loadTasksByIds`, `loadEventsByTask`, `relevantTasks`; `rebuildEmployee`; `reports.js employeeReport` |
| F2 | Medium | Names used as object keys were not safe. A job or rule named `__proto__` changed `Object.prototype` on the server (`{}.delivered` became `true`, `{}.total` became `NaN`); a ClickUp status named `constructor` classified as a function | reproduced in `test/audit2.test.js` | `lib/timer.js classify` (own keys only); null-prototype dictionaries in `reports.js`/`attendance.js`; `admin.js safeKey` + size caps; `engine.js statusMap`; `scriptcheck.js rulesFor` |
| F4 | Medium | Importing the old app's data: the page sent everything in one request (fails past 64 KB), different records sharing a date/time silently collapsed (250 sent, 140 kept), and work-log/task/video pieces were rejected as "Nothing to import" (found in the real-browser run) | 250 -> 250 kept; 250 attendance + 120 work logs + 2 people imported through the real Settings box | `admin.js importLegacy`; `web/js/admin.js importBox` (sends pieces of 100; safe to run twice) |
| F3 | Low (suspected, not reproduced) | Two approvers deciding one correction at the same instant could both apply it | could not trigger it locally | `corrections.js decide`: the request is claimed first; the attendance change and the audit line only happen if this call won |
| F5 | Low | `//evil.example` passed the link helper | reproduced in test | `web/js/core.js h()` |
| F6 | Low | Owner settings maps had no size limit | reproduced | `admin.js` caps (200 statuses, 20 jobs, 50 goals, 12 check jobs) |
| F7 | Low (privacy) | IP addresses were kept forever in attendance rows | reproduced | `index.js housekeeping`: erased after 180 days |

## Checked and clean
Stored XSS and DOM sinks (no `innerHTML`/`eval` anywhere in the page code), SQL injection (11 entry points x 7 payloads), token leaks (a saved ClickUp token appears in no API answer, audit line or listing; stored encrypted), server-side request forgery (the Google Docs reader only ever contacts `docs.google.com`, whatever a link says; ClickUp calls use fixed hosts and encoded ids), error output (no stack traces), logging (only error stacks, no secrets or personal data), CSV formula injection, duplicate/concurrent clicks, interrupted sync and backup (both resume).

## Workflow and performance
No screen, shortcut, permission, approval or number changed; all earlier tests pass unchanged. The only visible difference: the old-data import now shows "Importing attendance... 100 of 250" while it works.

## Remaining limits
- After 5 wrong passwords, a real email gets "too many attempts" while an unknown email keeps getting "wrong password", so an attacker can learn which emails exist. Left as is: fixing it needs a database write per made-up email, which would reopen the free write-quota problem.
- An unsigned flood of requests still counts toward the free 100,000 requests/day; Cloudflare's own network protection is the only defence.
- The 1,000-call limit comes from Cloudflare's documentation; it was not provoked on the live service.
- **These fixes are on GitHub (`dev`) but not deployed**: the live site still runs the previous version until you approve.
