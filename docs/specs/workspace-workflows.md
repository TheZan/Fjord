# Spec: worktrees, rebase, remotes, and workspace health

Referenced by: P10-01–P10-11, SDD §2 (G1), §15.
Related: [`repository-safety.md`](repository-safety.md),
[`data-model.md`](data-model.md), [`ipc-commands.md`](ipc-commands.md),
[`performance.md`](performance.md), [`ui-shell.md`](ui-shell.md),
[`branch-merge.md`](branch-merge.md).

**Merge is not in this spec.** Starting a branch merge is owned by
[`branch-merge.md`](branch-merge.md) (`P10-MERGE-01`–`P10-MERGE-03`), because it
is daily-driver branch integration rather than advanced workspace management and
is scheduled ahead of everything here. The integration preflight rules it defines
(§4 there: operation-in-progress, detached/unborn `HEAD`, staged changes, the
bounded overwrite set, and the no-autostash / explicit named-stash policy) are
**shared**, and §2 below reuses them for rebase rather than restating them.

## Problem

Fjord's differentiator is the workspace: many repositories, one control surface
(SDD §2, G1). Today that surface answers "what is the status of each repository"
and little else, and the single-repository workflows that a workspace user needs
most are the ones still missing:

1. **Worktrees are invisible.** A developer running two branches side by side —
   increasingly the normal setup when coding agents work in parallel checkouts —
   has no representation in Fjord at all. Worktrees of a tracked repository appear
   either as unrelated repositories (if imported separately) or not at all, and
   their shared `.git` relationship is never modeled.
2. **Rebase cannot be started.** Phase 9 makes Fjord able to *finish* a rebase;
   it still cannot begin one. "Rebase my branch onto develop" is a daily
   operation, and its absence sends the user to a terminal, where they will also
   do the next five things.
3. **Remotes are read-only.** Fjord resolves upstreams and pushes to them, but
   cannot list, add, edit, or remove a remote. Adding a fork or an internal mirror
   requires another tool.
4. **Workspace state is a flat list of numbers.** The dashboard shows counts, not
   conditions. With 40 repositories, the question is never "how many are dirty" but
   "which ones need me, and why". There is no filtering, and no concept of a
   repository being on the *wrong branch* — the single most common cause of "why
   isn't my change taking effect" in a multi-repo setup.

## Goals

- Model worktrees as first-class members of a repository, creatable, removable,
  and openable in an IDE or terminal from Fjord.
- Start a basic rebase (current branch onto a target) with conflicts handled by
  the Phase 9 continue/skip/abort machinery.
- Full remote management: list, add, edit, remove, and select upstreams.
- A workspace health model that classifies every repository by condition and lets
  the user filter to the ones that need action.
- Per-workspace expected branch, so "which repositories drifted off `develop`" is
  answerable at a glance.
- Interactive rebase specified but deliberately scheduled last — after basic
  merge ([`branch-merge.md`](branch-merge.md)), which is the more fundamental
  daily-driver capability and therefore precedes every task in this spec.

## Non-goals

- Submodules. A real workload, but a different model (nested repositories with
  their own status semantics) and not what makes a workspace user leave today.
- Forge features: pull requests, merge requests, issues, CI dashboards. SDD §3
  and the roadmap principle in §15 stand.
- Automatic remediation. Fjord reports that six repositories are on the wrong
  branch; it does not check them out en masse without an explicit, previewed
  action.
- Worktree-aware bulk operations in this phase. Bulk fetch/pull continue to
  operate on repositories; extending them to worktrees needs the health model
  shipped first.
- Rebase strategies and options beyond the basic form (`--onto`, `--interactive`
  in the final task). No `--rebase-merges`, no autosquash configuration in v1.
- Starting a merge. Owned by [`branch-merge.md`](branch-merge.md); referenced
  here only where rebase shares its preflight and entry-point layout.

## Current state

