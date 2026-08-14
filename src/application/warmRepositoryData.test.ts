import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/application/queryKeys";
import {
  REPOSITORY_LOG_PAGE_SIZE,
  REPOSITORY_QUERY_GC_TIME,
  REPOSITORY_QUERY_STALE_TIME,
} from "@/application/repositoryQueryPolicy";
import { warmRepositoryData } from "@/application/warmRepositoryData";
import * as tauriClient from "@/infrastructure/tauriClient";
import type { CommitPage } from "@/domain/git";

vi.mock("@/infrastructure/tauriClient", () => ({
  getBranches: vi.fn(),
  getCommitLog: vi.fn(),
  getRepoStatus: vi.fn(),
  getTags: vi.fn(),
  getWorkingChanges: vi.fn(),
}));

describe("warmRepositoryData", () => {
  it("prefetches exactly the first-frame repository queries with the shared policy", async () => {
    const queries: Array<Record<string, unknown>> = [];
    const infiniteQueries: Array<Record<string, unknown>> = [];
    const queryClient = {
      prefetchQuery: vi.fn((options: Record<string, unknown>) => {
        queries.push(options);
        return Promise.resolve();
      }),
      prefetchInfiniteQuery: vi.fn((options: Record<string, unknown>) => {
        infiniteQueries.push(options);
        return Promise.resolve();
      }),
    };

    await warmRepositoryData(queryClient as never, "repo-1");

    expect(queries.map(({ queryKey }) => queryKey)).toEqual([
      queryKeys.repos.status("repo-1"),
      queryKeys.repos.branches("repo-1"),
      queryKeys.repos.tags("repo-1"),
      queryKeys.repos.workingChanges("repo-1"),
    ]);
    expect(infiniteQueries).toHaveLength(1);
    expect(infiniteQueries[0]).toMatchObject({
      queryKey: queryKeys.repos.commits("repo-1"),
      initialPageParam: null,
      staleTime: REPOSITORY_QUERY_STALE_TIME,
      gcTime: REPOSITORY_QUERY_GC_TIME,
    });
    for (const options of [...queries, ...infiniteQueries]) {
      expect(options).toMatchObject({
        staleTime: REPOSITORY_QUERY_STALE_TIME,
        gcTime: REPOSITORY_QUERY_GC_TIME,
      });
    }
  });

  it("forwards signals to every read and configures commit pagination", async () => {
    const queries: Array<Record<string, unknown>> = [];
    let history: Record<string, unknown> | undefined;
    const queryClient = {
      prefetchQuery: vi.fn((options: Record<string, unknown>) => {
        queries.push(options);
        return Promise.resolve();
      }),
      prefetchInfiniteQuery: vi.fn((options: Record<string, unknown>) => {
        history = options;
        return Promise.resolve();
      }),
    };
    await warmRepositoryData(queryClient as never, "repo-2");
    const controller = new AbortController();

    await Promise.all(
      queries.map((options) =>
        (options.queryFn as (context: { signal: AbortSignal }) => Promise<unknown>)({
          signal: controller.signal,
        }),
      ),
    );
    await (history!.queryFn as (context: { pageParam: string | null; signal: AbortSignal }) => Promise<unknown>)({
      pageParam: "cursor-1",
      signal: controller.signal,
    });

    expect(tauriClient.getRepoStatus).toHaveBeenCalledWith("repo-2", controller.signal);
    expect(tauriClient.getBranches).toHaveBeenCalledWith("repo-2", controller.signal);
    expect(tauriClient.getTags).toHaveBeenCalledWith("repo-2", controller.signal);
    expect(tauriClient.getWorkingChanges).toHaveBeenCalledWith("repo-2", controller.signal);
    expect(tauriClient.getCommitLog).toHaveBeenCalledWith(
      "repo-2",
      "cursor-1",
      REPOSITORY_LOG_PAGE_SIZE,
      controller.signal,
    );
    expect((history!.getNextPageParam as (page: CommitPage) => string | null)({
      commits: [],
      nextCursor: "cursor-2",
    })).toBe("cursor-2");
  });
});
