# Migration, backup and rollback

## What was backed up
* Source of the original app: `yt-manager/original-backup/` (full git clone of `AbdulHaseebAwan/Misfah-YT-Manger` at commit `ad937ee`), plus `legacy-index.html` in this repo.
* The old **data** (members, attendance, work logs, tasks, videos) lives only in AbdulHaseeb's Google Sheet/Apps Script and in each browser's localStorage. It was **not** copied: we have no access to it, and calling his backend would expose his employees' data. Ask him for the Sheet export (or have him press "pull" in the old app and send the exported JSON).

## What we found in the old app (and fixed by design)
* Passwords: default manager `admin123`, plain-text passwords in localStorage and in the Sheet, `1234` as default. → individual accounts, hashed passwords, forced change.
* Attendance was keyed by (member, **date**) with device-local `HH:MM` strings and the string `Incomplete`; a second check-in the same day overwrote the first; the pull merge was "last write wins"; failed POSTs were swallowed (`gsPost` returned `false`) while the screen still said saved. These are the most likely causes of the missing data (not proven without the Sheet). → server timestamps, unique-open-record rule, request ids, atomic writes, honest save state.
* IP restriction was done in the browser with a public IP lookup service. → server-observed address only.
* The Apps Script URL was hard-coded to someone else's backend. → removed entirely. This app never contacts it.

## Importing the old history (when you have the export)
1. Settings → "Imported old records" → paste the JSON (`{members, attendance, workLogs, tasks, calVideos}` as the old app exports).
2. People are created with random one-time passwords (old passwords are never imported) and placeholder emails `…@import.invalid`. Set each real email under People → Manage.
3. Old attendance/work logs/tasks/videos are stored read-only in `legacy_records` with the original ids (`legacy_id`). They are **not** converted into new attendance, because their times were device-local strings, not trustworthy timestamps. Reports show new data only. Re-running the import is safe (duplicates are ignored).

## Rollback
* The new system does not change the old one. To go back, keep using the old GitHub Pages site; nothing was removed.
* To undo a bad deploy: `npx wrangler rollback` (Cloudflare keeps previous versions), or check out the previous commit and `npx wrangler deploy`.
* To undo bad data changes: every correction is in Audit history with before/after values. The database can be exported at any time: `npx wrangler d1 export ytm --remote --output backup.sql` (do this before every migration; keep the file private, it contains employee data).
* Do not commit `backup.sql`, `.dev.vars` or any export to GitHub.
