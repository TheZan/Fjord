import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "@/domain/git";
import type {
  GraphLayoutWorkerRequest,
  GraphLayoutWorkerResponse,
} from "@/presentation/graphLayoutWorkerProtocol";

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

describe("graphLayout worker transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("installs a handler and carries reset state into an incremental append response", async () => {
    const responses: GraphLayoutWorkerResponse[] = [];
    const scope: {
      onmessage: ((event: MessageEvent<GraphLayoutWorkerRequest>) => void) | null;
      postMessage: (message: GraphLayoutWorkerResponse) => void;
    } = {
      onmessage: null,
      postMessage: (message) => responses.push(message),
    };
    vi.stubGlobal("self", scope);
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(14)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(27);
    await import("@/presentation/graphLayout.worker");

    expect(scope.onmessage).toEqual(expect.any(Function));
    scope.onmessage!({
      data: { requestId: 41, mode: "reset", commits: [commit("tip", ["root"])] },
    } as unknown as MessageEvent<GraphLayoutWorkerRequest>);
    scope.onmessage!({
      data: { requestId: 42, mode: "append", commits: [commit("root", [])] },
    } as unknown as MessageEvent<GraphLayoutWorkerRequest>);

    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({
      requestId: 41,
      commitCount: 1,
      incremental: false,
      durationMs: 4,
      layout: { laneCount: 1 },
    });
    expect(responses[0].layout.rows.map((row) => row.commit.id)).toEqual(["tip"]);
    expect(responses[1]).toMatchObject({
      requestId: 42,
      commitCount: 2,
      incremental: true,
      durationMs: 7,
      layout: { laneCount: 1 },
    });
    expect(responses[1].layout.rows.map((row) => row.commit.id)).toEqual(["tip", "root"]);
  });

  it("a later reset replaces the cached commit count and layout", async () => {
    const postMessage = vi.fn();
    const scope = { onmessage: null, postMessage } as {
      onmessage: ((event: MessageEvent<GraphLayoutWorkerRequest>) => void) | null;
      postMessage: (message: GraphLayoutWorkerResponse) => void;
    };
    vi.stubGlobal("self", scope);
    await import("@/presentation/graphLayout.worker");

    scope.onmessage!({
      data: { requestId: 1, mode: "reset", commits: [commit("a", ["b"]), commit("b", [])] },
    } as unknown as MessageEvent<GraphLayoutWorkerRequest>);
    scope.onmessage!({
      data: { requestId: 2, mode: "reset", commits: [] },
    } as unknown as MessageEvent<GraphLayoutWorkerRequest>);

    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      requestId: 2,
      commitCount: 0,
      incremental: false,
      layout: { rows: [], laneCount: 0 },
    }));
  });
});
