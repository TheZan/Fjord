import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DiffHighlightWorkerRequest,
  DiffHighlightWorkerResponse,
} from "@/presentation/diffHighlightWorkerProtocol";

describe("diff highlight worker transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns tokens with the request id and worker duration", async () => {
    const responses: DiffHighlightWorkerResponse[] = [];
    const scope = {
      onmessage: null,
      postMessage: (message: DiffHighlightWorkerResponse) => responses.push(message),
    } as {
      onmessage: ((event: MessageEvent<DiffHighlightWorkerRequest>) => void) | null;
      postMessage: (message: DiffHighlightWorkerResponse) => void;
    };
    vi.stubGlobal("self", scope);
    vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(13);
    await import("@/presentation/diffHighlight.worker");

    scope.onmessage!({
      data: {
        requestId: 7,
        language: "rust",
        lines: [{ key: "0:1", content: "let value = 42;" }],
      },
    } as MessageEvent<DiffHighlightWorkerRequest>);

    expect(responses).toEqual([{
      requestId: 7,
      durationMs: 3,
      skipped: null,
      lines: [{
        key: "0:1",
        tokens: [
          { start: 0, length: 3, kind: "keyword" },
          { start: 12, length: 2, kind: "number" },
        ],
      }],
    }]);
  });
});
