# Spec: working tree, partial staging, and diff experience

Referenced by: P8-00–P8-15, SDD §5.2, §15.
Related: [`git-backend.md`](git-backend.md), [`ipc-commands.md`](ipc-commands.md),
[`repository-safety.md`](repository-safety.md), [`performance.md`](performance.md).

## Problem

Fjord can stage, unstage, commit, and push — but only at whole-file granularity
(`stage_files(paths)` / `unstage_files(paths)`, `crates/fjord-app/src/commands/repo.rs`).
That gap is the single most common reason a developer leaves a Git GUI mid-task:

1. **A file with two unrelated changes cannot be split into two commits.** The
   user must drop to a terminal for `git add -p`, and once they are in the
   terminal they will finish the whole task there.
2. **A mistake in the last commit requires a terminal.** There is no amend, so
   "forgot to stage a file" or "typo in the message" means `git commit --amend`
   elsewhere.
3. **Correcting a pushed branch requires an unsafe habit.** Fjord offers no force
   push at all, so the user runs `git push --force` by hand — the exact command
   that overwrites a colleague's work. Offering only `--force-with-lease` inside
   Fjord is strictly safer than offering nothing.
4. **The diff is readable but not comparable.** Unified-only, no syntax
   highlighting, no whitespace control, no word-level diff. Reviewing a
   reformatting commit or a renamed-variable commit is materially harder in Fjord
   than in any competitor, which pushes review work out of the app.
5. **Discarding is all-or-nothing and unguarded.** There is no partial discard,
   and no path that tells the user exactly what is about to be lost.

## Goals

- Stage, unstage, and discard at hunk and selected-line granularity.
- Amend the last commit, including message-only amends, with an explicit warning
  when the commit is already published.
- Commit-and-push as one deliberate action.
- Force push available only as `--force-with-lease`, never bare `--force`.
- A diff view that supports unified and split modes, syntax highlighting,
  whitespace handling, and word-level highlighting, without regressing the diff
  performance budgets in [`performance.md`](performance.md).
- Upstream management and an explicit publish flow reachable from branch context.
- Every destructive action in this phase routed through the preflight contract in
  [`repository-safety.md`](repository-safety.md). `P8-00` implements that safety
  foundation before patch/discard or force-with-lease work begins; Phase 8 has no
  dependency on an unimplemented Phase 9 task.

## Non-goals

- A built-in merge/conflict resolution editor. SDD §3 stands: conflicts hand off
  to the user's configured merge tool. Phase 9 improves the *state* handling
  around conflicts, not the editing of them.
- Interactive rebase and history rewriting beyond amend of `HEAD` — that is
  Phase 10.
- A code editor. Fjord never edits file contents; it edits the *index*.
- Committing from a stale snapshot. See [`performance.md`](performance.md) §6.
- Blame, file history, and per-line authorship. Valuable, but they answer a
  different question and are not what makes a user leave the app mid-commit.

## Current state

