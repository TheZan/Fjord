import type { ReactNode } from "react";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/application/queryKeys";
import {
  repositoryChangeScopes,
  useRepositoryChangeEvents,
} from "@/application/useRepositoryChangeEvents";
import type { RepositoryEntry } from "@/domain/workspace";
import * as tauriClient from "@/infrastructure/tauriClient";
import type { RepositoryChangedEvent } from "@/infrastructure/tauriClient";
import {
  forgetRepositoryGenerations,
  observeRepositoryGenerations,
} from "@/infrastructure/repositoryGenerations";

vi.mock("@/infrastructure/tauriClient", () => ({
  listenRepositoryChanges: vi.fn(),
}));

const repo: RepositoryEntry = {
  id: "repo-1",
  workspaceId: "workspace-1",
  name: "fjord",
  path: "/dev/fjord",
  sortOrder: 0,
};

let repositoryChangeHandler: ((event: RepositoryChangedEvent) => void) | undefined;
let stopListening: () => void;

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

describe("repositoryChangeScopes", () => {
  it("maps only affected repository data", () => {
    forgetRepositoryGenerations();
    observeRepositoryGenerations("repo-1", zeroGenerations(), "status");
    observeRepositoryGenerations("repo-1", zeroGenerations(), "operation");
    observeRepositoryGenerations("repo-1", zeroGenerations(), "history");
    observeRepositoryGenerations("repo-1", zeroGenerations(), "refs");
    expect(
      repositoryChangeScopes({
        repoId: "repo-1",
        status: true,
        working: false,
        history: true,
        refs: true,
        stashes: false,
        config: false,
        generations: { ...zeroGenerations(), refs: 1, history: 1 },
        statusSummary: null,
      }),
    ).toEqual(["status", "operation", "history", "refs"]);
  });
});

describe("useRepositoryChangeEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetRepositoryGenerations();
    repositoryChangeHandler = undefined;
    stopListening = vi.fn();
    vi.mocked(tauriClient.listenRepositoryChanges).mockImplementation(async (handler) => {
      repositoryChangeHandler = handler;
      return stopListening;
    });
  });

  it("keeps one native listener while repository array identity changes", async () => {
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    queryClient.setQueryData(queryKeys.workspaces.status(repo.workspaceId), []);
    observeRepositoryGenerations(repo.id, zeroGenerations(), "status");
    observeRepositoryGenerations(repo.id, zeroGenerations(), "operation");
    observeRepositoryGenerations(repo.id, zeroGenerations(), "history");
    observeRepositoryGenerations(repo.id, zeroGenerations(), "refs");

    const { rerender } = renderHook(
      ({ repositories }) => useRepositoryChangeEvents(repositories),
      {
        initialProps: { repositories: [repo] },
        wrapper: createWrapper(queryClient),
      },
    );

    await waitFor(() => {
      expect(tauriClient.listenRepositoryChanges).toHaveBeenCalledTimes(1);
    });

    repositoryChangeHandler?.({
      repoId: repo.id,
      status: true,
      working: false,
      history: true,
      refs: true,
      stashes: false,
      config: false,
      generations: { ...zeroGenerations(), refs: 1, history: 1 },
      statusSummary: {
        repoId: repo.id,
        status: {
          branch: "feature/change-events",
          ahead: 1,
          behind: 0,
          dirtyCount: 2,
          hasConflict: false,
        },
        lastSyncedAt: null,
      },
    });
    rerender({ repositories: [{ ...repo }] });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.repos.branches(repo.id),
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.repos.tags(repo.id),
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.repos.operationState(repo.id),
      });
    });
    expect(tauriClient.listenRepositoryChanges).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(queryKeys.repos.status(repo.id))).toEqual({
      branch: "feature/change-events",
      ahead: 1,
      behind: 0,
      dirtyCount: 2,
      hasConflict: false,
    });
  });

  it("does not refetch refs or history when only the working tree generation advances", async () => {
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    for (const scope of [
      "status",
      "operation",
      "working",
      "history",
      "refs",
      "stashes",
    ] as const) {
      observeRepositoryGenerations(repo.id, zeroGenerations(), scope);
    }

    renderHook(() => useRepositoryChangeEvents([repo]), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(repositoryChangeHandler).toBeDefined());

    repositoryChangeHandler?.({
      repoId: repo.id,
      status: true,
      working: true,
      history: false,
      refs: false,
      stashes: false,
      config: false,
      generations: { ...zeroGenerations(), workingTree: 1 },
      statusSummary: null,
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.repos.workingChanges(repo.id),
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.repos.operationState(repo.id),
      });
    });
    const invalidatedKeys = invalidateQueries.mock.calls.map(([filters]) => filters?.queryKey);
    expect(invalidatedKeys).not.toContainEqual(queryKeys.repos.branches(repo.id));
    expect(invalidatedKeys).not.toContainEqual(queryKeys.repos.tags(repo.id));
    expect(invalidatedKeys).not.toContainEqual(queryKeys.repos.commits(repo.id));
  });
});

function zeroGenerations() {
  return { workingTree: 0, refs: 0, history: 0, stash: 0, config: 0 };
}
