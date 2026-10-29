-- Channels are recognised from the start of a ClickUp task name ("V4--30 ...", "{C1--12 ...}" for automation thumbnails, "Spanish--...").
CREATE TABLE channels (
  code TEXT PRIMARY KEY,               -- upper-case first word of the task name: V1, C1, SS1, SPANISH
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6c93ff',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
INSERT INTO channels(code,name,color,sort) VALUES
 ('V1','Vintage Life of USA','#e0803a',1), ('V2','Forgotten Flavors of USA','#d9534f',2), ('V3','Britain We Lived In','#3b82f6',3), ('V4','Canada We Lived In','#16a34a',4),
 ('C1','Inside the Era','#8b5cf6',5), ('C2','C2','#0ea5e9',6), ('B1','B1','#ca8a04',7), ('SS1','SS1','#db2777',8), ('SPANISH','Spanish','#14b8a6',9);

-- Work categories for reports ("by work type"). A category is tied to a job role (and optionally a ClickUp tag name).
CREATE TABLE work_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  job_role TEXT,                       -- matches employees.job_role (case-insensitive)
  tag TEXT,                            -- reserved: ClickUp tag name
  active INTEGER NOT NULL DEFAULT 1
);
INSERT INTO work_categories(name,job_role) VALUES ('Video editing','Editor'), ('Script writing','Writer'), ('Thumbnail design','Designer'), ('Title research','Title finder');
