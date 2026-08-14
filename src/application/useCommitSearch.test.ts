import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/application/queryKeys";
import { useCommitSearch } from "@/application/useCommitSearch";
import { searchCommitLog } from "@/infrastructure/tauriClient";
import type { CommitSummary } from "@/domain/git";

const query = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  result: { data: undefined, isFetching: false, error: null } as {
    data: CommitSummary[] | undefined;
    isFetching: boolean;
    error: unknown;
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: Record<string, unknown>) => {
    query.options = options;
    return query.result;
  },
}));

vi.mock("@/infrastructure/tauriClient", () => ({
  searchCommitLog: vi.fn(),
}));

const commit: CommitSummary = {
  id: "abc1234",
  parentIds: [],
  message: "Cover commit search",
  authorName: "Test",
  authorEmail: "test@example.com",
  authoredAt: "2026-08-10T00:00:00Z",
  refs: [],
};

describe("useCommitSearch", () => {
  beforeEach(() => {
    query.options = null;
    query.result = { data: undefined, isFetching: false, error: null };
    vi.mocked(searchCommitLog).mockReset();
  });

  it.each([
    [null, "needle", queryKeys.repos.all],
    ["repo-1", "   ", queryKeys.repos.commitSearch("repo-1", "")],
  ])("disables searches without both a repository and query", (repoId, text, expectedKey) => {
    expect(useCommitSearch(repoId, text)).toEqual({ commits: [], loading: false, error: null });

    expect(query.options).toMatchObject({ enabled: false, queryKey: expectedKey });
  });

  it("trims the query and forwards the abort signal with the fixed search limit", async () => {
    vi.mocked(searchCommitLog).mockResolvedValue([commit]);
    useCommitSearch("repo-1", "  coverage gap  ");
    const controller = new AbortController();

    const value = await (query.options!.queryFn as (context: { signal: AbortSignal }) => Promise<CommitSummary[]>)({
      signal: controller.signal,
    });

    expect(query.options).toMatchObject({
      enabled: true,
      queryKey: queryKeys.repos.commitSearch("repo-1", "coverage gap"),
      staleTime: 30_000,
    });
    expect(searchCommitLog).toHaveBeenCalledWith("repo-1", "coverage gap", 120, controller.signal);
    expect(value).toEqual([commit]);
  });

  it("maps query data, fetching state, and errors to its public result", () => {
    query.result = { data: [commit], isFetching: true, error: new Error("search failed") };

    expect(useCommitSearch("repo-1", "test")).toEqual({
      commits: [commit],
      loading: true,
      error: "Error: search failed",
    });
  });
});