| Capability | State |
|---|---|
| Whole-file stage/unstage | ✅ `stage_files` / `unstage_files`, empty list = all. `git2`-backed. |
| Working changes listing | ✅ `WorkingChanges { staged, unstaged }`, `WorkingFile { path, changeType, conflicted }`; a partially-staged file legitimately appears in both lists. |
| Working file diff | ✅ `working_file_diff(path, staged, offset, limit)` — index-vs-HEAD when staged, worktree-vs-index otherwise. Returns a bounded `FileDiffWindow` with exact totals, continuation cursor, and `tooLarge` metadata. |
| Patch model/generation | ✅ `PatchSelection` uses hunk coordinates plus complete-hunk line indices and a SHA-256 `baseDigest`. Working diff windows expose a digest over path, source, modes, hunk headers, line content, and terminators; construction verifies it before emitting deterministic selected hunks. The read and existing `working_tree` generation are captured coherently. |
| Partial stage mutation | ✅ `stage_patch` reconstructs the current worktree diff under the repository write lock, validates the caller's complete generation stamp and digest, runs `git apply --check --cached` then `git apply --cached` through the shared executable, and returns the success-only updated generation. Every Phase 8 apply uses the deterministic `--whitespace=nowarn --no-ignore-whitespace` profile, so user `apply.whitespace` / `apply.ignoreWhitespace` settings cannot rewrite patch bytes or relax context matching. |
| Partial unstage mutation | ✅ `unstage_patch` reconstructs the current staged diff under the same write lock and validation boundary, builds index-side context for selected changes, then runs `git apply --check --cached --reverse` and `git apply --cached --reverse` without writing the worktree, under the same deterministic apply profile. |
| Commit | ✅ `commit_repo(message)`; the panel composes `summary\n\ndescription`. |
| Amend | 🚧 Absent. |
| Discard | ✅ File, hunk, and selected-line discard use the shared destructive preflight. The backend reconstructs the current index-to-worktree selection under the repository write lock, runs `git apply --check --reverse`, revalidates/reconstructs, then applies without writing HEAD or the index; check and mutation use the same deterministic apply profile. |
| Push | ✅ System Git, target resolved from upstream, `no_upstream` → explicit publish (`publish_branch`). |
| Force push | 🚧 Absent. |
| Diff rendering | ⚠️ Unified only, virtualized rows (`FileDiffView.tsx`), change-type coloring, no highlighting, no whitespace options, no word diff. |
| Diff transport | ✅ 1,000-line incremental frontend windows, 2,000-line backend maximum, 2 MB response ceiling, and content-free metadata above 10 MB (`P6-16`). |
| Upstream management | ⚠️ Read-only: `current_push_target` resolves it; nothing sets or changes it. |
| Branch context menu | ✅ checkout, create branch here, rename, delete, delete remote, copy (`GitContextMenu.tsx`, `RepoTree.tsx`). |

## Proposed design

### 1. Partial staging model

The unit of work is a **patch selection**, not a hunk id. A hunk id would be
invalidated by any concurrent edit; a patch selection is verified against the
current file state before it is applied.

```rust
pub struct PatchSelection {
    /// Path as reported by `working_changes`.
    pub path: String,
    /// Which side the selection was made against.
    pub source: PatchSource,          // Worktree | Index
    /// Line selections within hunks, addressed by original line numbers.
    pub hunks: Vec<HunkSelection>,
    /// Digest of the diff the selection was computed from.
    pub base_digest: String,
}

pub struct HunkSelection {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Empty means "the whole hunk"; otherwise the selected line indices
    /// within the hunk, 0-based over the hunk's `lines` array.
    pub lines: Vec<u32>,
}
```

`base_digest` is a hash of the diff the UI rendered (path, source, hunk headers,
line contents). Applying a selection recomputes the diff and compares digests:

- digests match → build the patch and apply it;
- digests differ → fail with `patch_stale`, the frontend refreshes the diff and
  tells the user the file changed. Fjord never applies a patch to a file it has
  not just verified.

P8-01 uses SHA-256 and also covers file modes and exact line terminators. Those
bytes are necessary to distinguish LF from CRLF and a missing final newline;
they do not change the line-coordinate addressing visible to the frontend.
Working-file diff transport returns the same digest on every bounded window and
associates it with a coherently captured existing repository generation.
Binary, rename, mode-only, oversized/content-free, non-UTF-8 text, and empty-file
changes with no line hunk fail with `patch_unsupported` rather than being guessed
by the line-patch constructor. P8-15 owns the specified binary and mode-only UI.

Application mechanism: build a minimal unified patch from the selection and apply
it with `git apply --cached` (stage), `git apply --cached --reverse` (unstage), or
`git apply --reverse` against the worktree (discard), through the shared
`GitCommandFactory` executable ([`system-git-transport.md`](system-git-transport.md)
§"Executable discovery" — one Git for everything). `git apply` is chosen over a
hand-written index writer because patch application is exactly where subtle
correctness bugs destroy user work, and Git's own implementation handles CRLF,
trailing-newline, mode, and binary edge cases that a reimplementation would get
wrong.

New port methods on `GitBackend` (local, no network):

