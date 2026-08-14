import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { invalidateRepoData } from "@/application/invalidateRepoData";
import { queryKeys } from "@/application/queryKeys";

describe("invalidateRepoData", () => {
  it("refreshes working data without invalidating history or refs", async () => {
    const queryClient = fakeQueryClient();

    await invalidateRepoData(queryClient.client, "repo-1", "workspace-1", [
      "status",
      "operation",
      "working",
    ]);

    const invalidatedKeys = queryClient.invalidateQueries.mock.calls.map(([filters]) => filters.queryKey);
    expect(invalidatedKeys).toEqual([
      queryKeys.repos.status("repo-1"),
      queryKeys.workspaces.status("workspace-1"),
      queryKeys.repos.operationState("repo-1"),
      queryKeys.repos.workingChanges("repo-1"),
      queryKeys.repos.fileDiffs("repo-1"),
    ]);
    expect(invalidatedKeys).not.toContainEqual(queryKeys.repos.commits("repo-1"));
    expect(invalidatedKeys).not.toContainEqual(queryKeys.repos.branches("repo-1"));
  });

  it("cancels each affected query before refetching it", async () => {
    const queryClient = fakeQueryClient();

    await invalidateRepoData(queryClient.client, "repo-1", "workspace-1", ["refs", "operation"]);

    expect(queryClient.cancelQueries).toHaveBeenCalledTimes(3);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(3);
    expect(queryClient.cancelQueries).toHaveBeenCalledWith({ queryKey: queryKeys.repos.branches("repo-1") });
    expect(queryClient.cancelQueries).toHaveBeenCalledWith({ queryKey: queryKeys.repos.tags("repo-1") });
    expect(queryClient.cancelQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.repos.operationState("repo-1"),
    });
  });
});

function fakeQueryClient() {
  const cancelQueries = vi.fn().mockResolvedValue(undefined);
  const invalidateQueries = vi.fn().mockResolvedValue(undefined);
  return {
    client: { cancelQueries, invalidateQueries } as unknown as QueryClient,
    cancelQueries,
    invalidateQueries,
  };
}
