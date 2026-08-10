# Spec: Git backend ports

Referenced by: P0-02, P0-03, P1-01–P1-08.

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
    async fn status(&self, repo: &RepoPath) -> Result<RepoStatus, GitError>;
    async fn branches(&self, repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError>;
    async fn log(&self, repo: &RepoPath, from: LogCursor, limit: u32) -> Result<CommitPage, GitError>;
    async fn diff(&self, repo: &RepoPath, commit: &CommitId) -> Result<Vec<FileDiff>, GitError>;
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

`LogCursor` + `limit` on `log` is deliberate, not incidental: it's what makes P1-03's paginated commit graph and the "Load earlier commits" affordance real instead of a UI-only illusion over a fully-materialized history.

## Engine routing

| Method | Engine (today) | Why |
|---|---|---|
| `status` | `gix` | Hot path, run per-repo on every dashboard refresh — this is the operation the "fast on large repos" claim lives or dies on. |
| `branches` | `gix` | Read-only, cheap, no gaps in gix. |
| `log` | `gix` | Read-only traversal; gix's commit-graph handling is the reason large-history performance is realistic at all. |
| `diff` | `gix` | Read-only. |
| `file_diff` | `gix` | Read-only; unified line diff via `gix-diff`'s blob platform and `imara-diff`. |
| `checkout` | `git2` | Working-tree writes are already proven in libgit2 and share error handling with the other mutation paths. |
| `stage` / `unstage` / `commit` | `git2` | Index writes and commit creation are mature and easy to validate against temporary repositories. |
| `fetch` | system Git | Uses the user's credential helpers, SSH configuration, proxy, and certificates. |
| `pull` network phase | system Git | Fetch through `GitRemoteBackend`, then local fast-forward/merge through `git2`; never delegated to configurable `git pull`. |
| `push` / remote branch deletion | system Git | Same user Git environment; no libgit2 credential callbacks in the final path. |
| `open_merge_tool` | system `git mergetool` | Explicit escape hatch for P1-08 conflict flow; launches the user's configured external merge tool and is not used in hot-path status/log/diff operations. |

The local/remote split is deliberate: maturing local engines can change behind
`GitBackend`, while authentication and transport stay delegated to the installed
Git through `GitRemoteBackend`.

The local trait has no fetch, push, or remote-branch deletion methods. This is a
compile-time guard against reintroducing libgit2 transport or hidden network I/O.
It does answer *where* a push goes: `current_push_target` reads the branch's
upstream configuration and returns the remote plus both refs, or `NoUpstream`.
Resolving that locally keeps the decision out of the transport and out of the
user's `push.default`.

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