```rust
async fn stage_patch(
    &self,
    repo: &RepoPath,
    selection: &PatchSelection,
    expected_generations: GenerationSet,
) -> Result<GenerationSet, GitError>;
async fn unstage_patch(
    &self,
    repo: &RepoPath,
    selection: &PatchSelection,
    expected_generations: GenerationSet,
) -> Result<GenerationSet, GitError>;
async fn discard_patch(
    &self,
    repo: &RepoPath,
    action: &DestructiveAction,
    selection: &PatchSelection,
    expected_generations: GenerationSet,
    confirmation_token: &str,
) -> Result<GenerationSet, GitError>;
```

Each validates the caller's complete generation stamp while holding the
repository write lock, bumps only the `working_tree` generation
([`performance.md`](performance.md) §5) on success, and returns the resulting
generation set.

New IPC commands: `stage_patch`, `unstage_patch`, `discard_patch`. The first two
take `{ repo_id, selection, expected_generations }`; discard additionally takes
the exact confirmed `action` and backend-issued `confirmation_token`. Each
returns the resulting `GenerationSet`. New stable error codes: `patch_stale`,
`patch_apply_failed`, `patch_unsupported` (binary or mode-only change that has no
line representation).

### 2. Partial staging UI

Selection lives in the diff view, which becomes interactive:

- Every hunk header gets **Stage hunk** / **Unstage hunk** / **Discard hunk**,
  depending on which side is displayed.
- Lines are selectable by click and shift-click (range) and by keyboard
  (`Shift+↑/↓`); with a selection active, the same three actions apply to the
  selected lines.
- The action buttons are disabled while the repository has an unvalidated
  snapshot or an operation in progress.
- After a successful apply, the diff refetches and the selection clears; the
  scroll position is preserved.
- Discard always routes through the preflight dialog
  ([`repository-safety.md`](repository-safety.md) §3) showing line counts and the
  file path — never a bare "are you sure".

### 3. Amend, commit & push, force-with-lease

**Amend.** `commit_repo` gains `amend: bool`. When `amend` is true, the backend
commits with `HEAD`'s parent(s) and the current index, taking the author from the
original commit and the committer from the current identity — matching
`git commit --amend` semantics.

