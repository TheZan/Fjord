import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeDiffWindows,
  useFileDiff,
  validateAndMergeDiffWindows,
  type DiffWindowPage,
} from "@/application/useFileDiff";
import type { FileDiffWindow, GenerationSet } from "@/domain/git";
import * as tauriClient from "@/infrastructure/tauriClient";
import { queryKeys } from "@/application/queryKeys";
import { rejectWorkingDiffSnapshot } from "@/application/diffSnapshotAuthority";

vi.mock("@/infrastructure/tauriClient", () => ({
  getFileDiffPage: vi.fn(),
  getStashFileDiffPage: vi.fn(),
  getWorkingFileDiffPage: vi.fn(),
  observeDiffPage: vi.fn(),
}));

const generationsA: GenerationSet = {
  workingTree: 1,
  refs: 2,
  history: 3,
  stash: 4,
  config: 5,
};

function window(
  offset: number,
  contents: string[],
  nextOffset: number | null,
  overrides: Partial<FileDiffWindow> = {},
): FileDiffWindow {
  return {
    path: "large.txt",
    changeType: "modified",
    oldMode: 0o100644,
    newMode: 0o100644,
    isBinary: false,
    tooLarge: false,
    fileBytes: 100,
    hunks: [
      {
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 4,
        lines: contents.map((content, index) => ({
          kind: index === 0 ? "deletion" : "addition",
          oldLineno: offset + index + 1,
          newLineno: offset + index + 1,
          content,
          lineEnding: "lf",
        })),
      },
    ],
    totalHunks: 1,
    totalLines: 4,
    offset,
    truncated: nextOffset !== null,
    nextOffset,
    baseDigest: "digest-a",
    ...overrides,
  };
}

function page(
  offset: number,
  contents: string[],
  nextOffset: number | null,
  overrides: {
    data?: Partial<FileDiffWindow>;
    generations?: GenerationSet;
    repoId?: string;
    requestedPath?: string;
    sourceKey?: string;
  } = {},
): DiffWindowPage {
  return {
    data: window(offset, contents, nextOffset, overrides.data),
    generations: overrides.generations === undefined ? generationsA : overrides.generations,
    requestedOffset: offset,
    repoId: overrides.repoId ?? "repo-1",
    requestedPath: overrides.requestedPath ?? "large.txt",
    sourceKey: overrides.sourceKey ?? "working:false",
    fetchSequence: 1,
  };
}

function expectRejected(pages: DiffWindowPage[]) {
  expect(validateAndMergeDiffWindows(pages).status).toBe("invalid");
  expect(mergeDiffWindows(pages)).toBeNull();
}

describe("diff window merging", () => {
  it("joins same-snapshot pages without duplicating a split hunk header", () => {
    const merged = mergeDiffWindows([
      page(0, ["a", "b"], 2),
      page(2, ["c", "d"], null),
    ]);

    expect(merged?.hunks).toHaveLength(1);
    expect(merged?.hunks[0].lines.map((line) => line.content)).toEqual(["a", "b", "c", "d"]);
    expect(merged?.truncated).toBe(false);
    expect(merged?.nextOffset).toBeNull();
  });

  it.each([
    ["digest", { data: { baseDigest: "digest-b" } }],
    ["path", { data: { path: "other.txt" } }],
    ["requested path", { requestedPath: "other.txt" }],
    ["repository", { repoId: "repo-2" }],
    ["source", { sourceKey: "working:true" }],
    ["change type", { data: { changeType: "added" as const } }],
    ["old mode", { data: { oldMode: 0o100755 } }],
    ["new mode", { data: { newMode: 0o100755 } }],
    ["binary state", { data: { isBinary: true } }],
    ["large-file state", { data: { tooLarge: true } }],
    ["file byte total", { data: { fileBytes: 101 } }],
    ["hunk total", { data: { totalHunks: 2 } }],
    ["line total", { data: { totalLines: 5 } }],
  ])("rejects a %s mismatch", (_name, override) => {
    expectRejected([
      page(0, ["a", "b"], 2),
      page(2, ["c", "d"], null, override),
    ]);
  });

  it("rejects any complete GenerationSet mismatch", () => {
    for (const field of Object.keys(generationsA) as (keyof GenerationSet)[]) {
      expectRejected([
        page(0, ["a", "b"], 2),
        page(2, ["c", "d"], null, {
          generations: { ...generationsA, [field]: generationsA[field] + 1 },
        }),
      ]);
    }
  });

  it.each([
    ["skip", [page(0, ["a", "b"], 2), page(3, ["d"], null)]],
    ["out of order", [page(2, ["c", "d"], null), page(0, ["a", "b"], 2)]],
    ["duplicate", [page(0, ["a", "b"], 2), page(0, ["a", "b"], 2)]],
    ["repeated response", [page(0, ["a", "b"], 2), page(2, ["a", "b"], null, { data: { offset: 0 } })]],
    ["broken next offset", [page(0, ["a", "b"], 3)]],
    ["false completeness", [page(0, ["a", "b"], null)]],
    ["page after completeness", [page(0, ["a", "b", "c", "d"], null), page(4, [], null)]],
  ])("rejects cursor continuity failure: %s", (_name, pages) => {
    expectRejected(pages);
  });
});

