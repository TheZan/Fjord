CREATE TABLE repo_snapshot (
    repo_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    captured_at TEXT NOT NULL
);
