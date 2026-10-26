-- Read-only archive of imported legacy (v1) records so history is preserved with original identities.
CREATE TABLE legacy_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                  -- member | attendance | workLog | task | video
  legacy_id TEXT,
  employee_id TEXT,
  data_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  UNIQUE(kind, legacy_id)
);
