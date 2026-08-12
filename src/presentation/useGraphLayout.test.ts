import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeGraphLayout } from "@/presentation/graphLayout";
import { useGraphLayout } from "@/presentation/useGraphLayout";
import type { GraphLayoutWorkerResponse } from "@/presentation/graphLayoutWorkerProtocol";
import type { CommitSummary } from "@/domain/git";

function commit(id: string, parentIds: string[]): CommitSummary {
  return {
    id,
    parentIds,
    message: id,
    authorName: "Test",
    authorEmail: "test@example.com",
    authoredAt: "2026-08-10T00:00:00Z",
    refs: [],
  };
}

function linearHistory(count: number): CommitSummary[] {
  return Array.from({ length: count }, (_, index) =>
    commit(`c${index}`, index + 1 < count ? [`c${index + 1}`] : []));
}

class GraphWorkerMock {
  static instances: GraphWorkerMock[] = [];
  postMessage = vi.fn();
  terminate = vi.fn();
  private listener: ((event: MessageEvent<GraphLayoutWorkerResponse>) => void) | null = null;

  constructor() {
    GraphWorkerMock.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === "message") this.listener = listener as (event: MessageEvent<GraphLayoutWorkerResponse>) => void;
  }

  removeEventListener() {}

  emit(response: GraphLayoutWorkerResponse) {
    this.listener?.({ data: response } as MessageEvent<GraphLayoutWorkerResponse>);
  }
}

describe("useGraphLayout", () => {
  afterEach(() => {
    GraphWorkerMock.instances = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps showing the previous rows instead of collapsing to empty while crossing the worker threshold", () => {
    vi.stubGlobal("Worker", GraphWorkerMock);
    const initial = linearHistory(150);
    const { result, rerender } = renderHook(({ commits }) => useGraphLayout(commits), {
      initialProps: { commits: initial },
    });

    // Below WORKER_THRESHOLD: computed synchronously, no worker involved.
    expect(result.current.rows).toHaveLength(150);
    expect(result.current.computing).toBe(false);
    expect(GraphWorkerMock.instances).toHaveLength(0);

    // A page load (e.g. from fast scrolling near the bottom) pushes the
    // commit count over WORKER_THRESHOLD for the first time. The worker
    // hasn't replied yet, so there is no reusable worker result — this used
    // to fall back to an empty layout, collapsing the virtualized list's
    // height and snapping the native scrollbar back to the top mid-scroll.
    const extra = Array.from({ length: 50 }, (_, index) =>
      commit(`c${150 + index}`, index + 1 < 50 ? [`c${150 + index + 1}`] : []));
    const appended = [...initial, ...extra];
    rerender({ commits: appended });

    expect(result.current.rows).toHaveLength(150);
    expect(result.current.rows.map((row) => row.commit.id)).toEqual(initial.map((c) => c.id));
    expect(result.current.computing).toBe(true);
    expect(GraphWorkerMock.instances).toHaveLength(1);

    // Once the worker catches up, the full (now 200-row) layout replaces it.
    const fullLayout = computeGraphLayout(appended);
    act(() => {
      GraphWorkerMock.instances[0].emit({
        requestId: 1,
        commitCount: appended.length,
        layout: fullLayout,
        incremental: true,
        durationMs: 1,
      });
    });

    expect(result.current.rows).toHaveLength(200);
    expect(result.current.computing).toBe(false);
  });
});
