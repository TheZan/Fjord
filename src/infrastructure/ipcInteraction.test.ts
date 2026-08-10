import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginIpcRequest,
  setIpcInteraction,
  setIpcInteractionHooks,
  settleIpcRequest,
} from "@/infrastructure/ipcInteraction";

describe("IPC interaction context", () => {
  afterEach(() => {
    setIpcInteraction(null);
    setIpcInteractionHooks(null);
  });

  it("gives parallel calls of the same command distinct request ids", () => {
    const onSend = vi.fn();
    const onSettle = vi.fn();
    setIpcInteractionHooks({ onSend, onSettle });
    setIpcInteraction("session:1");

    const first = beginIpcRequest("get_branches", 10)!;
    const second = beginIpcRequest("get_branches", 11)!;
    settleIpcRequest(second, "get_branches", 20);
    settleIpcRequest(first, "get_branches", 25);

    expect(first.requestId).not.toBe(second.requestId);
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSettle.mock.calls.map((call) => call[1])).toEqual([
      second.requestId,
      first.requestId,
    ]);
  });

  it("does not allocate request metadata outside an interaction", () => {
    expect(beginIpcRequest("get_settings", 10)).toBeNull();
  });
});
