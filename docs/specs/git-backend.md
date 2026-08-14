# Spec: Git backend ports

Referenced by: P0-02, P0-03, P1-01–P1-08, P9-01–P9-03, P9-08–P9-09, P9R-04, P9R-06.

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
| `remotes` / `add_remote` | `git2` | Reads and writes only local Git configuration under repository locks. Duplicate names are refused, unrelated keys are preserved, and returned URLs are sanitized before crossing IPC. |
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
