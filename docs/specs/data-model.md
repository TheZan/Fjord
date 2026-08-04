# Spec: data model & SQLite schema

Referenced by: P0-04, P2-01, P2-02.

## Scope

This is the persistence schema owned by `fjord-db`, implementing the `WorkspaceStore` / `SettingsStore` ports. It stores app state (workspaces, tracked repository paths, cached status, settings) — never Git object data itself, which always comes live from `GitBackend`.

## Tables

```sql
-- Single-row table. Enforced by application logic, not a SQL constraint,
-- to keep the migration simple.
CREATE TABLE settings (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    locale          TEXT NOT NULL DEFAULT 'en',   -- BCP-47-ish code, e.g. 'en', 'ru'
    theme           TEXT NOT NULL DEFAULT 'system', -- 'light' | 'dark' | 'system'
    default_ide     TEXT,                          -- IDE identifier, see ipc-commands.md
    updated_at      TEXT NOT NULL
);

CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,   -- UUID
    name            TEXT NOT NULL,
    sort_order      INTEGER NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE TABLE repositories (
    id              TEXT PRIMARY KEY,   -- UUID
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,       -- display name, defaults to folder name
    path            TEXT NOT NULL,       -- absolute path, platform-native separators
    sort_order      INTEGER NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE (workspace_id, path)
);

-- Cache only — always safe to truncate and rebuild from `repositories`
-- plus a live GitBackend call. See SDD §7.
CREATE TABLE repo_status_cache (
    repo_id         TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    branch          TEXT,
    ahead           INTEGER NOT NULL DEFAULT 0,
    behind          INTEGER NOT NULL DEFAULT 0,
    dirty_count     INTEGER NOT NULL DEFAULT 0,
    has_conflict    INTEGER NOT NULL DEFAULT 0,   -- 0/1
    last_synced_at  TEXT
);
```

## Conventions

- **IDs**: UUIDv4 as `TEXT`, generated application-side — never auto-increment integers, so IDs are stable across export/import and don't leak row-count information.
- **Timestamps**: ISO-8601 `TEXT` in UTC, formatted at the edge for display in the user's locale — never store a pre-localized date string.
- **Paths**: stored absolute, in the OS's native form. Comparison/dedup goes through the `fjord-fs` path-normalization helper (SDD §5.4), not a raw string comparison — this is where Windows/macOS case-insensitivity is handled.
- **Migrations**: `sqlx migrate`, one numbered file per change (`0001_init.sql`, `0002_...`), forward-only. No down-migrations — a corrupted or stale local SQLite file is cheap to delete and rebuild (workspaces/repositories are just pointers to real repos on disk; only user-authored data like custom workspace names would be lost, which is an acceptable v1 tradeoff).

## What's deliberately *not* here

Commit history, diffs, branch lists — none of that is cached in SQLite. It's read live through `GitBackend` on every request; only the *summary* (`repo_status_cache`) is persisted, because it's the one thing expensive enough (many repos × full status each) to be worth caching, and cheap enough to safely go stale between refreshes.
