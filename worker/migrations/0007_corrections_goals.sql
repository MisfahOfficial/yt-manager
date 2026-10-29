-- Employees ask for corrections to their own records; managers may ask an employee to confirm a missing check-out.
CREATE TABLE correction_requests (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  attendance_id TEXT NOT NULL REFERENCES attendance(id),
  req_check_in INTEGER,
  req_check_out INTEGER,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','declined')),
  created_at INTEGER NOT NULL,
  decided_by TEXT, decided_at INTEGER, decision_note TEXT
);
CREATE INDEX idx_corr_status ON correction_requests(status, created_at);
ALTER TABLE attendance ADD COLUMN asked_at INTEGER;
ALTER TABLE attendance ADD COLUMN asked_by TEXT;
