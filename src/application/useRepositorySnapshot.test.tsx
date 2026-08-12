import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/application/queryKeys";
import { useRepositorySnapshot } from "@/application/useRepositorySnapshot";
import type {
  CommitPage,
  RepositorySnapshot,
  SnapshotRevalidation,
  StoredRepositorySnapshot,
} from "@/domain/generated";

const ipc = vi.hoisted(() => ({
  captureRepositorySnapshot: vi.fn(),
  captureRepositorySnapshotInBackground: vi.fn(),
  getRepositorySnapshot: vi.fn(),
  revalidateRepositorySnapshot: vi.fn(),
}));

vi.mock("@/infrastructure/tauriClient", () => ipc);

function snapshot(branch: string, message: string): RepositorySnapshot {
  return {
    status: { branch, ahead: 0, behind: 0, dirtyCount: 1, hasConflict: false },
    branches: [
      {
        name: branch,
        isCurrent: true,
        isRemote: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        targetCommitId: `${message}-id`,
      },
    ],
    tags: [],
    firstHistoryPage: {
      commits: [
        {
          id: `${message}-id`,
          parentIds: [],
          message,
          authorName: "Fjord",
          authorEmail: "fjord@example.test",
          authoredAt: "2026-08-10T10:00:00Z",
          refs: [branch],
        },
      ],
      nextCursor: null,
    },
    workingChanges: {
      staged: [],
      unstaged: [{ path: `${message}.txt`, changeType: "modified", conflicted: false }],
    },
    generations: { workingTree: 1, refs: 1, history: 1, stash: 0, config: 0 },
  };
}

function stored(value: RepositorySnapshot, validated: boolean): StoredRepositorySnapshot {
  return {
    repoId: "repo-1",
    snapshot: value,
    capturedAt: "2026-08-10T10:00:00Z",
    validated,
  };
}

function Probe() {
  const state = useRepositorySnapshot("repo-1");
  const client = useQueryClient();
  const status = client.getQueryData<RepositorySnapshot["status"]>(
    queryKeys.repos.status("repo-1"),
  );
  return (
    <span>{`${state.ready ? (state.validated ? "validated" : "unvalidated") : "loading"}:${status?.branch ?? "none"}`}</span>
  );
}

describe("useRepositorySnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.captureRepositorySnapshotInBackground.mockResolvedValue(undefined);
  });

  it("paints persisted data first and patches the same caches after revalidation", async () => {
    const persisted = snapshot("saved", "saved");
    const live = snapshot("live", "live");
    let resolveRevalidation!: (value: SnapshotRevalidation) => void;
    ipc.getRepositorySnapshot.mockResolvedValue(stored(persisted, false));
    ipc.revalidateRepositorySnapshot.mockReturnValue(
      new Promise<SnapshotRevalidation>((resolve) => {
        resolveRevalidation = resolve;
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("unvalidated:saved")).toBeInTheDocument();
    expect(client.getQueryData(queryKeys.repos.branches("repo-1"))).toEqual(persisted.branches);
    expect(client.getQueryData(queryKeys.repos.workingChanges("repo-1"))).toEqual(
      persisted.workingChanges,
    );
    expect(
      client.getQueryData<InfiniteData<CommitPage, string | null>>(
        queryKeys.repos.commits("repo-1"),
      )?.pages[0],
    ).toEqual(persisted.firstHistoryPage);
    await waitFor(() => expect(ipc.revalidateRepositorySnapshot).toHaveBeenCalledWith("repo-1"));

    await act(async () => {
      resolveRevalidation({ snapshot: stored(live, true), changed: true });
    });
    expect(screen.getByText("validated:live")).toBeInTheDocument();

    view.unmount();
    expect(ipc.captureRepositorySnapshotInBackground).toHaveBeenCalledWith("repo-1");
  });
});
