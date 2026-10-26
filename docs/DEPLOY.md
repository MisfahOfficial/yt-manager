# Deploy (about 20 minutes, no coding)

You need: a free Cloudflare account, Node.js on your Mac, and the `MisfahOfficial/yt-manager` repository.
Cost: **$0/month**. Do not add a card or upgrade a plan.

1. **Get the code**
   ```bash
   git clone https://github.com/MisfahOfficial/yt-manager.git
   cd yt-manager && git checkout dev
   cd worker && npm install
   ```
2. **Sign in to Cloudflare** (opens your browser):
   ```bash
   npx wrangler login
   ```
3. **Create the database** and copy the `database_id` it prints into `worker/wrangler.jsonc` (replace the zeros):
   ```bash
   npx wrangler d1 create ytm
   ```
4. **Create the tables**:
   ```bash
   npx wrangler d1 migrations apply ytm --remote
   ```
5. **Set the secrets** (each command asks you to type the value; they are never stored in GitHub):
   ```bash
   npx wrangler secret put BOOTSTRAP_TOKEN      # any long random phrase: your first-time setup code
   npx wrangler secret put ENCRYPTION_KEY       # exactly 64 hex characters: run  openssl rand -hex 32
   ```
   Keep the ENCRYPTION_KEY in your password manager. If you lose it, ClickUp must be reconnected.
6. **Deploy**:
   ```bash
   npx wrangler deploy
   ```
   It prints your address, like `https://yt-manager.<your-name>.workers.dev`.
7. **First sign-in**: open the address. Enter the setup code, your name, email and a password (10+ characters). This creates the owner account. The setup screen disappears forever after that.
8. **Office network**: sit in the office on the office network, open Settings → Office network → "Add my current address". Check the address looks right. (Outside the office this list must stay empty or correct.)
9. **Prove the network check cannot be faked** (from home, not the office):
   ```bash
   curl -s -X POST https://YOUR-ADDRESS/api/checkin -H 'x-requested-with: ytm' -H 'CF-Connecting-IP: <office address>' -H 'X-Forwarded-For: <office address>' -d '{}'
   ```
   You must get an error (not logged in is fine). Then, signed in as an employee at home, check-in must say "only from the office network". If check-in ever works from home, stop and tell me.
10. **People**: People → Add person (writes down a one-time password for each). Give each person a shift (Settings → Shifts, then People → Manage → Shift). Each person opens the site on *their own* laptop, signs in, clicks "Set up this computer". You approve under Computers.
11. **ClickUp**:
    * Settings → ClickUp → paste an API token (ClickUp: Settings → Apps → API Token), or create a ClickUp OAuth app (redirect URL `https://YOUR-ADDRESS/api/clickup/callback`, then `npx wrangler secret put CLICKUP_CLIENT_ID` and `CLICKUP_CLIENT_SECRET`) and press "Connect with ClickUp".
    * Choose the workspace. Press "Turn on live updates" (this registers the webhook and stores its signing secret).
    * People → Manage → pick each person's ClickUp account.
    * Press "Sync now". Move one real test task to In Progress and then Ready for Upload, and confirm it appears (Team page, then a person's recorded time).
12. **Check the free-limit risk**: sign in several times and look in Cloudflare → Workers → yt-manager → Logs for "Exceeded CPU". If you see it, set `PBKDF2_ITER` to `50000` in `wrangler.jsonc`, redeploy.

## Optional: auto-deploy from GitHub
`.github/workflows/deploy.yml` deploys when `main` changes, after tests pass. It needs two GitHub secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). Skip it if unsure; manual `wrangler deploy` is fine.

## Staging first
To try changes safely: `npx wrangler deploy --name yt-manager-staging` with a second database (`wrangler d1 create ytm-staging`). Never point staging at the real database.