| Area | State |
|---|---|
| Worktrees | 🚧 Absent everywhere: domain, ports, IPC, UI, and the import scanner (`fjord-fs` discovery finds `.git` directories; a worktree's `.git` is a *file*). |
| Rebase | ⚠️ Detection and finishing arrive in Phase 9; starting is absent. `pull` is deliberately fetch + local integration and never delegates to `git pull` ([`system-git-transport.md`](system-git-transport.md)). |
| Merge | 🚧 Starting a merge is absent and is owned by [`branch-merge.md`](branch-merge.md), scheduled **before** rebase. Detection, conflict UI, Continue, and Abort already exist (Phase 9). |
| Remotes | ⚠️ The v0.1 slice lists configured remotes and adds one without overwriting existing config; URLs are redacted before IPC and an explicit optional fetch reuses the existing operation path. When two or more remotes exist, the section can push the current branch to an explicit multi-selection with a result per destination and without changing upstream. Local upstream selection, remote inspection/deletion, and publish already exist. URL editing, rename, remove, generalized pickers, and full CRUD remain Phase 10. |
| Workspace status | ✅ `repo_status_cache` + `RepoStatusSummary { branch, ahead, behind, dirty_count, has_conflict, last_synced_at }`. Dashboard computes `needsAttention` in the frontend as `hasConflict \|\| dirtyCount \|\| ahead \|\| behind` (`src/presentation/App.tsx`). |
| Filters | 🚧 None. The All-repositories view filters by name/path/workspace text only. |
| Expected branch | 🚧 No concept; `workspaces` has `{ id, name, sort_order, created_at }`. |

## Proposed design

### 1. Worktrees

Model: a worktree belongs to a repository. It is not a separate `RepositoryEntry`,
because it shares refs, remotes, stash, and history with its parent — treating it
as a peer repository would double every count in the workspace.

```rust
pub struct Worktree {
    pub name: String,             // Git's worktree name
    pub path: PathBuf,            // absolute worktree path
    pub branch: Option<String>,   // None when detached
    pub head: CommitId,
    pub is_main: bool,
    pub is_locked: bool,
    pub is_prunable: bool,        // path missing on disk
}
```

Port additions (local, no network):

```rust
async fn worktrees(&self, repo: &RepoPath) -> Result<Vec<Worktree>, GitError>;
async fn create_worktree(&self, repo: &RepoPath, name: &str, path: &Path, branch: WorktreeBranch) -> Result<Worktree, GitError>;
async fn remove_worktree(&self, repo: &RepoPath, name: &str, force: bool) -> Result<(), GitError>;
```

`WorktreeBranch` is `Existing(String)` or `New { name, start_point }`, so creating
a worktree for a new branch is one action rather than two.

IPC: `list_worktrees`, `create_worktree`, `remove_worktree`, plus
`open_in_ide` / `open_terminal` accepting an optional worktree path so the existing
launcher is reused rather than duplicated.

UI: a **Worktrees** section in the repository tree, below branches and tags,
listing each worktree with its branch and a marker for the main one. Row actions:
open in IDE, open terminal, remove. Creating one opens a dialog for name, path
(with a suggested sibling path `<repo>-<branch>`), and branch selection.

Safety:

- Removal always routes through the Phase 9 preflight
  ([`repository-safety.md`](repository-safety.md) §3): a worktree with uncommitted
  changes reports them, and `force` is required and labeled *not recoverable*.
- A locked worktree cannot be removed without unlocking; the reason Git reports is
  shown.
- Prunable worktrees (path gone) are listed with a Prune action.

Import interaction: `fjord-fs` discovery must not add a worktree as a separate
repository. Discovery gains a check — a `.git` *file* containing `gitdir:` marks a
worktree; it is skipped during import and, if its parent repository is tracked,
surfaced under that repository instead.

Watcher interaction: a worktree has its own working tree but shares `.git`.
Hot/warm worktrees of a hot repository get a working-tree watch; the shared
`.git` watch stays on the parent, so refs changes are observed once, not N times
([`performance.md`](performance.md) §7).

### 2. Basic rebase

```rust
async fn start_rebase(&self, repo: &RepoPath, onto: &str) -> Result<RepoOperationState, GitError>;
```

`onto` is a branch or commit. The implementation invokes the system Git rebase
through the shared executable, with a non-interactive editor, and returns the
resulting `RepoOperationState` — so a clean rebase returns `Normal` and a
conflicted one returns `Rebase { .. }` and the Phase 9 banner takes over
immediately. Continue/skip/abort are already specified there and are not
reimplemented here.

Preflight before starting: rebase **reuses** the shared integration preflight in
[`branch-merge.md`](branch-merge.md) §4 — the same blocker codes
(`operation_already_in_progress`, detached/unborn `HEAD`, staged changes, the
bounded overwrite set), the same dirty-tree policy, and the same explicit
Cancel / *Stash changes and rebase* choice with an Fjord-named stash that is
never auto-popped and whose location is always reported. No autostash. Those
rules are not restated here; only the rebase-specific addition is:

- when the branch is published and rebasing would rewrite pushed commits, state
  that a force-with-lease push will be required afterwards
  ([`working-tree-and-diff.md`](working-tree-and-diff.md) §3), with the commit
  count.

Entry points: branch context menu ("Rebase current branch onto <branch>") and the
command palette — the same two surfaces the merge action uses, sharing the
context-menu slot layout in [`branch-merge.md`](branch-merge.md) §8, and
dispatching one application action per operation. Rebase runs through the operation pipeline with progress and
cancellation; cancelling a rebase leaves a detectable in-progress state, which the
banner then offers to abort — cancellation is not silently equivalent to abort.

**Interactive rebase** is specified as a later, separate task (P10-11): a todo-list
editor over the commit range supporting pick / reword / fixup / squash / drop /
reorder, written to Git's todo file, driven through the same operation-state
machinery. It is scheduled last in the phase because it multiplies the state space
and is only safe once basic rebase, the operation banner, and the Recovery Center
have all been proven.

### 3. Remote management

```rust
pub struct Remote { pub name: String, pub fetch_url: String, pub push_url: Option<String> }

async fn remotes(&self, repo: &RepoPath) -> Result<Vec<Remote>, GitError>;
async fn add_remote(&self, repo: &RepoPath, name: &str, url: &str) -> Result<(), GitError>;
async fn set_remote_url(&self, repo: &RepoPath, name: &str, fetch: &str, push: Option<&str>) -> Result<(), GitError>;
async fn rename_remote(&self, repo: &RepoPath, old: &str, new: &str) -> Result<(), GitError>;
async fn remove_remote(&self, repo: &RepoPath, name: &str) -> Result<(), GitError>;
```

Listing and adding are shipped by `P9R-06`; the remaining mutations stay in
Phase 10. Configuration writes are local and never imply network access. The
v0.1 add flow may start a separate fetch only when the user selects that option;
it never pulls, merges unrelated histories, overwrites another remote, or pushes.
IPC mirrors the shipped methods one-to-one.

UI: a Remotes section in the repository tree with add/edit/remove, and a
remote picker wherever a remote is chosen (publish, fetch, set upstream). URLs are
displayed with userinfo redacted using the existing sanitizer
([`system-git-transport.md`](system-git-transport.md) §"Redaction") — a URL with an
embedded token must never be rendered verbatim.

The shipped multi-push slice is deliberately narrower than that shared picker:
when at least two remotes exist, the Remotes section exposes unchecked
destinations and an explicit **Push to selected** action. It reports success or
the localized stable error for each remote. It sends the current branch to the
same branch ref without changing upstream; it is not a mirror daemon and does
not make future ordinary pushes fan out automatically.

Removing a remote routes through the preflight: it names the branches whose
upstream would be orphaned.

Setting a branch's upstream is specified in
[`working-tree-and-diff.md`](working-tree-and-diff.md) §4 and consumes this
remote list.

### 4. Workspace health

Health is derived, never stored as truth:

```rust
pub enum RepoCondition {
    Clean,
    Dirty        { count: u32 },
    Ahead        { count: u32 },
    Behind       { count: u32 },
    Diverged     { ahead: u32, behind: u32 },
    Conflict,
    OperationInProgress { operation: RepoOperation },
    WrongBranch  { expected: String, actual: Option<String> },
    Unreadable   { reason_code: String },
}

pub struct RepoHealth {
    pub repo_id: RepositoryId,
    pub conditions: Vec<RepoCondition>,   // ordered by severity, may be several
    pub needs_attention: bool,
    pub as_of: OffsetDateTime,
}
```

Computation moves to the backend (`WorkspaceService`), from the same
`repo_status_cache` row plus the expected branch and the operation state. Today
`needsAttention` is computed in `App.tsx`; centralizing it means the dashboard,
the sidebar badge, the filters, and any future surface agree by construction.

Severity order for display: `Conflict` > `OperationInProgress` > `Unreadable` >
`WrongBranch` > `Diverged` > `Behind` > `Ahead` > `Dirty` > `Clean`. A repository
carries every condition that applies; the highest one drives its badge.

`needs_attention` is `true` for `Conflict`, `OperationInProgress`, `Unreadable`,
`WrongBranch`, and `Diverged`. Notably it is **not** true for a merely dirty
repository — the current frontend rule counts every dirty repository as needing
attention, which makes the number useless for a developer who always has work in
progress. This is a deliberate behavior change and is called out in the task.

### 5. Expected branch

`workspaces` gains a nullable `expected_branch TEXT` column (forward-only
migration, per [`data-model.md`](data-model.md)). It is set in workspace settings,
empty by default, and matched literally against the repository's current branch.

Display: the workspace header shows `28 of 31 on develop`, and the three
off-branch repositories are one click away through the `WrongBranch` filter. A
repository in a detached HEAD or unborn state reports `WrongBranch` with
`actual: None`.

No automatic checkout is offered from the summary. A bulk "check out the expected
branch" action is possible later, but only behind the safe-checkout preflight for
every affected repository — that is out of scope here.

### 6. Workspace filters

Filter chips on the Overview and All-repositories screens, driven by the health
model: *needs attention*, *dirty*, *ahead*, *behind*, *conflicts*, *wrong branch*.
Filters compose as OR within the set, AND with the text query. The active filter
set is persisted (`overview.filter`, [`ui-shell.md`](ui-shell.md) §5) and is what
the Overview summary line's segments toggle.

## Alternatives considered

**Worktrees as `RepositoryEntry` rows vs. children of a repository.** Rows would
require no new model and would work with every existing screen — and would double
every workspace count, duplicate refs and stash lists, and make bulk fetch fetch
the same remote twice. Children are chosen despite the UI work.

**Rebase: `git2` rebase API vs. system Git.** `git2` gives step-by-step control
without a subprocess, but Phase 9's continue/skip/abort deliberately speak Git's
on-disk protocol so that externally-started operations work. Starting a rebase
with a different mechanism than the one that finishes it would create states only
one half understands. System Git is chosen for symmetry.

**Health computation: frontend vs. backend.** Frontend is where it lives today and
requires no IPC change. It also means every new surface re-derives the rule, and
the sidebar badge and the dashboard can silently disagree. Backend is chosen; the
cost is one new command and a domain type.

**Expected branch: per workspace vs. per repository vs. a pattern.** Per
repository is more precise and is more configuration than anyone will maintain
across 40 repositories. A pattern (`release/*`) is tempting but makes "which
branch should this be on" unanswerable as a single string in the UI. A single
literal per workspace covers the actual case (a team convention) and can be
extended later without changing the displayed model.

**Filters: chips vs. a query language.** A query language (`is:dirty ahead:>0`) is
powerful and is a second thing to learn. Chips backed by the health model cover the
enumerated conditions, and the text query already handles names and paths.

## Performance considerations

- `list_worktrees` reads Git's worktree metadata directory: cheap, cached in the
  `RepositoryRuntime` against the `refs` generation.
- Worktree watching reuses the tier rules; the shared `.git` is watched once per
  repository regardless of worktree count, which is what keeps `ws-100` viable.
- Health is computed from the already-cached status row plus a cached operation
  state; the workspace-level computation is O(repositories) over in-memory data and
  must stay inside SLO-3 for `ws-100`.
- Filters are applied to the already-loaded health set, in the frontend, with no
  additional IPC.
- Rebase and worktree creation are long-running mutations on the operation
  pipeline; neither may block the UI thread.
- Remote configuration writes are individually trivial but invalidate the `config`
  generation, which in turn invalidates upstream resolution — this is the only
  case where a `config` bump must also refresh push targets.

## Security / safety

- Worktree creation writes to a user-chosen path: the path is canonicalized,
  must not be inside another repository's working tree, must be empty or
  non-existent, and is rejected otherwise. Fjord never deletes a non-empty
  directory to make room.
- Worktree removal with `force` is *not recoverable* and is labeled as such.
- Remote URLs are redacted for display and in logs; a URL containing userinfo is
  stored as the user entered it (Git's own behavior) but never rendered or logged
  verbatim.
- Rebase on a published branch is permitted but always announces the force-push
  consequence.
- Every mutation in this spec takes the repository write lock, uses the shared
  resolved Git executable, and passes arguments individually — no shell strings.
- Expected-branch drift reporting is read-only; nothing in this phase changes a
  branch without an explicit per-repository confirmation.

## Testing strategy

| Level | Coverage |
|---|---|
| Unit (Rust) | Worktree metadata parsing including locked and prunable entries; `.git`-file detection in discovery; health condition derivation and severity ordering; expected-branch matching with detached and unborn HEAD. |
| Integration (Rust) | Create/list/remove worktrees against a real repository, including a worktree with uncommitted changes refusing removal without force; rebase onto a target with and without conflicts, verifying the returned operation state; remote CRUD round-trips reflected in `git config`; import scanner skipping worktrees of a tracked repository. |
| Frontend/component | Worktree section rendering and actions; rebase preflight variants (dirty tree, published branch, operation in progress); remote editor with redacted URLs; filter chips composing with the text query; expected-branch summary line. |
| E2E | Create a worktree, open it in the configured IDE, remove it. Rebase a branch with a conflict: resolve, continue, and confirm the resulting history. Filter a 100-repository workspace to *wrong branch* and confirm the set matches the expected-branch configuration. |
| OS-specific / manual | Worktree paths with spaces and non-ASCII characters on all three OSes; worktree on a different drive on Windows; IDE and terminal launch into a worktree path. |
| Benchmark | Health computation and filter application on `ws-100`; worktree listing on a repository with 20 worktrees. |

## Acceptance criteria

1. `list_worktrees` returns every worktree of a repository, including the main
   one, with branch, head, locked, and prunable flags, matching
   `git worktree list --porcelain` for the same repository.
2. Creating a worktree for a new branch produces a checked-out worktree at the
   chosen path with that branch, in one user action.
3. Removing a worktree with uncommitted changes without `force` fails and reports
   the changes; with `force` it succeeds only after a preflight labeled *not
   recoverable*.
4. Importing a folder that contains a repository and its worktrees adds the
   repository once and no worktree as a separate repository.
5. Starting a rebase with a clean tree and no conflicts completes and reports
   `Normal`; with conflicts it reports `Rebase { .. }` and the Phase 9 banner
   offers continue, skip, and abort.
6. Starting a rebase with a dirty working tree offers cancel or stash-and-rebase
   and never autostashes.
7. Starting a rebase on a branch whose commits are published states the number of
   published commits that would be rewritten before the action is available.
8. Remote add, rename, URL edit, and remove are reflected in `git config` and in
   the branch upstream pickers without a restart.
9. A remote URL containing userinfo is displayed and logged with the credentials
   redacted.
10. `RepoHealth` is computed in the backend, and the dashboard summary, sidebar
    badges, and filters all read the same value — verified by a test that changes
    one repository's state and asserts all three surfaces agree.
11. A merely dirty repository is not counted as needing attention; a diverged,
    conflicted, wrong-branch, in-progress, or unreadable one is.
12. Setting a workspace's expected branch to `develop` makes the workspace header
    report the count on that branch, and the *wrong branch* filter returns exactly
    the repositories not on it, including detached-HEAD ones.
13. Filter selections survive a restart.
14. Interactive rebase (P10-11) writes a todo list Git accepts and drives the
    resulting sequence through the same operation-state controls, with every
    action reversible via abort until the sequence completes.
