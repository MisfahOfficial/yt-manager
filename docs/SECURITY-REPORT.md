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
