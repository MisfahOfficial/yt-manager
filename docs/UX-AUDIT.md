# YT Manager: usability and operations audit

Audit date: 2026-10-29. Read-only: no code, settings, accounts, tasks, attendance or production records were changed.
Scope: YT Manager only. Local Video Studio and the VLOUSA tool were not touched.

How to read the labels: **Verified** = seen in code, in an automated test, or in read-only counts from production. **Estimate** = my calculation, not a measurement. **Unverified** = not tested, stated so you do not assume it works.

## 1. Verdict

The foundation is sound: server-side permissions, signed device check, office-network check, idempotent saves, a pure timing engine, and live ClickUp events are all built and tested. The **screens are shaped like an admin tool, not like a daily tool for people who just want to work**.

The four biggest problems:
1. **Work is reported in three places.** Today's check-out form, a separate "Work Deposit" page, and "My History" all deal with the same submission. (Verified in `web/js/app.js` and `staff.js`.)
2. **Check-out asks for the most for the least.** One task per submission, five inputs (task, link, completed, finished tick, pending), nothing reused from earlier in the day. A second task means leaving to another page. (Verified in `staff.js`.)
3. **Managers cannot see a task's story in one place.** The server already produces a task timeline (status history, first Ready for Upload, deadline changes, revisions: `GET /api/tasks/:id`) but **no screen uses it**. (Verified by search: only `/changes`, `/recheck` and `/api/tasks/mine` are called from the UI.)
4. **Employees cannot see their own reports or ask for a correction.** Reports are manager/admin only (`/api/reports` allows manager and admin), and only managers or admins can correct attendance. (Verified in `worker/src/index.js`.)

## 2. Screen by screen

| Screen | Who | Decision | Reason |
|---|---|---|---|
| Today | Employee | **FIX** | Must lead with Clock in/out. Today it also shows a device card and an empty "Current task" card before check-in, and never shows the date or shift. |
| My Tasks | Employee | **MERGE into Today** ("My Work") | Duplicates ClickUp. Needed only as "what am I on / what else is assigned". |
| Work Deposit | Employee | **MERGE into Today** (Update progress + check-out) | Second route to the same submission. |
| My History | Employee | **KEEP, rename "My History & Reports"** | Add own weekly/monthly summary and "Request correction" on a day. |
| Password (Alt+P shortcut) | All | **FIX** | Hidden shortcut. Put "Change password" in a small account menu. |
| Team | Manager/Admin | **KEEP + FIX** | Add deadline per active task, "needs review" and "missing submission" flags, rows open the new task detail. |
| Work Submissions | Manager/Admin | **MERGE into Team** | Flat list with no context; submissions belong inside employee/task detail. |
| Task detail | Manager/Admin | **ADD (UI only)** | Server side exists; build one timeline view. |
| Reports | Manager/Admin | **KEEP** | Correct content; add "my own" version for employees. |
| Attendance | Manager/Admin | **KEEP, rename "Corrections"** | Also becomes the inbox for employee correction requests. |
| People | Admin | **KEEP** | Add a small "computers waiting for approval" notice. |
| Computers | Admin | **MERGE into People + a notice on Team** | Rarely used after setup. |
| Settings | Admin | **KEEP, group into sections** | Office network, ClickUp (connection, statuses, sync), Shifts, Checks, Reports, Audit. Already one long page; add section anchors. |
| Audit history | Admin | **KEEP inside Settings** | Already reached from Settings. |

Removed from the **employee** view (already absent from the API for employees, so this is navigation only): coworker data, admin/integration settings, organisation dashboards. Verified: employee requests to those routes return 403 (tests in `security.test.js`).

## 3. Recommended employee navigation and Today

Navigation: **Today** · **My History & Reports**. That is all. "My Work" is a section inside Today.

**State 1: before check-in.** Date, approved shift ("Afternoon 14:00 to 20:00"), "Not checked in", one big **Clock in** button. Nothing else. If a check fails, one plain message with the fix ("You are not on the office Wi-Fi. Connect to the office network and press Clock in again" / "This computer is waiting for admin approval"). Device set-up appears here only when needed.

**State 2: working.** "Clocked in since 14:02" and one **Clock out** button. Below it **My Work**: the active ClickUp task (name, status, deadline, recorded time today) with **Update progress**; other assigned tasks in a collapsed list with a **Switch** picker; if two tasks are In Progress and none can be chosen automatically, a single question "Which one are you on?".

**State 3: clock out.** One dialog, "Submit work & clock out". It lists the tasks worked on this shift. Tasks that already have an update today show a tick and are collapsed. Tasks without one show: link (prefilled from the last submission), one-line update, and an optional "Anything pending or blocked?". Plus "+ Other work (no task)". Footer: **Submit & clock out**, and a small "Something is broken" link for the technical exception.

**State 4: after check-out.** "Clocked out 20:03, 6 h 01 min on site", "Work saved ✓ (2 tasks)" with a link to view it. No timer, no second button.

A clickable version with fictional data: `prototype/ytm-prototype.html`.

## 4. How My Work, progress updates, submissions and history fit together

One record type, written from two places:
- **Progress entry** = {task, link, short update, pending or blocker (optional), shift, time}. Already close to the existing `deposits` table (it has task, link, completed, pending, attendance link).
- Written by **Update progress** during the day, or by the **clock-out dialog** for tasks with no entry yet. Same table, same validation.
- **My History & Reports** and the **manager task detail** are both just read views of: recorded sessions + progress entries + ClickUp status history. Nothing is typed twice.
- Reuse: the last link for a task is prefilled. A new entry is a new row (so version history is kept), never an edit of an old one.
- Task identity, status, deadline, assignee always come from ClickUp. Employees never retype them.
- Labels: "Submitted work" (not "approved"), "Unreviewed" until a manager adds a note or requests changes, "Ready for Upload" (not "quality approved").

