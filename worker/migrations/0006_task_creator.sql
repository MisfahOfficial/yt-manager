-- Who created a ClickUp task and when (used to count titles/ideas created by jobs that create tasks instead of moving them through statuses).
ALTER TABLE tasks ADD COLUMN creator_id TEXT;
ALTER TABLE tasks ADD COLUMN created_ms INTEGER;
CREATE INDEX idx_tasks_creator ON tasks(creator_id, created_ms);
