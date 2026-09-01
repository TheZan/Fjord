# Spec: Git backend ports

Referenced by: P0-02, P0-03, P1-01–P1-08, P9-01–P9-03, P9-08–P9-09, P9R-04,
P9R-06; extended by P10-06, P10-MERGE-01, P10-WC-01–P10-WC-06, and
P10-STASH-01–P10-STASH-06.

## Purpose

`fjord-services` must never import `gix`, `git2`, or process APIs directly (SDD
§5.1). Repository-local operations are expressed by `GitBackend`; network
operations are expressed by `GitRemoteBackend`; discovery and diagnostics are
expressed by `GitEnvironmentProvider`. `fjord-git` implements all three adapters.
See [`system-git-transport.md`](system-git-transport.md).

## Trait surface (initial cut)

```rust
#[async_trait]
pub trait GitBackend: Send + Sync {
    async fn init_repository(&self, repo: &RepoPath, initial_branch: &str) -> Result<(), GitError>;
    async fn status(&self, repo: &RepoPath) -> Result<RepoStatus, GitError>;
    async fn operation_state(&self, repo: &RepoPath) -> Result<RepoOperationState, GitError>;
    async fn continue_operation(&self, repo: &RepoPath) -> Result<RepoOperationState, GitError>;
    async fn skip_operation(&self, repo: &RepoPath) -> Result<RepoOperationState, GitError>;
    async fn abort_operation(&self, repo: &RepoPath) -> Result<RepoOperationState, GitError>;
    async fn branches(&self, repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError>;
    async fn remotes(&self, repo: &RepoPath) -> Result<Vec<RemoteInfo>, GitError>;
    async fn add_remote(&self, repo: &RepoPath, name: &str, url: &str) -> Result<RemoteInfo, GitError>;
    async fn set_remote_url(&self, repo: &RepoPath, name: &str, fetch: &str, push: Option<&str>) -> Result<RemoteInfo, GitError>;
    async fn rename_remote(&self, repo: &RepoPath, old: &str, new: &str) -> Result<RemoteInfo, GitError>;
    async fn preflight_remove_remote(&self, repo: &RepoPath, name: &str) -> Result<RemoveRemotePreflight, GitError>;
    async fn remove_remote(&self, repo: &RepoPath, name: &str, expected_config_generation: u64, confirmation_token: &str) -> Result<(), GitError>;
    async fn log(&self, repo: &RepoPath, from: Option<LogCursor>, limit: u32) -> Result<CommitPage, GitError>;
    async fn reflog(&self, repo: &RepoPath, ref_name: Option<&str>, from: Option<LogCursor>, limit: u32) -> Result<ReflogPage, GitError>;
    async fn reflog_refs(&self, repo: &RepoPath) -> Result<Vec<String>, GitError>;
    async fn diff(&self, repo: &RepoPath, commit: &CommitId) -> Result<Vec<FileDiff>, GitError>;
    async fn diff_against_head(&self, repo: &RepoPath, commit: &CommitId) -> Result<Vec<FileDiff>, GitError>;
    async fn file_diff_window(
        &self,
        repo: &RepoPath,
        commit: &CommitId,
        path: &Path,
        offset: u32,
        limit: u32,
    ) -> Result<FileDiffWindow, GitError>;

    async fn checkout(&self, repo: &RepoPath, branch: &BranchName) -> Result<(), GitError>;
    async fn stage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError>;
    async fn commit(&self, repo: &RepoPath, message: &str) -> Result<CommitId, GitError>;
    async fn amend_info(&self, repo: &RepoPath) -> Result<AmendInfo, GitError>;
    async fn amend(&self, repo: &RepoPath, message: &str) -> Result<CommitId, GitError>;
    async fn integrate_upstream(&self, repo: &RepoPath) -> Result<(), GitError>;
    async fn open_merge_tool(&self, repo: &RepoPath) -> Result<(), GitError>;
}

#[async_trait]
pub trait GitRemoteBackend: Send + Sync {
    async fn fetch(/* repo, remote, refspecs, context */) -> Result<(), GitRemoteError>;
    async fn push(/* repo, remote, refspecs, context */) -> Result<(), GitRemoteError>;
    async fn publish_branch(/* repo, remote, branch_ref, context */) -> Result<(), GitRemoteError>;
    async fn delete_remote_branch(/* ... */) -> Result<(), GitRemoteError>;
    async fn ls_remote(/* ... */) -> Result<Vec<RemoteRef>, GitRemoteError>;
}
```