Before amending, the backend reports whether `HEAD` is published: `HEAD` is
contained in its branch's upstream ref. The UI shows an explicit warning in that
case ("this commit is already on `origin/main`; amending will require a force
push"). Amending is never blocked, only labeled — Fjord's job is to make the
consequence visible, not to override the user.

The commit panel gains an "Amend last commit" toggle that pre-fills the message
from `HEAD` and switches the button label. Toggling off restores the draft.

**Commit & push.** A split-button next to Commit. It runs commit, then push,
through the existing operation pipeline (one operation id, progress events per
[`operation-events.md`](operation-events.md)). A failed push after a successful
commit reports both outcomes distinctly: the commit is not rolled back, and the
UI says so.

**Force push.** `push_repo` gains `force_with_lease: bool`. The transport appends
`--force-with-lease=<remote_ref>:<expected_oid>` where `expected_oid` is the
locally known value of the remote-tracking ref — the explicit form, not the bare
flag, because bare `--force-with-lease` is defeated by a background fetch having
updated the tracking ref. Bare `--force` is not implemented anywhere in the code
path, and there is no setting that enables it.

Force push is offered only when a normal push failed with `git_non_fast_forward`,
inside a preflight dialog naming the remote ref, the commits that would be
dropped from the remote, and the expected OID. A stale-lease rejection maps to a
distinct code (`git_force_lease_failed`) with a "someone else pushed; fetch and
review" message.

### 4. Upstream management and publish

- Branch context gains **Set upstream…** (choose remote + remote branch) and
  **Unset upstream**, backed by new local commands `set_branch_upstream` /
  `unset_branch_upstream` — configuration writes, no network.
- The existing `publish_branch` flow becomes reachable from branch context and
  from a persistent affordance when the current branch has no upstream, instead of
  only as a recovery from a failed push.
- The branch row shows its upstream and divergence, so "which remote does this go
  to" is answerable without opening a dialog.

Remote CRUD (add/edit/remove remotes) belongs to
[`workspace-workflows.md`](workspace-workflows.md) §3; this spec only selects
among existing remotes.

### 5. Diff experience

| Feature | Design |
|---|---|
| Unified / split | One renderer, two row-builders over merged `FileDiffWindow` data. Split mode pairs deletion/addition rows and pads the shorter side. Mode is persisted (`repo.diffMode`, [`ui-shell.md`](ui-shell.md) §5) and toggled from the diff header. |
| Syntax highlighting | Tokenization runs in a Web Worker (the pattern `graphLayout.worker.ts` already establishes), per visible window only, keyed by file extension. A file whose language is unknown or whose window exceeds the token budget renders unhighlighted rather than late. Highlighting never delays first paint of the diff: rows render plain and upgrade in place. |
| Whitespace | Header toggle: *show* (default), *ignore trailing*, *ignore all*. Implemented backend-side as `git diff` whitespace flags on the diff computation, so the hunk structure the user stages matches what they see. A whitespace-ignoring mode disables hunk staging for the affected hunks (`patch_unsupported`), because the displayed hunk is not the real patch. |
| Word diff | Intra-line diff computed frontend-side over paired add/delete lines within a hunk, in the worker, above a similarity threshold; below it, the pair renders as a plain replace. Purely presentational — it never changes what a patch selection stages. |
| Huge diffs | Windowed transport from [`performance.md`](performance.md) §9: the view requests windows as it scrolls, shows total counts from the first response, and renders a `too_large` state with an explicit "load anyway" for files above the ceiling. |
| Binary / mode-only | Rendered as an explicit state with the change described in words; hunk actions are unavailable, whole-file actions remain. |

## Alternatives considered

**Patch application: `git apply` vs. writing the index with `git2`.** A `git2`
implementation avoids a subprocess and is faster per call. It also requires
reimplementing patch semantics — line endings, missing trailing newlines, mode
changes, intent-to-add entries — in the one place where a bug silently destroys
uncommitted work. The subprocess cost (single-digit milliseconds) is irrelevant
next to that risk, and the executable is already unified. `git apply` is chosen.

**Selection addressing: hunk index vs. line coordinates + digest.** Hunk indices
are simpler but are invalidated by any change to an earlier hunk, and a
mis-resolved index stages the *wrong* change without any error. Coordinates plus
a verified digest can only fail loudly (`patch_stale`). Chosen for that failure
mode.

**Force push: not offered vs. `--force-with-lease` only vs. both.** Not offering
it does not prevent force pushes; it moves them to a terminal where no preflight
exists. Offering both makes the unsafe one available under a familiar name. Only
`--force-with-lease`, with an explicit expected OID and a preflight, is chosen as
the option that measurably reduces the chance of destroying someone's work.

**Syntax highlighting: backend vs. worker vs. main thread.** Backend highlighting
would add a language stack to Rust and put presentation logic behind IPC. Main
thread violates SLO-12. A worker is chosen, consistent with the existing graph
layout worker.

**Whitespace handling: frontend filtering vs. backend diff flags.** Filtering
whitespace rows in the frontend is trivial but makes the displayed hunks diverge
from the real patch, which is unacceptable once hunks are stageable. Backend
flags keep display and patch identical, at the cost of a recomputation on toggle.

## Performance considerations

- Patch application is bounded by the selection, not the file: the generated patch
  contains only selected hunks. Applying a selection on the `diff-giant` fixture
  must stay within SLO-9's budget class, not scale with file size.
- The verification diff before apply is the same computation the view already
  performed; it reuses the `RepositoryRuntime` cache when the generation is
  unchanged, so the common case adds no Git work.
- Highlighting and word diff run per visible window only, in a worker, and are
  cancelled when the window scrolls away. Neither may delay the diff's first
  paint (SLO-9 / SLO-10).
- Split mode doubles the row count for the same content; the virtualizer's row
  estimate is recomputed on mode change to avoid a scroll jump.
- Amend and commit-and-push run through the existing operation pipeline and
  therefore inherit progress and cancellation without new machinery.

## Security / safety

- Every mutating command in this phase takes the repository write lock and runs
  through the shared resolved Git executable; no shell strings.
- `discard_patch` is irreversible for the discarded lines. It is gated by the
  preflight contract, it reports exact line counts, and it refuses to run against
  an unvalidated snapshot. Its short-lived, one-use confirmation is bound to the
  repository, action, complete patch selection and digest, and generation set;
  validation and consumption happen under the repository write lock.
- Amend of a published commit is permitted but always labeled with its
  consequence.
- Force push is `--force-with-lease` with an explicit expected OID; a stale lease
  fails closed.
- Patch content passes through the process runner's bounded buffers and is never
  logged; log lines carry path and counts only (SDD §10).
- `patch_stale` must be surfaced to the user, never retried automatically —
  an automatic retry against a changed file is exactly the failure mode the digest
  exists to prevent.

## Testing strategy

| Level | Coverage |
|---|---|
| Unit (Rust) | Patch generation from a selection: whole hunk, single line, first/last line of a file, file without trailing newline, CRLF file, added file, deleted file. Digest stability and mismatch detection. Force-with-lease argument construction. |
| Integration (Rust) | Against real fixtures: stage one hunk of a two-hunk file and assert `working_changes` shows the file in both lists; unstage a single line; discard a hunk and assert the worktree content; amend with and without a message change; amend preserves the original author; push with a stale lease is rejected with `git_force_lease_failed`. |
| Frontend/component | Hunk and line selection interactions; disabled states while pending or unvalidated; `patch_stale` refreshes and informs; split/unified row building; whitespace toggle disables hunk staging where the patch is not representable; `too_large` state. |
| E2E | Split a two-change file into two commits entirely through the UI; amend the message of the last commit; commit-and-push in one action with the push failing and the commit surviving. |
| Benchmark | Diff rendering and highlighting against `diff-giant`; patch apply latency on a large file; split-mode render cost vs. unified. |
| OS-specific / manual | CRLF repository on Windows; a file with mixed line endings; a repository with `core.autocrlf` enabled. |

## Acceptance criteria

1. Staging one hunk of a file with two hunks results in `working_changes`
   reporting that file in both `staged` and `unstaged`, and a commit records only
   the staged hunk's content.
2. Staging a selected subset of lines within a hunk stages exactly those lines,
   verified by comparing the resulting index blob against the expected content.
3. Unstaging and discarding at hunk and line granularity produce the inverse
   results, verified against index and worktree content respectively.
4. Applying a selection whose file changed on disk since the diff was rendered
   fails with `patch_stale`, changes nothing, and the UI shows the refreshed diff.
5. Discarding any amount of work presents a preflight that names the file and the
   exact number of lines to be discarded before anything is applied.
6. Amending the last commit with an unchanged tree and a new message produces a
   commit with the new message, the original author, and the original parents.
7. Amending a commit contained in its branch's upstream shows a published-commit
   warning before the action is available.
8. "Commit & push" with a failing push leaves the commit in place and reports the
   commit as succeeded and the push as failed, distinctly.
9. No code path constructs a `git push --force` invocation; force push is emitted
   only as `--force-with-lease=<ref>:<oid>` with an OID read from the local
   remote-tracking ref, and only after a preflight naming the affected remote ref.
10. A force push whose lease is stale fails with `git_force_lease_failed` and does
    not modify the remote.
11. The diff view toggles between unified and split, and the choice survives a
    restart.
12. Syntax highlighting never delays the diff's first painted row; rows appear
    unhighlighted and upgrade in place, verified by a trace showing first paint
    before the first highlight commit.
13. With a whitespace-ignoring mode active, hunk-level staging is unavailable and
    the reason is shown, rather than staging a patch that differs from the display.
14. Setting a branch's upstream through the UI changes only configuration, is
    reflected in the branch row, and a subsequent push targets the new upstream.
