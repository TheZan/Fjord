import { afterEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { getBranches } from "@/infrastructure/tauriClient";
import {
  beginInteraction,
  completeInteractionWhen,
  currentInteraction,
  drainFrontendInteractionTraces,
  installInteractionCapture,
  recordInteractionCommit,
  setInteractionDiagnosticsEnabled,
  sevenPhaseCoverageError,
} from "@/presentation/performance";

describe("interaction ids", () => {
  afterEach(() => {
    setInteractionDiagnosticsEnabled(false);
    tauri.invoke.mockReset();
    vi.restoreAllMocks();
  });

  it("mints unique session ids and keeps the latest interaction active until paint", () => {
    setInteractionDiagnosticsEnabled(true);
    const first = beginInteraction(new Event("click"));
    const second = beginInteraction(new Event("keydown"));

    expect(first).toMatch(/^[a-zA-Z0-9]+:\d+$/);
    expect(second).toMatch(/^[a-zA-Z0-9]+:\d+$/);
    expect(second).not.toBe(first);
    expect(currentInteraction()).toBe(second);
  });

  it("captures document input before the target handler runs", () => {
    setInteractionDiagnosticsEnabled(true);
    const uninstall = installInteractionCapture();
    let seenInHandler: string | null = null;
    const button = document.createElement("button");
    button.addEventListener("click", () => {
      seenInHandler = currentInteraction();
    });
    document.body.append(button);

    button.click();

    expect(seenInHandler).toMatch(/^[a-zA-Z0-9]+:\d+$/);
    uninstall();
    button.remove();
  });

  it("does no work while diagnostics are disabled", () => {
    setInteractionDiagnosticsEnabled(false);
    expect(beginInteraction(new Event("click"))).toBeNull();
    expect(currentInteraction()).toBeNull();
  });

  it("closes on the first paint that satisfies the interaction predicate", async () => {
    let resolveInvoke!: (value: unknown[]) => void;
    tauri.invoke.mockReturnValue(new Promise((resolve) => (resolveInvoke = resolve)));
    let paint: FrameRequestCallback = () => undefined;
    let paintScheduled = false;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      paint = callback;
      paintScheduled = true;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    setInteractionDiagnosticsEnabled(true);
    let ready = false;
    const interactionId = beginInteraction(new Event("click"));
    completeInteractionWhen(() => ready, "query_data_visible");
    const request = getBranches("repo-1");
    resolveInvoke([]);
    await request;
    await new Promise((resolve) => setTimeout(resolve, 0));

    recordInteractionCommit(performance.now());
    expect(paintScheduled).toBe(false);
    ready = true;
    recordInteractionCommit(performance.now());
    expect(paintScheduled).toBe(true);
    paint(performance.now() + 16);

    for (const phase of [
      "input_to_dispatch",
      "dispatch_to_ipc_send",
      "ipc_round_trip",
      "ipc_return_to_react_commit",
      "react_commit_to_paint",
    ]) {
      expect(
        performance.getEntriesByName(`fjord:interaction:${interactionId}:${phase}`, "measure"),
      ).toHaveLength(1);
    }

    const traces = drainFrontendInteractionTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      interactionId,
      completionPredicate: "query_data_visible",
      phases: {
        input_to_dispatch: expect.any(Number),
        dispatch_to_ipc_send: expect.any(Number),
        ipc_round_trip: expect.any(Number),
        ipc_return_to_react_commit: expect.any(Number),
        react_commit_to_paint: expect.any(Number),
      },
      ipcCalls: [{ command: "get_branches", roundTripMs: expect.any(Number) }],
    });
    const frontend = traces[0].phases;
    const roundTrip = frontend.ipc_round_trip!;
    const coverageError = sevenPhaseCoverageError(
      {
        inputToDispatch: frontend.input_to_dispatch!,
        dispatchToIpcSend: frontend.dispatch_to_ipc_send!,
        // Backend durations use only the Rust clock. The two transport legs
        // supplied by an end-to-end driver must add with handler time to the
        // frontend's independently measured round trip.
        ipcSendToHandlerEntry: roundTrip * 0.2,
        handler: roundTrip * 0.6,
        handlerExitToIpcReturn: roundTrip * 0.2,
        ipcReturnToReactCommit: frontend.ipc_return_to_react_commit!,
        reactCommitToPaint: frontend.react_commit_to_paint!,
      },
      traces[0].wallDurationMs,
    );
    expect(coverageError).toBeLessThanOrEqual(0.05);
    expect(currentInteraction()).toBeNull();
  });
});
