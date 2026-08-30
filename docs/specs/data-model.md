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
    auto_fetch      INTEGER NOT NULL DEFAULT 0,
    performance_diagnostics INTEGER NOT NULL DEFAULT 0,
    git_executable_path TEXT,
    diff_tool       TEXT,                          -- Git difftool NAME only; see below
    updated_at      TEXT NOT NULL
);

CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,   -- UUID
    name            TEXT NOT NULL,
    sort_order      INTEGER NOT NULL,
    created_at      TEXT NOT NULL,
    expected_branch TEXT                 -- literal local branch name; see below
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

-- Cache-only projection of the last repository paint. Implemented by
-- 0005_repo_snapshot.sql; safe to drop and re-create from live Git state.
CREATE TABLE repo_snapshot (
    repo_id         TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    schema_version  INTEGER NOT NULL,
    payload         TEXT NOT NULL,
    captured_at     TEXT NOT NULL
);

-- Single versioned UI-preference document. Unknown JSON keys are ignored;
-- an unsupported version falls back to defaults. Implemented by 0006_ui_state.sql.
CREATE TABLE ui_state (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    version         INTEGER NOT NULL,
    payload         TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
```

`auto_fetch` is retained as a legacy compatibility column so existing databases
continue to round-trip through `SettingsStore`. It has no user-facing control and
does not enable background network activity in the current product.

Applied migrations beyond `0001_init.sql`: `0002_auto_fetch.sql`,
`0003_git_executable_path.sql`, `0004_performance_diagnostics.sql`,
`0005_repo_snapshot.sql`, `0006_ui_state.sql`, `0007_diff_tool.sql`, and
`0008_expected_branch.sql`.

`0007_diff_tool.sql` (`P10-WC-06`) adds `settings.diff_tool`, holding a Git
difftool **name** and nothing else:

```sql
-- NULL   -> let Git resolve diff.tool / difftool.<name>.cmd
-- 'meld' -> invoke `git difftool --tool=meld`
ALTER TABLE settings ADD COLUMN diff_tool TEXT;
```

Never an executable path, a shell command, or a command line: values
containing path separators, whitespace, quotes, or shell metacharacters are
rejected at the settings boundary (`diff_tool_name_invalid`), so this column
can never become a launch vector. The tool's actual command line stays in the
user's own Git configuration. See [`working-tree-and-diff.md`](working-tree-and-diff.md) §6.4.

`0008_expected_branch.sql` (`P10-09`) adds `workspaces.expected_branch`, one
optional literal branch name per workspace:

```sql
-- NULL      -> the workspace has no expected-branch convention
-- 'develop' -> literal local branch name, compared exactly
ALTER TABLE workspaces ADD COLUMN expected_branch TEXT;
```

Nullable by design, and forward-only: every workspace that existed before the
migration keeps `NULL`, so no repository changes health because the app was
updated. The value is trimmed at the service boundary, an empty string is
stored as `NULL`, and anything else must be a valid local branch name
(`expected_branch_invalid`). It is not a pattern, not a remote-tracking name,
and not per repository — there is exactly one literal per workspace, and it is
the only input `WorkspaceService` needs to derive `RepoCondition::WrongBranch`
(the projection itself is never persisted). See
[`workspace-workflows.md`](workspace-workflows.md) §4–§5.

## Planned additions

Designed but not migrated yet. Each is forward-only and owned by a spec.

Nothing is pending: `expected_branch` was the last designed-but-unmigrated
column, and it shipped with `0008`. Neither the merge workflow
([`branch-merge.md`](branch-merge.md)) nor the Working Changes file context menu
([`working-tree-and-diff.md`](working-tree-and-diff.md) §6) adds any other
persisted state: merge state lives in Git's own directory and
is read live, and the context menu is transient UI state, not a preference.

**Stash management ([`stash-management.md`](stash-management.md)) adds no
persisted state either, and the omission is a design decision rather than an
oversight.** Git owns stash state: the stack is `refs/stash` and its reflog, a
stash's name is the entry's own message, and its structure is readable from the
stash commit's parents. A Fjord-side stash table would be a second source of
truth that a terminal `git stash drop` falsifies immediately, would orphan rows
forever, and would make Fjord-created stashes behave differently from everyone
else's. Stash identity is the stash commit OID — an immutable Git object id, not
a Fjord-assigned key — so there is nothing to store. Working Changes
multi-selection (`P10-WC-MULTI-01`–`P10-WC-MULTI-03`) is likewise transient view
state.

A snapshot row is revalidated on first use after a restart, because generations
([`performance.md`](performance.md) §5) are in-memory and reset to zero — a
persisted snapshot can never be trusted on the strength of a stale generation.
The current payload schema version is 2; P9-02 added `operationState`. Version 1
rows are treated as cache misses so an older payload can never imply `Normal` by
omission.

## Conventions

- **IDs**: UUIDv4 as `TEXT`, generated application-side — never auto-increment integers, so IDs are stable across export/import and don't leak row-count information.
- **Timestamps**: ISO-8601 `TEXT` in UTC, formatted at the edge for display in the user's locale — never store a pre-localized date string.
- **Paths**: stored absolute, in the OS's native form. Comparison/dedup goes through the `fjord-fs` path-normalization helper (SDD §5.4), not a raw string comparison — this is where Windows/macOS case-insensitivity is handled.
- **Migrations**: `sqlx migrate`, one numbered file per change (`0001_init.sql`, `0002_...`), forward-only. No down-migrations — a corrupted or stale local SQLite file is cheap to delete and rebuild (workspaces/repositories are just pointers to real repos on disk; only user-authored data like custom workspace names would be lost, which is an acceptable v1 tradeoff).

## What's deliberately *not* here

Commit history, diffs, branch lists — none of that is cached in SQLite. It's read live through `GitBackend` on every request; only the *summary* (`repo_status_cache`) is persisted, because it's the one thing expensive enough (many repos × full status each) to be worth caching, and cheap enough to safely go stale between refreshes.

`RepoHealth` is also deliberately absent from the schema. It is an O(repositories)
derived projection over `repo_status_cache`, the cached operation observation,
and the optional expected-branch input. The existing `repo_snapshot` payload may
supply a cached operation state after restart, but it is never a second health
source of truth.
