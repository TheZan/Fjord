import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useRebaseBranch } from "@/application/useRebaseBranch";
import { useRepositoryChangeEvents } from "@/application/useRepositoryChangeEvents";
import { forgetRepositoryGenerations, observeRepositoryGenerations } from "@/infrastructure/repositoryGenerations";
import { getRebasePreflight, listenRepositoryChanges, type RepositoryChangedEvent } from "@/infrastructure/tauriClient";
import type { RebasePreflight } from "@/domain/git";
vi.mock("@/infrastructure/tauriClient", () => ({ getRebasePreflight: vi.fn(), invokeErrorCode: vi.fn(), listenRepositoryChanges: vi.fn() }));
const onto = { kind: "localBranch" as const, refName: "refs/heads/develop" };
const facts: RebasePreflight = { onto, ontoCommit: "old", ontoLabel: "develop", currentBranch: "feature", currentCommit: "head", commits: 1,
  alreadyUpToDate: false, blockers: [], dirty: { staged: 0, modified: 0, untracked: 0, wouldOverwrite: [] }, publishedRewrite: null,
  generations: { workingTree: 0, refs: 0, history: 0, config: 0, stash: 0 } };
it("refreshes the open preflight from the existing repository-generation event path", async () => {
  forgetRepositoryGenerations();
  let listener: (event: RepositoryChangedEvent) => void = () => {};
  vi.mocked(listenRepositoryChanges).mockImplementation(async (handler) => { listener = handler; return () => {}; });
  vi.mocked(getRebasePreflight).mockResolvedValue(facts);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => {
    useRepositoryChangeEvents([{ id: "repo", name: "fixture", path: "/fixture", workspaceId: "ws", sortOrder: 0 }]);
    return useRebaseBranch("repo", onto);
  }, { wrapper });
  await waitFor(() => expect(result.current.preflight).toEqual(facts));
  observeRepositoryGenerations("repo", facts.generations, "rebase");
  const updated = { ...facts, ontoCommit: "new", generations: { ...facts.generations, refs: 1 }, publishedRewrite: { upstream: "origin/feature", commits: 2 } };
  vi.mocked(getRebasePreflight).mockResolvedValue(updated);
  act(() => listener({ repoId: "repo", status: false, working: false, history: false, refs: true, config: false, stashes: false,
    generations: updated.generations, statusSummary: null }));
  await waitFor(() => expect(result.current.preflight).toEqual(updated));
  unmount(); queryClient.clear();
});
