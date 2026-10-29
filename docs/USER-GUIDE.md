# YT Manager: user guide

Address: https://yt-manager.mohammadkhan8910.workers.dev  (use your own laptop, on the office network)

## Employees (2 tabs)
**Today**
1. Open the site, sign in. First time: choose your own password, then press **Set up this computer** once and wait for the Owner to approve it.
2. Press the green **Clock in**. If it refuses, the message says why (usually: not on the office Wi-Fi, or the computer is not approved yet).
3. Work in ClickUp as usual. When a task is **In Progress** and you are clocked in, your time is recorded by itself. **My Work** shows your task, its deadline and status.
4. Press **Update** when you want to save progress: a link and one sentence. Optional: what is pending or blocked.
5. **Switch** (under "more tasks") = count your time on that task instead. Only works for tasks already In Progress in ClickUp.
6. At the end press the red **Clock out**. One window lists the tasks you worked on: link (already filled from last time) and one sentence for each task that has no update yet. Done.
7. Something broke and you cannot submit? In that window choose **Can't submit?** and write what went wrong. You are clocked out with the real time and your manager sees the reason.

**My History & Reports**: your goal % for the week or month, tasks done, days present, recorded time, your updates. A wrong time? **Request correction** on that day (your manager or the Owner decides).

## Managers
Same two tabs first (if you also have tasks), then **Team**, **Calendar**, **Reports**, **Corrections**.
- **Team**: who is in, what they are on and its deadline, the latest update, blockers, who has no update today. **Open** a row for the task page: **Work** (updates with links), **Time** (per day), **History** (plain-words changes). **Request changes** is optional.
- **Calendar**: videos by channel and upload day, straight from ClickUp. Change a video in ClickUp, not here.
- **Reports**: weekly or monthly results with the columns the Owner chose.
- **Corrections**: approve or decline requests, or **Ask** the person / **Set time** for a missing clock-out. You cannot change your own record: the Owner does.

## Owner
Everything above plus **People** and **Settings**.
- **People**: add a person (they get a one-time password: send it privately), set their **Job**, ClickUp account, manager and shift. Approve their computer when they set it up (top of the page). **Reset password** if forgotten.
- **Settings** has links at the top: Office network (use **Add my current address** while sitting in the office with any VPN off), outage exception, ClickUp (token, workspace, live updates, end-of-day time), status meanings per job, channels, work categories, script/title checks, shifts, reports, audit history, old records.
- **Reports → Customise reports**: choose columns, the weekly goal per job, and the comparison with earlier periods (only you ever see the comparison).
- Create a **second Owner/Admin account** for yourself or someone you trust so you are never locked out.

## Weekly 5-minute check (Owner)
1. Team page: ClickUp says "Up to date"? If not, press **Sync now**.
2. Corrections: anything waiting?
3. Reports: anything under "Needs your attention"?
4. Settings → Channels: a "+ add" suggestion means a new channel code appeared in ClickUp.
5. Backups: see BACKUP.md (monthly, needs the one-time set-up).

## If something looks wrong
| You see | What it means / do this |
|---|---|
| "You can only check in or out from the office network. The server sees your address as …" | Not on the office network, or the office address changed. Owner: Settings → Office network → add the address shown (only while in the office). |
| "Waiting for admin approval" | The Owner must approve this computer (People page). |
| "Too many wrong attempts" | Wait a minute (or 15 minutes after 5 wrong passwords on one account). |
| Task time stays at 0 | The task must be In Progress in ClickUp, you must be clocked in, and the ClickUp account must be linked under People. A task that was already In Progress before the first sync starts counting after its next status change. |
| ClickUp "Out of date" | Press **Sync now**. If it says access was revoked, reconnect ClickUp in Settings. |
