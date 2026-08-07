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
    expect(
      repositoryChangeScopes({
        repoId: "repo-1",
        status: true,
        working: false,
        history: true,
        refs: true,
        stashes: false,
        statusSummary: null,
      }),
    ).toEqual(["status", "history", "refs"]);
  });
});

describe("useRepositoryChangeEvents", () => {
  beforeEach(() => {
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
});
