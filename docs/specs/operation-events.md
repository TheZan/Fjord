# Spec: long-running operation events

Referenced by: `P4-17`, `P9R-02`, `P9R-03`, SDD §8, [`ipc-commands.md`](ipc-commands.md).

## Purpose

Long Git operations (`clone`, `fetch`, `pull`, `push`) and workspace bulk operations can outlive a normal UI interaction. The frontend starts each operation with a caller-generated `operationId`, listens for progress on one Tauri event, and can request cancellation with a separate command.

## Commands

| Command | Input | Output | Notes |
|---|---|---|---|
| `clone_repository` | `{ request: { workspace_id, url, destination_parent, directory_name?, branch? }, operation_id? }` | `CloneRepositoryResult` | Workspace/destination validation occurs before operation registration; the successful terminal event carries the new `repoId`. |
| `fetch_repo` | `{ repo_id, remote?, operation_id? }` | — | Emits operation events when `operation_id` is supplied. |
| `pull_repo` | `{ repo_id, operation_id? }` | — | Emits operation events when `operation_id` is supplied. |
| `push_repo` | `{ repo_id, operation_id? }` | — | Emits operation events when `operation_id` is supplied. |
| `commit_and_push_repo` | `{ repo_id, message, amend, operation_id? }` | `CommitPushResult` | Uses one operation id for both phases. A push failure after commit is a partial result and terminal `failed` event, not a rollback. |
| `continue_operation` / `skip_operation` | `{ repo_id, operation_id? }` | `RepoOperationState` | Runs the local system-Git sequencer command and returns the newly detected state. Abort is destructive and therefore runs through `execute_destructive_action` with its operation id. |
| `merge_branch` | `{ repo_id, source, mode, dirty_policy, operation_id? }` | `MergeResult` | Runs the local branch merge with message-only progress; conflict is a successful typed result. |
| `bulk_fetch` | `{ workspace_id, operation_id? }` | `BulkRepoResult[]` | Emits per-repo start/finish events. |
| `bulk_pull` | `{ workspace_id, operation_id? }` | `BulkRepoResult[]` | Emits per-repo start/finish events. |
| `cancel_operation` | `{ operation_id }` | `boolean` | `true` means an active operation saw the cancel request. |
| `answer_git_auth_prompt` | `{ operation_id, prompt_id, value }` | `boolean` | Resolves one waiting prompt once. The value is never persisted or logged. |
| `cancel_git_auth_prompt` | `{ operation_id, prompt_id }` | `boolean` | Cancels the prompt and its registered Git operation. |

The TypeScript IPC wrapper generates `operationId` before invoking a cancellable command, so the UI can subscribe and cancel immediately.

## Event

Event name: `fjord-operation-progress`.

Payload shape:

```ts
type OperationProgressEvent = {
  operationId: string;
  kind: "clone" | "fetch" | "pull" | "push" | "publish" | "commit-push" | "bulk-fetch" | "bulk-pull" | "continue-operation" | "skip-operation" | "abort-operation" | "merge"
      // 🚧 planned: "rebase" (P10-04)
      ;
  scope:
    | { type: "repo"; repoId: string }
    | { type: "workspace"; workspaceId: string };
  status: "started" | "progress" | "repo-started" | "repo-finished" | "succeeded" | "failed" | "cancelled";
  repoId: string | null;
  completed: number;
  total: number;
  message: string | null;
  error: string | null;
};
```

`completed` / `total` are parsed system-Git object-count progress for network
operations and repository-count progress for bulk operations. Indeterminate phases
use a message with `total = 0`. Carriage-return output is treated as a progress
boundary and noisy events may be coalesced before IPC.

For `commit-push`, the initial composite event uses `total = 2`. Its terminal
event reports `completed = 2` on full success or `completed = 1` when the commit
survived but push failed. The command then resolves `CommitPushResult` with both
phase outcomes; only a failure before commit creation rejects the command.

## Cancellation Semantics

Cancellation is process-aware. `fjord-app` stores an atomic cancellation flag per
active operation and passes it through `GitOperationContext` to the system-Git
runner.

- Fetch, pull's fetch phase, and push terminate the complete Git process tree.
- Clone terminates the complete Git process tree. A partial destination is
  retained rather than recursively deleted; no repository row is added unless
  the clone completed and registration succeeded.
- Continue, skip, and abort use the same process-tree termination; cancellation
  can leave Git's sequencer state in progress, and the next operation-state read
  remains authoritative.
- `merge` (`P10-MERGE-01`, [`branch-merge.md`](branch-merge.md)) follows the
  same rule: it is a local mutation with message-only progress (`total = 0`,
  because `git merge` reports no countable units), cancellation terminates the
  process tree, and a cancelled merge may leave a detectable in-progress merge
  that the operation banner then offers to abort. Cancellation is never silently
  equivalent to abort. A **conflicted** merge is a `succeeded` terminal event —
  Git did what it was asked — carrying the typed `Conflicted` result; only a
  genuine failure emits `failed`.
- Reader tasks drain/finish, the runner returns `Cancelled`, and only then is the
  final `cancelled` event emitted and the registry entry removed.
- Bulk operations stop scheduling queued repositories and cancel already-started
  remote processes while preserving per-repository write locks.

Cancelled commands reject with `AppError { code: "operation_cancelled", message: "operation cancelled" }`. The frontend treats that as a controlled stop, not a user-facing failure.

The clone onboarding UI retains its generated operation ID for both progress
lookup and cancellation. A terminal success publishes the returned repository
entry once and selects it; a cancelled clone returns to the editable form without
rendering an error alert.

## Authentication prompt event

Event name: `fjord-auth-prompt`.

The payload contains `operationId`, one-use `promptId`, prompt text, kind
(`username`, `secret`, `confirmation`, or `unknown`), and optional repository /
operation labels. It never contains the broker address or bearer token. Prompts
are displayed one at a time; terminal operation events remove every queued prompt
for that operation.