Exact types (`RepoStatus`, `BranchInfo`, `CommitPage`, ...) live in `fjord-domain` and are what gets mirrored to TypeScript via `specta`/`ts-rs` (SDD §6.1) — this trait's signatures are effectively half of the frontend/backend contract.

`LogCursor` + `limit` on `log` and `reflog` is deliberate, not incidental: it
keeps both history surfaces genuinely paginated instead of placing a UI window
over fully-materialized repository data. Reflog pages additionally fail closed
at 200 entries per response.

## Engine routing

| Method | Engine (today) | Why |
|---|---|---|
| `init_repository` | `git2` | Creates one local non-bare repository without transport or an initial commit. Fjord initializes in an app-owned sibling staging directory and publishes only after success, so a failed initialization does not leave a partial target. |
| `status` | `gix` | Hot path, run per-repo on every dashboard refresh — this is the operation the "fast on large repos" claim lives or dies on. |
| `operation_state` | filesystem markers + `git2` index | Reads the resolved per-worktree git-dir for operation kind/progress and refreshes the index for authoritative conflict paths; it performs no subprocess or network access. |
| `continue_operation` / `skip_operation` / `abort_operation` | system Git + filesystem markers + `git2` index | Lets Git own its sequencer formats, uses the shared resolved executable and cancellable process runner with non-interactive editors, then detects and returns the new state under the repository write lock. |
| `branches` | `gix` | Read-only, cheap, no gaps in gix. |
| `remotes` / `add_remote` / `set_remote_url` / removal preflight | `git2` | Reads and writes only local Git configuration under repository locks. Names use libgit2 validation; URL edits inspect all URL values and reject unsupported multi-valued configuration before the first write, preserve unrelated keys, and keep absent `pushurl` distinct from an explicit value. Affected branches come from actual `branch.*.remote` configuration, and returned URLs are sanitized before crossing IPC. |
| `rename_remote` / confirmed `remove_remote` | system Git (local `git remote rename/remove`) + `git2` validation/readback | Uses Git's native whole-remote semantics so refspecs, remote-tracking refs, and branch upstream configuration are updated together, including Windows local-path remotes. Commands run under the repository write lock with only validated remote names as arguments, perform no transport, and consume removal confirmation before delete. Rename advances `refs + config`; removal advances `refs + history + config` because it deletes remote-tracking refs and can change reachable history. |
| `reflog` / `reflog_refs` | `git2` | Reads Git's native newest-first reflog entries and signatures directly, under the repository read lock, without parsing localized CLI output. |
| `log` | `gix` | Read-only traversal; gix's commit-graph handling is the reason large-history performance is realistic at all. |
| `diff` | `gix` | Read-only. |
| `diff_against_head` | `gix` tree diff + system Git numstat | Read-only Recovery Center comparison from the current `HEAD` tree to the selected commit; system Git supplies bounded line statistics without loading file bodies into IPC. |
| `file_diff` | `gix` | Read-only; unified line diff via `gix-diff`'s blob platform and `imara-diff`. |
| Working patch generation | `git2` diff + pure Rust constructor | Read-only. Reuses the working-file diff model, verifies a SHA-256 digest, and produces unified patch bytes for system-Git apply tasks. |
| `stage_patch` | `git2` diff + system `git apply --cached` | Reconstructs and validates the selection under the repository write lock and Git's resolved per-worktree `index.lock`, applies through an alternate transactional index, verifies the exact original-index fingerprint and current diff, atomically publishes the index, and advances `working_tree` only on success. The shared apply profile explicitly uses `--whitespace=nowarn --no-ignore-whitespace`, independent of user apply configuration. |
| `unstage_patch` | `git2` diff + system `git apply --cached --reverse` | Uses the same index transaction and additionally prepares a verify-only `git update-ref` transaction for HEAD, holding HEAD and its target ref stable until index publication. It preserves unselected index-side context, never writes the worktree, and advances `working_tree` only on success under the deterministic apply profile. |
| `discard_patch` | `git2` diff + system `git apply --reverse` | Holds the resolved per-worktree index lock across final reconstruction and contextual worktree apply, preventing standard external Git index/worktree operations from changing the discard base. It never publishes an index write. |
| `checkout` | `git2` | Working-tree writes are already proven in libgit2 and share error handling with the other mutation paths. |
| `stage` / `unstage` / `commit` / `amend` | `git2` | Index writes and commit creation are mature and easy to validate against temporary repositories; amend reuses `HEAD`'s author and parents. |
| `fetch` | system Git | Uses the user's credential helpers, SSH configuration, proxy, and certificates. |
| `pull` network phase | system Git | Fetch through `GitRemoteBackend`, then local fast-forward/merge through `git2`; never delegated to configurable `git pull`. |
| `push` / remote branch deletion | system Git | Same user Git environment; no libgit2 credential callbacks in the final path. |
| `open_merge_tool` | system `git mergetool` | Explicit escape hatch for P1-08 conflict flow; launches the user's configured external merge tool and is not used in hot-path status/log/diff operations. |

