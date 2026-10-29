# Long-term backups

**Where the data lives:** Cloudflare D1 (database `ytm`, free limit 500 MB per database; today about 0.5 MB).
**What Cloudflare keeps on the free plan:** only the last 7 days (Time Travel). Nothing outside Cloudflare.
**What this adds:** every month, an encrypted copy goes to the private repository `MisfahOfficial/yt-manager-backups`. It is free, kept for as long as you want, and survives a Cloudflare problem.

## One-time set-up (about 10 minutes, you do it so the secrets never pass through chat)
1. **Backup password.** Choose a long phrase and store it in your password manager. Without it a backup cannot be opened, and nobody can recover it for you.
2. **Cloudflare token.** Cloudflare dashboard, My Profile, API Tokens, Create Token, "Edit Cloudflare Workers" template or a custom token with *Account, D1, Edit*, limited to your account. Copy the token once.
3. **GitHub token.** GitHub, Settings, Developer settings, Fine-grained tokens, Generate. Repository access: only `yt-manager-backups`. Permission: Contents, Read and write.
4. **Save the three secrets** in the app repository (each command asks you to paste the value):
   ```bash
   gh secret set BACKUP_PASSWORD -R MisfahOfficial/yt-manager
   gh secret set CLOUDFLARE_API_TOKEN -R MisfahOfficial/yt-manager
   gh secret set BACKUP_REPO_TOKEN -R MisfahOfficial/yt-manager
   gh secret set CLOUDFLARE_ACCOUNT_ID -R MisfahOfficial/yt-manager --body 399a204e053d5a17fd49587d87284c30
   ```
5. **The workflow must be on the default branch** (`main`) to run by itself. Merge the `dev` branch into `main` (or make `dev` the default branch) when you are happy with the app.
6. **Test it once:** GitHub, repository `yt-manager`, Actions, "monthly-backup", Run workflow. A file `backups/ytm-YYYY-MM-DD.sql.gz.enc` should appear in `yt-manager-backups`.

## Restore (tested)
The restore creates a **new** database. It never overwrites the live one.
```bash
BACKUP_PASSWORD='your phrase' ./scripts/restore-backup.sh backups/ytm-2026-12-01.sql.gz.enc ytm-restore
```
Check the counts it prints, then point `worker/wrangler.jsonc` at the new database id and run `npx wrangler deploy`. Secrets (`ENCRYPTION_KEY`, `BOOTSTRAP_TOKEN`) are not in a backup: keep them in your password manager.

## What was tested
Encrypt, decrypt, compare: identical. Wrong password: no data. Loading a real export into an empty scratch database restored all tables (4 people, 422 tasks, 513 events, 1 attendance record at test time).

## Good habits
- Keep the encrypted files; they are small (about 30 KB now).
- Once a year download one backup to your own computer or Drive as a second copy.
- Never put an unencrypted export (`.sql`) in GitHub.
