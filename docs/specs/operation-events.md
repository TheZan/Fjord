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

`completed` / `total` are object-count progress for libgit2 network transfer events and repository-count progress for bulk operations. When a Git backend cannot expose granular transfer numbers, it still emits lifecycle events.

## Cancellation Semantics

Cancellation is cooperative. `fjord-app` stores an atomic cancellation flag per active operation and passes it into `GitBackend` through `GitOperationContext`.

- Fetch and the fetch phase of pull abort from libgit2 transfer callbacks.
- Push emits transfer progress; cancellation is honored at safe libgit2 callback boundaries and before/after the operation.
- Bulk operations stop scheduling queued repositories after cancellation and wait for already-started Git operations to return through their cancellation-aware contexts, preserving per-repository write locks.

Cancelled commands reject with `AppError { code: "operation_cancelled", message: "operation cancelled" }`. The frontend treats that as a controlled stop, not a user-facing failure.
