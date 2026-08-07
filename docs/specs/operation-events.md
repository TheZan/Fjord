# Spec: long-running operation events

Referenced by: `P4-17`, SDD §8, [`ipc-commands.md`](ipc-commands.md).

## Purpose

Long Git operations (`fetch`, `pull`, `push`) and workspace bulk operations can outlive a normal UI interaction. The frontend starts each operation with a caller-generated `operationId`, listens for progress on one Tauri event, and can request cancellation with a separate command.

## Commands

| Command | Input | Output | Notes |
|---|---|---|---|
| `fetch_repo` | `{ repo_id, remote?, operation_id? }` | — | Emits operation events when `operation_id` is supplied. |
| `pull_repo` | `{ repo_id, operation_id? }` | — | Emits operation events when `operation_id` is supplied. |
| `push_repo` | `{ repo_id, operation_id? }` | — | Emits operation events when `operation_id` is supplied. |
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
  kind: "fetch" | "pull" | "push" | "bulk-fetch" | "bulk-pull";
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

## Cancellation Semantics

Cancellation is process-aware. `fjord-app` stores an atomic cancellation flag per
active operation and passes it through `GitOperationContext` to the system-Git
runner.

- Fetch, pull's fetch phase, and push terminate the complete Git process tree.
- Reader tasks drain/finish, the runner returns `Cancelled`, and only then is the
  final `cancelled` event emitted and the registry entry removed.
- Bulk operations stop scheduling queued repositories and cancel already-started
  remote processes while preserving per-repository write locks.

Cancelled commands reject with `AppError { code: "operation_cancelled", message: "operation cancelled" }`. The frontend treats that as a controlled stop, not a user-facing failure.

## Authentication prompt event

Event name: `fjord-auth-prompt`.

The payload contains `operationId`, one-use `promptId`, prompt text, kind
(`username`, `secret`, `confirmation`, or `unknown`), and optional repository /
operation labels. It never contains the broker address or bearer token. Prompts
are displayed one at a time; terminal operation events remove every queued prompt
for that operation.
