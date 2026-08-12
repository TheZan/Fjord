import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDiffHighlight } from "@/presentation/useDiffHighlight";
import type { DiffHighlightWorkerResponse } from "@/presentation/diffHighlightWorkerProtocol";

class HighlightWorkerMock {
  static instances: HighlightWorkerMock[] = [];
  private messageListener: ((event: MessageEvent<DiffHighlightWorkerResponse>) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    HighlightWorkerMock.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === "message") this.messageListener = listener as (event: MessageEvent<DiffHighlightWorkerResponse>) => void;
  }

  removeEventListener() {}

  emit(response: DiffHighlightWorkerResponse) {
    this.messageListener?.({ data: response } as MessageEvent<DiffHighlightWorkerResponse>);
  }
}

describe("useDiffHighlight", () => {
  afterEach(() => {
    HighlightWorkerMock.instances = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("paints plain rows before starting the worker and upgrades in place", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", HighlightWorkerMock);
    let paintFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      paintFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const marks: string[] = [];
    vi.spyOn(performance, "mark").mockImplementation((name) => {
      marks.push(name);
      return {} as PerformanceMark;
    });
    vi.spyOn(performance, "clearMarks").mockImplementation(() => undefined);
    const { result } = renderHook(() => useDiffHighlight("file.ts", [{ key: "0:0", content: "const value = 1;" }]));

    expect(result.current.tokens.size).toBe(0);
    expect(HighlightWorkerMock.instances).toHaveLength(0);
    act(() => paintFrame?.(10));
    expect(marks).toEqual(["fjord:diff:plain-paint"]);
    await act(async () => vi.runAllTimers());
    expect(HighlightWorkerMock.instances).toHaveLength(1);

    act(() => HighlightWorkerMock.instances[0].emit({
      requestId: 1,
      durationMs: 2,
      skipped: null,
      lines: [{ key: "0:0", tokens: [{ start: 0, length: 5, kind: "keyword" }], wordChanges: [] }],
    }));

    expect(result.current.tokens.get("0:0")).toEqual([{ start: 0, length: 5, kind: "keyword" }]);
    expect(marks).toEqual(["fjord:diff:plain-paint", "fjord:diff:highlight-commit"]);
  });

  it("does not start a worker for an unknown language", () => {
    vi.stubGlobal("Worker", HighlightWorkerMock);
    renderHook(() => useDiffHighlight("file.unknown", [{ key: "0:0", content: "plain" }]));

    expect(HighlightWorkerMock.instances).toHaveLength(0);
  });
});