describe("useFileDiff mixed-snapshot recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the same stash path in different groups under distinct queries", async () => {
    vi.mocked(tauriClient.getStashFileDiffPage).mockImplementation(
      async (_repoId, _stashId, group) => ({
        data: window(0, [group, "two", "three", "four"], null),
        generations: generationsA,
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const index = renderHook(
      () => useFileDiff("repo-1", "large.txt", { kind: "stash", stashId: "stash-oid", group: "index" }),
      { wrapper },
    );
    const worktree = renderHook(
      () => useFileDiff("repo-1", "large.txt", { kind: "stash", stashId: "stash-oid", group: "worktree" }),
      { wrapper },
    );

    await waitFor(() => expect(index.result.current.diff?.hunks[0].lines[0].content).toBe("index"));
    await waitFor(() => expect(worktree.result.current.diff?.hunks[0].lines[0].content).toBe("worktree"));
    expect(tauriClient.getStashFileDiffPage).toHaveBeenCalledWith(
      "repo-1", "stash-oid", "index", "large.txt", 0, 1_000, "show", false, expect.any(AbortSignal),
    );
    expect(tauriClient.getStashFileDiffPage).toHaveBeenCalledWith(
      "repo-1", "stash-oid", "worktree", "large.txt", 0, 1_000, "show", false, expect.any(AbortSignal),
    );
    expect(tauriClient.observeDiffPage).toHaveBeenCalledWith(
      "repo-1",
      expect.any(Object),
      "stashes",
    );
  });

  it("discards A+B, clears its actionable identity, and refetches from zero after A→B→A", async () => {
    const calls: number[] = [];
    let firstSnapshot = true;
    vi.mocked(tauriClient.getWorkingFileDiffPage).mockImplementation(
      async (_repoId, _path, _staged, offset) => {
        calls.push(offset);
        if (offset === 0) {
          if (firstSnapshot) return { data: window(0, ["A1", "A2"], 2), generations: generationsA };
          return { data: window(0, ["A1", "A2", "A3", "A4"], null), generations: generationsA };
        }
        firstSnapshot = false;
        // B is returned without a generation bump; the next offset-zero request observes A again.
        return {
          data: window(2, ["B3", "B4"], null, { baseDigest: "digest-b" }),
          generations: generationsA,
        };
      },
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useFileDiff("repo-1", "large.txt", { kind: "working", staged: false }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.diff?.hunks[0].lines.map((line) => line.content)).toEqual(["A1", "A2"]));
    act(() => result.current.loadMore());

    await waitFor(() => expect(calls).toEqual([0, 2, 0]));
    await waitFor(() => expect(result.current.diff?.hunks[0].lines.map((line) => line.content)).toEqual(["A1", "A2", "A3", "A4"]));
    expect(result.current.diff?.hunks[0].lines.some((line) => line.content.startsWith("B"))).toBe(false);
    expect(result.current.generations).toEqual(generationsA);
    expect(result.current.hasMore).toBe(false);
  });

  it("keeps a rejected cached diff invalid until a post-rejection fetch succeeds", async () => {
    let attempt = 0;
    vi.mocked(tauriClient.getWorkingFileDiffPage).mockImplementation(async () => {
      attempt += 1;
      if (attempt === 2) throw new Error("refresh failed");
      return {
        data: window(0, attempt === 1 ? ["old-1", "old-2", "old-3", "old-4"] : ["new-1", "new-2", "new-3", "new-4"], null, {
          baseDigest: attempt === 1 ? "digest-old" : "digest-new",
        }),
        generations: generationsA,
      };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useFileDiff("repo-1", "large.txt", { kind: "working", staged: false }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.diff?.baseDigest).toBe("digest-old"));
    expect(result.current.snapshotInvalid).toBe(false);

    act(() => rejectWorkingDiffSnapshot(queryClient, "repo-1", "large.txt", "worktree"));
    await waitFor(() => expect(result.current.snapshotInvalid).toBe(true));

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.repos.fileDiffs("repo-1") });
    });
    expect(result.current.diff?.baseDigest).toBe("digest-old");
    expect(result.current.snapshotInvalid).toBe(true);

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.repos.fileDiffs("repo-1") });
    });
    await waitFor(() => expect(result.current.diff?.baseDigest).toBe("digest-new"));
    await waitFor(() => expect(result.current.snapshotInvalid).toBe(false));
  });

  it("survives failed refreshes and remount cache replay, then accepts only fresh snapshot B", async () => {
    const requests = [
      deferred<tauriClient.VersionedFileDiffWindow>(),
      deferred<tauriClient.VersionedFileDiffWindow>(),
      deferred<tauriClient.VersionedFileDiffWindow>(),
      deferred<tauriClient.VersionedFileDiffWindow>(),
    ];
    let attempt = 0;
    vi.mocked(tauriClient.getWorkingFileDiffPage).mockImplementation(
      () => requests[attempt++].promise,
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const queryKey = queryKeys.repos.fileDiff("repo-1", "large.txt", "working:false");

    const first = renderHook(
      () => useFileDiff("repo-1", "large.txt", { kind: "working", staged: false }),
      { wrapper },
    );
    await waitFor(() => expect(attempt).toBe(1));
    await act(async () => requests[0].resolve(diffResponse("digest-a", 1)));
    await waitFor(() => expect(first.result.current.diff?.baseDigest).toBe("digest-a"));

    act(() => rejectWorkingDiffSnapshot(queryClient, "repo-1", "large.txt", "worktree"));
    await waitFor(() => expect(first.result.current.snapshotInvalid).toBe(true));
    const failedRefresh = queryClient.invalidateQueries({ queryKey, exact: true });
    await waitFor(() => expect(attempt).toBe(2));
    await act(async () => {
      requests[1].reject(new Error("refresh failed"));
      await failedRefresh;
    });
    expect(first.result.current.diff?.baseDigest).toBe("digest-a");
    expect(first.result.current.snapshotInvalid).toBe(true);
    expect(queryClient.getQueryState(queryKey)?.dataUpdatedAt).toBeGreaterThan(0);

    first.unmount();
    const reopened = renderHook(
      () => useFileDiff("repo-1", "large.txt", { kind: "working", staged: false }),
      { wrapper },
    );
    expect(reopened.result.current.diff?.baseDigest).toBe("digest-a");
    expect(reopened.result.current.snapshotInvalid).toBe(true);
    await waitFor(() => expect(attempt).toBe(3));
    await act(async () => requests[2].reject(new Error("automatic retry failed")));
    expect(reopened.result.current.snapshotInvalid).toBe(true);

    const successfulRetry = queryClient.refetchQueries({ queryKey, exact: true });
    await waitFor(() => expect(attempt).toBe(4));
    await act(async () => {
      requests[3].resolve(diffResponse("digest-b", 2));
      await successfulRetry;
    });
    await waitFor(() => expect(reopened.result.current.diff?.baseDigest).toBe("digest-b"));
    await waitFor(() => expect(reopened.result.current.snapshotInvalid).toBe(false));
    expect(reopened.result.current.generations?.workingTree).toBe(2);
  });

  it("does not let a successful fetch for another file release a rejected snapshot", async () => {
    vi.mocked(tauriClient.getWorkingFileDiffPage).mockImplementation(async (_repoId, path) => (
      diffResponse(path === "other.txt" ? "digest-other" : "digest-a", 1, path)
    ));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const fileA = renderHook(
      () => useFileDiff("repo-1", "large.txt", { kind: "working", staged: false }),
      { wrapper },
    );
    await waitFor(() => expect(fileA.result.current.diff?.baseDigest).toBe("digest-a"));
    act(() => rejectWorkingDiffSnapshot(queryClient, "repo-1", "large.txt", "worktree"));
    await waitFor(() => expect(fileA.result.current.snapshotInvalid).toBe(true));

    const fileB = renderHook(
      () => useFileDiff("repo-1", "other.txt", { kind: "working", staged: false }),
      { wrapper },
    );
    await waitFor(() => expect(fileB.result.current.diff?.baseDigest).toBe("digest-other"));
    const otherSource = renderHook(
      () => useFileDiff("repo-1", "large.txt", { kind: "working", staged: true }),
      { wrapper },
    );
    await waitFor(() => expect(otherSource.result.current.diff?.baseDigest).toBe("digest-a"));
    expect(fileB.result.current.snapshotInvalid).toBe(false);
    expect(otherSource.result.current.snapshotInvalid).toBe(false);
    expect(fileA.result.current.snapshotInvalid).toBe(true);
  });

  it("keeps an unrejected cached diff actionable on remount", async () => {
    const remountFetch = deferred<tauriClient.VersionedFileDiffWindow>();
    let attempt = 0;
    vi.mocked(tauriClient.getWorkingFileDiffPage).mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) return diffResponse("digest-a", 1);
      return remountFetch.promise;
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const first = renderHook(
      () => useFileDiff("repo-1", "large.txt", { kind: "working", staged: false }),
      { wrapper },
    );
    await waitFor(() => expect(first.result.current.diff?.baseDigest).toBe("digest-a"));
    first.unmount();

    const reopened = renderHook(
      () => useFileDiff("repo-1", "large.txt", { kind: "working", staged: false }),
      { wrapper },
    );
    expect(reopened.result.current.diff?.baseDigest).toBe("digest-a");
    expect(reopened.result.current.snapshotInvalid).toBe(false);
    remountFetch.resolve(diffResponse("digest-a", 1));
  });
});

function diffResponse(
  baseDigest: string,
  workingTree: number,
  path = "large.txt",
): tauriClient.VersionedFileDiffWindow {
  return {
    data: window(0, ["one", "two", "three", "four"], null, { baseDigest, path }),
    generations: { ...generationsA, workingTree },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
