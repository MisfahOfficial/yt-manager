# Backups and long-term storage

**Live data:** Cloudflare D1 database `ytm` (free limit 500 MB per database; today well under 1 MB).

## What happens automatically (nothing to set up, free)
- **Every week** the app makes an encrypted backup of the whole database and keeps it in Cloudflare KV (free, 1 GB). Backups are never deleted automatically, so you keep the whole year (about 52 small files).
- Encryption: AES-256-GCM with your `ENCRYPTION_KEY`. Without that key a backup cannot be opened. **Keep the key in your password manager.**
- Not included: login sessions, login attempt logs, one-time nonces (they are not needed to restore).
- Cloudflare itself only keeps 7 days of restore history on the free plan, so these weekly backups are what protect you beyond that.

## What the Owner does (about 2 minutes a month)
Settings, **Backups & downloads**:
1. **Back up now** (optional, any time).
2. **Download** the latest backup and drop it in the private Google Drive folder **YT Manager Backups**. This is the copy that survives even if the Cloudflare account has a problem.
3. Once a year (or when needed): **Attendance / Work updates / Monthly summary** download as CSV. In Google Sheets: File, Import, Upload. These files contain employee data: keep them in the private folder.

## Restore (tested)
A restore always goes into a **new** database, never over the live one.
```bash
ENCRYPTION_KEY=<your 64-hex key> node scripts/restore-from-backup.mjs ytm-backup-2026-12-14.ytmb > restore.sql
cd worker
npx wrangler d1 create ytm-restore
# point a copy of wrangler.jsonc at the new database id, then:
npx wrangler d1 migrations apply ytm-restore --remote
npx wrangler d1 execute ytm-restore --remote --file ../restore.sql
```
Then deploy the app against the restored database (or copy the rows you need). `ENCRYPTION_KEY` and `BOOTSTRAP_TOKEN` are not in a backup: they live in Cloudflare secrets and your password manager.

## What was tested
- A backup decrypts to exactly the live tables (counts match); the file contains no readable emails, hashes or text.
- Wrong key: refused. Wrong date: 404. Only the Owner can list, run, download or export.
- The weekly schedule makes one backup, waits a week, and splits large tables into small parts so a step never exceeds the free CPU limit.
- A real restore into an empty database reproduced every table (the owner's password hash included), apart from audit lines written after the backup was taken.
- CSV files neutralise spreadsheet formulas (a name starting with `=`, `+`, `-` or `@` cannot run code).

## Optional extra: GitHub copy
`.github/workflows/backup.yml` can also push a monthly encrypted SQL export to the private repo `MisfahOfficial/yt-manager-backups`. It needs three secrets (Cloudflare API token, GitHub token, backup password) that only you can create, so it is **off until you add them**. The KV backups above already cover the main risk, and the Drive copy covers the rest.
