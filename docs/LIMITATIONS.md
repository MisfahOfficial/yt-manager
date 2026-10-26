# Limits and guarantees (read this)

## Device binding — what it really guarantees
* A browser cannot read a laptop's serial number or MAC address. Fingerprinting, user-agent and cookies are not hardware binding, so they are **not** used.
* We use a **non-extractable cryptographic key stored in the browser profile** (WebCrypto ECDSA P-256, IndexedDB). The key cannot be copied out by page code, and the server verifies a fresh signature on every attendance request.
* Guarantees: another person's password cannot be used from someone else's registered browser profile; a new/unknown browser cannot mark attendance; the same key cannot be registered to two people; replay of a captured request fails (single-use nonce).
* **Not guaranteed**: it identifies a *browser profile on a computer*, not a *person*. If someone hands over their logged-in laptop, it cannot tell. Malware or a person with full control of the profile can use the key while it is on that computer. Clearing browser data or using another browser/profile removes the key — the computer then needs admin approval again (this is intentional and audited).
* Passkeys/WebAuthn were evaluated. A synced passkey (iCloud/Google) can move between devices, so it would **weaken** "one computer". Hardware-bound WebAuthn with attestation can be enforced only on managed devices; not assumed here.

## Office network
* The server trusts only `CF-Connecting-IP`, which Cloudflare's edge sets. **Verify after deploy** (see DEPLOY step 9) by sending a request with a fake `CF-Connecting-IP`/`X-Forwarded-For` header from outside the office: it must still be refused.
* Phones on office Wi-Fi share the office address, so the network check always works together with the approved-computer check, never alone.
* If the office address changes, an admin updates it in Settings (or opens a time-boxed outage exception).
* Dynamic home/commute addresses are blocked simply because they are not in the list. A VPN that exits from the office address would pass the network check (device check still applies).
* IPv6: add the office prefix as a range (for example `2001:db8:1234::/64`).

## Free-tier limits (checked in official docs on 2026-10-26)
| Service | Free limit | Our use (8 people) |
|---|---|---|
| Workers | 100,000 requests/day, 10 ms CPU per request, 5 cron triggers, 50 subrequests per run | roughly 1–2k requests/day; 1 cron (every 15 min) |
| D1 | 5 M rows read/day, 100 k rows written/day, 5 GB | well under |
| Static assets on Workers | no request charge | the website |
| ClickUp API | 100 requests/minute per token (Free/Unlimited/Business) | one sync/day + webhooks |
Limits can change; re-check before relying on them.

**10 ms CPU risk:** password hashing (PBKDF2, 100,000 iterations) measured about 7 ms locally. If Cloudflare reports "Exceeded CPU" on sign-in, set `PBKDF2_ITER` to `50000` in `wrangler.jsonc` and redeploy (existing passwords keep working). Large first-time ClickUp imports are chunked and continue on the next cron tick.

## ClickUp
* Without webhooks, exact start/stop times cannot be known from a daily snapshot. Until "Live updates" is on, recorded task time stays empty by design.
* Tasks that were already In Progress before webhooks started have no known start time. They are counted from their next real status change, not guessed.
* Webhook retry/suspension behaviour is not described in the public docs we read: the "Live updates" status in Settings shows the last event received; the daily reconcile flags any gap.
* The exact ClickUp payload field names are handled defensively but were **not** tested against a live ClickUp workspace (no ClickUp access in this build). Test with one real task first (DEPLOY step 10).
* ClickUp OAuth needs an OAuth app created by a ClickUp workspace admin. Until then, an API token works.

## Reports
* "Delivered / Ready for Upload" is not "quality approved". On-time uses the deadline in force when it fell due; later extensions after a miss are shown but do not erase the miss.
* Blocker reasons are only what ClickUp records; otherwise the report says "No reason recorded in ClickUp".
* Employee/channel breakdown uses the ClickUp List name as the channel. Work type is not set unless added later.
* No ranking, no quality score, no salary/discipline decisions.