Phase 10 routing. These rows record the engine choice and its reasoning per task;
`P10-MERGE-01` and `P10-WC-01`–`P10-WC-06` are now **implemented**, and the
rationale is kept because it is the reason the code looks the way it does:

| Method | Engine | Why | Task |
|---|---|---|---|
| `merge_preflight` | `gix` refs + `git2` status/index | Read-only: merge-base, bounded ahead/behind counts, index-vs-`HEAD` comparison, and the same bounded overwrite intersection `checkout_overwrite_paths` already computes. No subprocess, no network. | `P10-MERGE-01` |
| `merge_branch` | system Git (`merge --no-edit [--ff-only]`) | Symmetry with `continue_operation` / `abort_operation`: the process that starts a merge must speak the same on-disk protocol as the one that finishes it, so a conflicted merge is the same state whether Fjord, the CLI, or another client began it. It also honors the user's `merge.*` configuration, hooks, and commit signing, which a libgit2 merge would bypass. `integrate_upstream` keeps its existing `git2` analysis for `pull` unchanged — the divergence is deliberate and recorded in [`branch-merge.md`](branch-merge.md) §7. | `P10-MERGE-01` |
| `resolve_repository_file_path` | `fjord-fs` path normalization | Canonicalizes the repository root and the target's **parent**, asserts containment, and returns both forms. Not a Git operation; it is the single authority for absolute paths crossing IPC. | `P10-WC-01` |
| `add_ignore_rule` / `preview_ignore_rule` | plain filesystem + `git2` tracked-state check | The tracked check must be authoritative (a `.gitignore` rule cannot untrack a file); the write is a bounded read-modify-append on one working-tree file. Decoding is UTF-8 only, BOM tolerated and preserved; invalid UTF-8 fails closed with `ignore_file_encoding_unsupported` and no charset-detection dependency is introduced. | `P10-WC-02` |
| `export_patch` | `git2` diff + the `P8-01` patch constructor | Reuses the shipped deterministic constructor and digest verification rather than adding a second patch implementation; the resulting bytes are the same ones `git apply` accepts. | `P10-WC-03` |
| `delete_file` (via `execute_confirmed_destructive_action`) | `git2` status/index + filesystem unlink | Status classifies the path's tracked, worktree-modified, and **staged** state for the preflight; a path with independent staged content is a blocker, not a consequence, and is re-checked under the repository write lock before execution. The removal itself unlinks one path (never a directory, never a symlink's target). | `P10-WC-04` |
| `open_external_diff` | system `git difftool --no-prompt` (plus `--cached` for a staged row, plus `--tool=<name>` when `Settings.diff_tool` holds one) | Git resolves the tool from `diff.tool` / `difftool.<name>.cmd`, so Fjord stores a tool **name** at most and never a command line — the same reason `open_merge_tool` stores no merge-tool command. The merge tool is *not* assumed to be the diff tool. | `P10-WC-06` |