## 5. Recommended manager and admin layout

**Manager:** Team · Reports · Corrections. (Review happens inside Team.)
**Admin:** Team · Reports · Corrections · People · Settings.

**Team** = one list, one row per person: attendance state, active task and deadline, blocker, "no submission yet", "needs review". Clicking a person or task opens **Task detail**, a single timeline:
1. Assignment, deadline (original and changes), current status, first Ready for Upload.
2. Recorded sessions (original and revision, separate).
3. Progress entries (update, link, pending/blocker) newest first, labelled Unreviewed or Reviewed.
4. Revision history. **Request changes** button (notes + reference).

## 6. Existing versus proposed employee actions (counts from `staff.js`; times are estimates)

| Action | Today | Proposed |
|---|---|---|
| Check in | 1 click | 1 click |
| Check out, one task | click "Deposit work & check out", choose task, paste link, type completed, tick finished or type pending, submit = **6 interactions, 4 to 5 fields** | click Clock out, (task and link already filled), type one sentence, submit = **3 to 4 interactions, 1 required field** |
| Check out, two tasks | the above, plus leave to Work Deposit page and repeat = **about 11** | same dialog, +1 sentence = **about 5** |
| Mid-day update | navigate to Work Deposit, 5 fields | **Update progress** on the task: 1 sentence (link prefilled) |
| See my own week | not possible (reports are manager-only) | 1 tap on "My History & Reports" |
| Report a wrong record | not possible | "Request correction" on that day: 1 sentence |
Estimate: typing and decision time at check-out falls from roughly 2 to 3 minutes to under 1 minute for a single task. This is my estimate, not a stopwatch measurement.

## 7. Prioritised fixes

**A. Security and data reliability**
1. **Prove the office-network check cannot be faked from outside** (DEPLOY step 9). Not yet done in production. **Unverified.**
2. **Run one real pilot day and compare recorded time to reality.** In production there is 1 attendance record and 0 calculated task sessions, so end-to-end timing has not yet been exercised on live data (read-only counts). **Unverified.**
3. **Employee correction requests** (data accuracy). New.
4. **Tasks already In Progress before the first sync have no known start**, so they are not timed. Add an audited "confirm start time" action for managers instead of guessing. New.
5. **Confirm the free-tier CPU limit is not being hit** by reading the Worker logs for "Exceeded CPU". **Unverified.**
6. **Backups:** exports are manual today. Add a monthly export reminder or check D1 point-in-time restore availability. **Unverified.**
7. Minor: five wrong passwords lock an email for 15 minutes for everyone, so a stranger can lock an employee out. Acceptable for 8 people; note it.

**B. Workflow friction:** merge Work Deposit and My Tasks into Today; multi-task check-out dialog with prefilled links; "Update progress"; manager task detail; employee own reports; hide device set-up unless needed; show date and shift on Today.

**C. Visual polish:** one dominant action per state; remove the empty "Current task" card before check-in; larger Clock in/out; calmer cards; mobile bottom bar for view-only pages; visible "Change password"; keep existing dark/light support and keyboard focus.

## 8. What was inspected and what was not

**Verified**
- Every route's role list and the employee data isolation (code + tests).
- Device signature, replay refusal, wrong-device refusal, office-network refusal with spoofed headers, fail-closed when no office address is set (automated tests, 94 passing).
- Idempotent check-in/check-out/deposit, concurrent tabs, failed save keeps the form, atomic check-out + deposit (tests; manual run in a browser against a local copy).
- Timer rules: pause at check-out, resume at next check-in, stop at Ready for Upload, blocked/on-hold pause, one active task, ambiguous-task prompt, revision sessions separate, late/out-of-order/duplicate events (tests).
- Deadline handling: an extension after a miss does not erase the miss (test).
- **Live ClickUp webhooks work:** 107 real events received (90 status, 8 assignee added, 2 removed, 7 deadline). Average delay about 2 seconds, longest 86 seconds. Events are stored with ClickUp's own timestamp, not arrival time (read-only counts).
- Credentials: ClickUp token and webhook secret are stored encrypted; passwords are hashed; no secrets in the repository (scan done earlier).

**Not verified**
- Office-network spoof test on the live site; free CPU limit; backup restore; Google Docs reading against a real shared Doc; an end-to-end real pilot day; accessibility with a screen reader or automated checker; the tablet layout.
- Whether private work links should be hidden from managers outside the team: today any manager sees only their team's submissions (verified), admins see all.

## 9. One implementation plan

**Step 1: data and API (no visible change).**
- `GET /api/today` also returns: date, approved shift, my work list (active task, other assigned tasks with status and deadline, "has update this shift" per task).
- `POST /api/progress` (task, link, update, pending/blocker; idempotent) using the existing deposits table.
- `POST /api/checkout` accepts a list of updates (still one transaction).
- `GET /api/me/report` (own weekly/monthly) and `POST /api/correction-requests` + manager inbox.
- Manager action "confirm start time" (audited).

**Step 2: employee UI.** Two-item navigation; the four Today states; Update progress sheet; checkout dialog; My History & Reports with request-correction. Remove Work Deposit and My Tasks pages.

**Step 3: manager UI.** Task detail timeline; Team rows link to it; remove Work Submissions page; rename Attendance to Corrections.

**Step 4: admin.** Navigation Team / Reports / Corrections / People / Settings; computers notice; Settings sections.

**Step 5: polish and release.** Visual pass, mobile check, tests for every new route (role isolation first), staging worker with its own database, one pilot day with Zain or Huzaifa, then production deploy with a database export taken first. Rollback is `wrangler rollback`.

Estimated effort: 4 to 6 working sessions. Estimate.
