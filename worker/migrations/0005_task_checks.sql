-- Latest script/title check per ClickUp task and person (runs when the task reaches a Finished status for their job).
CREATE TABLE task_checks (
  task_id TEXT NOT NULL,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  checked_at INTEGER NOT NULL,
  trigger TEXT NOT NULL,               -- status name that triggered it, or 'manual'
  result_json TEXT NOT NULL,
  PRIMARY KEY (task_id, employee_id)
);
CREATE INDEX idx_task_checks_at ON task_checks(checked_at);