Stash routing (`P10-STASH-01`–`P10-STASH-06`,
[`stash-management.md`](stash-management.md)):

| Method | Engine | Why | Task |
|---|---|---|---|
| `stashes` | `git2` refs + reflog + commit/tree reads | The whole model is repository-derived: `refs/stash`'s reflog gives the stack and its order, the stash commit's first parent gives the base, and comparing its parents' trees gives the staged/untracked structure and the file count. No subprocess, no parsing of `git stash list` output, and nothing persisted — Git owns stash state. | `P10-STASH-01` |
| `stash_files` / `stash_file_diff` | `gix`/`git2` tree diff + the existing bounded diff pipeline | Read-only tree-to-tree diffs between the exact parent pairs each group names, fed through the shipped `FileDiffWindow` construction so ceilings, whitespace modes, digests, and generation envelopes are the ones already proven. No second diff implementation. | `P10-STASH-04` |
| `create_stash` | system Git | The only interactive creation engine. `All` is ordinary `stash push [-u] -m …`. `Paths` (Git ≥ 2.23) uses private `GIT_INDEX_FILE` indexes to compose exact selected-only index/worktree/untracked trees and creates Git's standard stash parent topology with `write-tree`/`commit-tree`. Its final boundary holds the real per-worktree `index.lock` plus a prepared expected-HEAD ref transaction, revalidates the captured raw index and selected trees, cleans through the alternate transaction index, atomically replaces the real index while its lock remains present, and publishes `refs/stash` with one reflog-creating `update-ref` compare-and-swap against the expected old OID. A losing CAS restores the raw original index under the same lock. Plain `git stash list`/`show`/`apply`/`pop` accept the result; direct pathspec stash is not used because its entry can record unrelated staged content. | `P10-STASH-02` |
| `apply_stash` | system Git (`stash apply [--index] stash@{n}`) | Symmetry with creation, and `--index` restoration is Git's own semantics rather than something to reimplement over the index. The `stash@{n}` is constructed from a fresh identity re-resolution under the write lock, never accepted from the caller. A conflict is classified by a live index read, not by the exit code. | `P10-STASH-06` |
| `stash pop` / `stash drop` (via `execute_confirmed_destructive_action`) | system Git | Already the executor's path; `P10-STASH-06` only retypes the action on the stash commit OID and re-resolves the position under the write lock after the token is consumed. The dead `git2`-backed `GitBackend::stash_pop` (index 0, test-only) is deleted so one pop implementation remains. | `P10-STASH-06` |
| `create_branch_from_stash` | `git2` branch create + checkout, then system Git apply | Composes two shipped mutations rather than delegating to `git stash branch`, which drops the entry on success — a destructive side effect Fjord will not put inside a constructive action. | `P10-STASH-06` |

Every stash mutation re-resolves the caller's `StashId` to a current
`stash@{n}` **inside** the write-locked section and fails closed
(`stash_not_found` / `stash_ambiguous`) rather than acting on a stale position.
Stash reads take the repository read lock and write nothing.

`merge_branch` is a mutation on the operation pipeline: it holds the repository
write lock across blocker re-evaluation, ref resolution, the subprocess,
generation invalidation, and the final operation-state redetection. It does not
take Git's `index.lock` itself — the `git merge` subprocess acquires and releases
Git's own locks, which is the same cross-process boundary the patch mutations
rely on. Once Git has been launched, `working_tree`, `refs`, and `history`
advance even on failure or cancellation, matching `P9-03`.

Every planned method above takes arguments individually through the shared
resolved executable. None constructs a shell string, and none accepts a
caller-supplied ref, command, or absolute path as authority: refs are re-resolved
against the repository and paths are re-derived from the canonicalized root.

