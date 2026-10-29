#!/bin/sh
# Decrypts a monthly backup and loads it into a NEW Cloudflare D1 database (never over the live one).
# Usage:  BACKUP_PASSWORD='...' ./scripts/restore-backup.sh backups/ytm-2026-12-01.sql.gz.enc ytm-restore
# Then point worker/wrangler.jsonc at the new database id (or copy what you need) and run:  npx wrangler deploy
set -eu
FILE="$1"; DB="${2:-ytm-restore}"
: "${BACKUP_PASSWORD:?set BACKUP_PASSWORD first}"
OUT="$(mktemp -d)/restore.sql"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSWORD -in "$FILE" | gunzip > "$OUT"
grep -q "CREATE TABLE employees" "$OUT" || { echo "Wrong password or damaged file"; exit 1; }
echo "Decrypted $(wc -c < "$OUT") bytes. Creating database $DB ..."
cd "$(dirname "$0")/../worker"
npx wrangler d1 create "$DB"
npx wrangler d1 execute "$DB" --remote --file "$OUT"
echo "Done. Check: npx wrangler d1 execute $DB --remote --command \"select count(*) from attendance\""
