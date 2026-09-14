import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStashActions } from "@/application/useStashActions";
import type { StashEntry } from "@/domain/git";

const stash: StashEntry = {
  id: "stable-stash-id",
  index: 4,
  refName: "stash@{4}",
  message: "On develop: Same title",
  title: "Same title",
  base: "stable-base-id",
  branch: "develop",
  createdAt: "2026-08-28T00:00:00Z",
  filesChanged: 3,
  hasIndexState: true,
  hasUntracked: false,
};

describe("useStashActions", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  it("keeps Apply and copy actions outside destructive preflight", async () => {
    const callbacks = handlers();
    const { result } = renderHook(() => useStashActions(callbacks));

    await act(() => result.current.dispatch("apply", stash));
    expect(result.current.options).toEqual({ action: "apply", stash });
    await act(() => result.current.confirmOptions(true));
    expect(callbacks.onApply).toHaveBeenCalledWith(stash, true);
    expect(callbacks.onDestructive).not.toHaveBeenCalled();

    for (const [action, value] of [["copyRef", stash.refName], ["copySha", stash.id], ["copyBaseSha", stash.base]] as const) {
      await act(() => result.current.dispatch(action, stash));
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(value);
    }
    expect(callbacks.onDestructive).not.toHaveBeenCalled();
  });

  it("binds Pop and Drop preflight to the original stable identity and restore option", async () => {
    const callbacks = handlers();
    const { result } = renderHook(() => useStashActions(callbacks));

    await act(() => result.current.dispatch("pop", stash));
    await act(() => result.current.confirmOptions(true));
    expect(callbacks.onDestructive).toHaveBeenNthCalledWith(
      1,
      { kind: "stashPop", id: stash.id, restoreIndex: true },
      stash,
    );

    await act(() => result.current.dispatch("drop", { ...stash, index: 0, refName: "stash@{0}" }));
    expect(callbacks.onDestructive).toHaveBeenNthCalledWith(
      2,
      { kind: "stashDrop", id: stash.id },
      expect.objectContaining({ id: stash.id }),
    );
  });

  it("uses the branch dialog and never destructive preflight for branch creation", async () => {
    const callbacks = handlers();
    const { result } = renderHook(() => useStashActions(callbacks));
    await act(() => result.current.dispatch("createBranch", stash));
    expect(result.current.branch?.stash.base).toBe(stash.base);
    await act(() => result.current.confirmBranch("feature/stash-work", true));
    expect(callbacks.onCreateBranch).toHaveBeenCalledWith(stash, "feature/stash-work", true);
    expect(callbacks.onDestructive).not.toHaveBeenCalled();
  });
});

function handlers() {
  return {
    onApply: vi.fn(async () => undefined),
    onDestructive: vi.fn(),
    onCreateBranch: vi.fn(async () => undefined),
    onRevealInGraph: vi.fn(),
    onError: vi.fn(),
  };
}
