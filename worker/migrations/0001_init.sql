-- All timestamps are UTC epoch milliseconds. Display zone: Asia/Karachi (UTC+5, no DST).
CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  legacy_id TEXT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('employee','manager','admin')),
  can_correct INTEGER NOT NULL DEFAULT 0,
  manager_id TEXT REFERENCES employees(id),
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_iter INTEGER NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  clickup_user_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_emp_clickup ON employees(clickup_user_id) WHERE clickup_user_id IS NOT NULL;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_emp ON sessions(employee_id);

CREATE TABLE login_attempts (
  email TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts ON login_attempts(email, at);

-- Device registration: one ECDSA P-256 public key per row. A key belongs to exactly one employee.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  pubkey_jwk TEXT NOT NULL,
  pubkey_fp TEXT NOT NULL UNIQUE,
  label TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','revoked')),
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER
);
CREATE UNIQUE INDEX idx_one_approved_device ON devices(employee_id) WHERE status='approved';

CREATE TABLE nonces (
  nonce TEXT PRIMARY KEY, employee_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE shifts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  start_min INTEGER NOT NULL,          -- minutes after local midnight
  end_min INTEGER NOT NULL,            -- may be < start_min for overnight shifts
  days_mask INTEGER NOT NULL,          -- bit0=Mon .. bit6=Sun
  break_min INTEGER NOT NULL DEFAULT 0,
  grace_min INTEGER NOT NULL DEFAULT 10
);
CREATE TABLE employee_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  effective_from TEXT NOT NULL,        -- YYYY-MM-DD local
  effective_to TEXT                    -- inclusive, NULL = open
);
CREATE TABLE leave (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  date_from TEXT NOT NULL, date_to TEXT NOT NULL, reason TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE overtime (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, reason TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE network_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT,                    -- NULL = everyone
  reason TEXT NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE attendance (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  request_id TEXT NOT NULL UNIQUE,
  check_in_at INTEGER NOT NULL,
  check_out_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('open','closed','missing_checkout')),
  device_id TEXT, ip TEXT, network_exception_id INTEGER,
  checkout_request_id TEXT UNIQUE,
  checkout_ip TEXT,
  checkout_exception TEXT,             -- reason when work deposit was skipped for a technical problem
  corrected INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_one_open_attendance ON attendance(employee_id) WHERE status='open';
CREATE INDEX idx_att_emp_time ON attendance(employee_id, check_in_at);

CREATE TABLE deposits (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  attendance_id TEXT REFERENCES attendance(id),
  request_id TEXT NOT NULL UNIQUE,
  task_id TEXT,
  taskless_reason TEXT,
  link TEXT NOT NULL,
  completed TEXT NOT NULL,
  pending TEXT,
  is_complete INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  review_note TEXT
);
CREATE INDEX idx_dep_emp ON deposits(employee_id, created_at);
CREATE INDEX idx_dep_task ON deposits(task_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                 -- ClickUp task id
  name TEXT NOT NULL, url TEXT, status TEXT, priority TEXT,
  due_ms INTEGER, list_name TEXT, channel TEXT, work_type TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_ms INTEGER, first_seen_ms INTEGER NOT NULL
);
CREATE TABLE task_assignees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL, clickup_user_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER,
  start_known INTEGER NOT NULL DEFAULT 1,
  UNIQUE(task_id, clickup_user_id, start_ms)
);
-- Raw facts from ClickUp. event_key dedupes webhook deliveries and reconcile imports.
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('status','assignee_add','assignee_rem','due','deleted','created')),
  at_ms INTEGER NOT NULL,              -- ClickUp's own event time
  received_ms INTEGER NOT NULL,
  source TEXT NOT NULL,                -- webhook | reconcile | app
  from_val TEXT, to_val TEXT, actor TEXT, note TEXT
);
CREATE INDEX idx_te_task ON task_events(task_id, at_ms);

CREATE TABLE gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE active_choices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL, task_id TEXT NOT NULL, at_ms INTEGER NOT NULL
);
CREATE INDEX idx_choice_emp ON active_choices(employee_id, at_ms);

-- Derived: rebuilt deterministically from attendance + task_events + shifts. Never edited by hand.
CREATE TABLE task_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL, task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('original','revision')),
  start_ms INTEGER NOT NULL, end_ms INTEGER, end_reason TEXT
);
CREATE INDEX idx_ts_emp ON task_sessions(employee_id, start_ms);
CREATE INDEX idx_ts_task ON task_sessions(task_id);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
  notes TEXT NOT NULL, links TEXT, created_at INTEGER NOT NULL,
  clickup_status TEXT,                 -- 'written' | 'skipped' | 'failed:<msg>'
  due_ms INTEGER                       -- separate revision deadline (optional)
);

CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  last_ok_ms INTEGER, last_attempt_ms INTEGER, last_error TEXT,
  cursor TEXT, running INTEGER NOT NULL DEFAULT 0, last_run_day TEXT
);
INSERT INTO sync_state(id) VALUES (1);
CREATE TABLE secrets_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- AES-GCM encrypted blobs only

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL, actor_id TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, before_json TEXT, after_json TEXT, reason TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at_ms);

CREATE TABLE idempotency (
  request_id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, action TEXT NOT NULL, result_json TEXT NOT NULL, at_ms INTEGER NOT NULL
);

CREATE TABLE report_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, period TEXT NOT NULL, scope TEXT NOT NULL,
  generated_at INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(kind, period, scope)
);
