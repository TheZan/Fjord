-- See docs/specs/data-model.md for the rationale behind each choice here.

CREATE TABLE settings (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    locale          TEXT NOT NULL DEFAULT 'en',
    theme           TEXT NOT NULL DEFAULT 'system',
    default_ide     TEXT,
    updated_at      TEXT NOT NULL
);

INSERT INTO settings (id, locale, theme, default_ide, updated_at)
VALUES (1, 'en', 'system', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    sort_order      INTEGER NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE TABLE repositories (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    path            TEXT NOT NULL,
    sort_order      INTEGER NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE (workspace_id, path)
);

CREATE TABLE repo_status_cache (
    repo_id         TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    branch          TEXT,
    ahead           INTEGER NOT NULL DEFAULT 0,
    behind          INTEGER NOT NULL DEFAULT 0,
    dirty_count     INTEGER NOT NULL DEFAULT 0,
    has_conflict    INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TEXT
);
