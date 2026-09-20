import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useInteractiveRebase } from "@/application/useInteractiveRebase";
import { getRebaseTodo } from "@/infrastructure/tauriClient";
import type { InteractiveRebaseTodo } from "@/domain/git";

vi.mock("@/infrastructure/tauriClient", () => ({ getRebaseTodo: vi.fn(), invokeErrorCode: vi.fn(() => "rebase_todo_invalid") }));

const onto = { kind: "localBranch" as const, refName: "refs/heads/develop" };
const todo: InteractiveRebaseTodo = {
  preflight: { onto, ontoCommit: "old", ontoLabel: "develop", currentBranch: "feature", currentCommit: "head", commits: 1,
    alreadyUpToDate: false, blockers: [], dirty: { staged: 0, modified: 0, untracked: 0, wouldOverwrite: [] }, publishedRewrite: null,
    generations: { workingTree: 0, refs: 0, history: 0, config: 0, stash: 0 } },
  steps: [{ commit: "aaa", shortId: "aaa", subject: "one", action: { kind: "pick" } }],
};

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

it("loads the seeded todo list", async () => {
  vi.mocked(getRebaseTodo).mockResolvedValue(todo);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result, unmount } = renderHook(() => useInteractiveRebase("repo", onto), { wrapper: wrapper(queryClient) });
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.todo).toEqual(todo));
  expect(result.current.error).toBeNull();
  unmount(); queryClient.clear();
});

it("surfaces a typed error code on failure without caching stale data", async () => {
  vi.mocked(getRebaseTodo).mockRejectedValue(new Error("boom"));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result, unmount } = renderHook(() => useInteractiveRebase("repo", onto), { wrapper: wrapper(queryClient) });
  await waitFor(() => expect(result.current.error).not.toBeNull());
  expect(result.current.errorCode).toBe("rebase_todo_invalid");
  expect(result.current.todo).toBeNull();
  unmount(); queryClient.clear();
});
