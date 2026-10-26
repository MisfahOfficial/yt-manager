# YT Manager audit (2026-10-26)

## Existing
- Repo AbdulHaseebAwan/Misfah-YT-Manger (public, main, 2 commits). Single `index.html` (2984 lines). Backup: `original-backup/`.
- Auth: client-side only. Default manager password `admin123` in source. Passwords stored plaintext in localStorage/DB and synced to sheet.
- Data: localStorage `ytm_v3` primary; Google Sheet via Apps Script is a push/pull mirror. `gsPost` swallows errors (returns false) and no-cors-style text/plain; UI shows saved before backend confirms. Likely cause of "missing data": browser-only records, `getAll` pull overwriting local, no idempotency keys.
- Backend URL hardcoded (`HARDCODED_GS_URL`, line 2651) = AbdulHaseeb's Apps Script. `?action=getAll` is unauthenticated. NOT called during audit (his data, not yours).
- IP restriction: browser fetches api.ipify.org and compares client-side. Bypassable. Not security.
- Timer: localStorage countdown. No ClickUp. No device binding.

## Feasibility (official docs)
- Apps Script `doGet/doPost` event: only queryString, parameter(s), pathInfo, contextPath, contentLength, postData. No headers, no client IP. => cannot enforce office network. Cannot read `X-Signature` => cannot verify ClickUp webhooks.
- Apps Script consumer quotas: 90 min/day trigger runtime, 6 min/execution, 30 simultaneous.
- ClickUp webhook: `X-Signature` = HMAC-SHA256 hex of raw body with webhook.secret.
- Cloudflare Workers free: 100k req/day, 10 ms CPU/request, 5 cron triggers, 50 subrequests. D1 free: 5M reads/day, 100k writes/day, 5 GB. Worker sees client IP via CF-Connecting-IP (set by Cloudflare edge). Request headers + raw body available.
- WebAuthn: platform authenticator credential can be non-exportable on a device, but synced passkeys (iCloud/Google) can move between devices. Attestation is the only way to prove device-bound; not guaranteed on consumer laptops.

## Conclusion
Apps Script cannot meet network restriction or webhook verification. Proposed: Cloudflare Workers + D1 + cron (free), static frontend on GitHub Pages under MisfahOfficial. Sheet kept as read-only export/legacy import.

## Missing access
1. Cloudflare account (free) + `wrangler login` by you.
2. ClickUp: workspace admin to create OAuth app (client id/secret) or personal token for pilot.
3. Original Sheet / Apps Script data: only AbdulHaseeb can export. Need export or access.
4. Office public IP(s).
5. Employee list, shifts, ClickUp user mapping.
