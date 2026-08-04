# Spec: `GitBackend` port

Referenced by: P0-02, P0-03, P1-01–P1-08.

## Purpose

`fjord-services` must never import `gix` or `git2` directly (SDD §5.1). Every Git operation the app needs is expressed here, in domain terms, as a trait in `fjord-ports`. `fjord-git` is the only crate that implements it and the only crate allowed to depend on `gix`/`git2`.

## Trait surface (initial cut)

```rust
#[async_trait]
pub trait GitBackend: Send + Sync {
    async fn status(&self, repo: &RepoPath) -> Result<RepoStatus, GitError>;
    async fn branches(&self, repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError>;
    async fn log(&self, repo: &RepoPath, from: LogCursor, limit: u32) -> Result<CommitPage, GitError>;
    async fn diff(&self, repo: &RepoPath, commit: &CommitId) -> Result<Vec<FileDiff>, GitError>;
    async fn file_diff(&self, repo: &RepoPath, commit: &CommitId, path: &Path) -> Result<FileDiffDetail, GitError>;

    async fn checkout(&self, repo: &RepoPath, branch: &BranchName) -> Result<(), GitError>;
    async fn stage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError>;
    async fn commit(&self, repo: &RepoPath, message: &str) -> Result<CommitId, GitError>;
    async fn fetch(&self, repo: &RepoPath, remote: &RemoteName) -> Result<(), GitError>;
    async fn pull(&self, repo: &RepoPath) -> Result<(), GitError>;
    async fn push(&self, repo: &RepoPath, refspec: &RefSpec) -> Result<(), GitError>;
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
| `fetch` / `pull` | `git2` | Transport/credential handling is the mature path in git2 today. `pull` performs fetch + fast-forward/merge and reports conflicts as `GitError::Conflict`. |
| `push` | `git2` | Same — credentials, refspec edge cases, remote HTTP/SSH transports. |

This table is expected to change as `gix` matures — that's the entire point of routing through one trait instead of splitting the call sites. When a method's "Engine (today)" column changes, it's a one-line change in `fjord-git`, invisible to `fjord-services` and the frontend.

## Error handling

One `GitError` enum (via `thiserror`) wraps both engines' error types as variants (`GitError::Gix(...)`, `GitError::Git2(...)`) plus domain-level variants (`GitError::RepoNotFound`, `GitError::Conflict { paths }`, `GitError::AuthenticationFailed`). `fjord-app` maps this to the serializable `AppError { code, message }` at the Tauri command boundary (SDD §8) — the frontend switches on `code`, never on engine-specific error text.

## Testing

Integration tests run against real fixture repositories under `fixtures/` (generated at test-setup time, not checked in as binary blobs), on all three OS targets in CI — this is where the gix/git2 routing table gets validated for real, not just documented.