For patch mutations, Git-native locking is the cross-process transaction
boundary. Fjord's per-repository write lock serializes operations within the
process; the resolved per-worktree `index.lock` serializes index-dependent work
with standard Git commands and conforming Git clients; and unstage's prepared
`update-ref` transaction additionally serializes the HEAD and symbolic target
refs that define its base. This preserves normal Git guarantees without
inventing a second locking protocol.

A process that directly modifies or atomically replaces the real index while
ignoring `index.lock` is outside the supported concurrency model. The final
index fingerprint can detect a replacement that finishes before verification,
but cross-platform filesystem replacement APIs provide no portable
compare-and-swap that makes verification and publication indivisible. Editors
and other worktree-only writers are separately outside Git's index/ref locking
protocol and may race the final worktree replacement as described in
[`working-tree-and-diff.md`](working-tree-and-diff.md) §1.

The local/remote split is deliberate: maturing local engines can change behind
`GitBackend`, while authentication and transport stay delegated to the installed
Git through `GitRemoteBackend`.

Repository creation uses `main` when the request omits an initial branch. A
caller may supply another valid branch name, but initialization never creates a
commit: `HEAD` remains symbolic and unborn. A missing target directory or an
existing empty directory is accepted; files, symlinks, and non-empty directories
are refused explicitly. Initialization occurs in a unique sibling staging
directory. The completed repository is atomically renamed into a missing target,
or its `.git` directory is renamed into a still-empty existing target. App-owned
staging is removed on failure, while a successfully initialized repository is
never recursively deleted merely because later database registration failed.
Until the first commit, `operation_state` reports `UnbornBranch`, `log` returns
an empty page, and working-tree reads remain available; an unborn symbolic
`HEAD` is not treated as repository corruption.

The local trait has no fetch, push, or remote-branch deletion methods. This is a
compile-time guard against reintroducing libgit2 transport or hidden network I/O.
It does answer *where* a push goes: `current_push_target` reads the branch's
upstream configuration and returns the remote plus both refs, or `NoUpstream`.
Resolving that locally keeps the decision out of the transport and out of the
user's `push.default`.

For force-with-lease, `force_push_plan` additionally resolves the locally known
remote-tracking OID and exact local source commit. The local backend issues and
consumes a short-lived confirmation bound to that complete plan. The service
passes the consumed plan to `GitRemoteBackend`; IPC callers never supply remote,
ref, expected OID, or source OID authority.

## Adapter layout

`fjord-git` mirrors that split on disk:

```text
crates/fjord-git/src/
├── lib.rs                # exports only
├── executable.rs         # the one `git` binary local commands run
├── locking.rs
├── local/                # LocalGitBackend
│   ├── mod.rs            # GitBackend wiring, one delegation per method
│   ├── repository.rs     # handles, locking, shared error/command plumbing
│   ├── status.rs
│   ├── operation_state.rs
│   ├── operation_control.rs
│   ├── refs.rs
│   ├── history.rs
│   ├── diff.rs
│   ├── working_tree.rs
│   ├── mutations.rs
│   └── tests.rs
└── remote/               # SystemGitRemoteBackend, SystemGitEnvironmentProvider
    ├── backend.rs
    ├── process_runner.rs
    ├── executable.rs
    ├── progress.rs
    ├── errors.rs
    └── environment.rs
```

Rust requires a trait implementation to live in a single block, so `local/mod.rs`
keeps the `GitBackend` impl and delegates every method to the module that owns
the concern. The adapter is named `LocalGitBackend` because it is hybrid by
design (`gix` plus `git2`), not a `gix`-only backend.

## Error handling

Local failures use `GitError`. Remote failures use `GitRemoteError`, which maps to
the stable codes defined in [`system-git-transport.md`](system-git-transport.md).
`fjord-app` maps both to `AppError { code, message, diagnostics? }`; the frontend
switches on `code`, never engine-specific or localized text.

## Testing

Integration tests run against real fixture repositories under `fixtures/` (generated at test-setup time, not checked in as binary blobs), on all three OS targets in CI — this is where the gix/git2 routing table gets validated for real, not just documented.
