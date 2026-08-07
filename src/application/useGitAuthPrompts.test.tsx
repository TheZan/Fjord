import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitAuthPrompt } from "@/domain/generated";
import { useGitAuthPrompts } from "@/application/useGitAuthPrompts";

let authHandler: ((prompt: GitAuthPrompt) => void) | undefined;
let operationHandler: ((event: { operationId: string; status: string }) => void) | undefined;
const answerGitAuthPrompt = vi.fn().mockResolvedValue(true);
const cancelGitAuthPrompt = vi.fn().mockResolvedValue(true);

vi.mock("@/infrastructure/tauriClient", () => ({
  answerGitAuthPrompt: (...args: unknown[]) => answerGitAuthPrompt(...args),
  cancelGitAuthPrompt: (...args: unknown[]) => cancelGitAuthPrompt(...args),
  listenGitAuthPrompts: vi.fn((handler) => {
    authHandler = handler;
    return Promise.resolve(vi.fn());
  }),
  listenOperationProgress: vi.fn((handler) => {
    operationHandler = handler;
    return Promise.resolve(vi.fn());
  }),
}));

const prompt = (operationId: string, promptId: string): GitAuthPrompt => ({
  operationId,
  promptId,
  prompt: "Password:",
  kind: "secret",
  repositoryName: null,
  operationKind: "fetch",
});

describe("useGitAuthPrompts", () => {
  beforeEach(() => {
    authHandler = undefined;
    operationHandler = undefined;
    answerGitAuthPrompt.mockClear();
    cancelGitAuthPrompt.mockClear();
  });

  it("queues prompts, advances after an answer, and closes them with the operation", async () => {
    const { result } = renderHook(() => useGitAuthPrompts());
    await waitFor(() => expect(authHandler).toBeDefined());
    act(() => {
      authHandler?.(prompt("op-1", "prompt-1"));
      authHandler?.(prompt("op-2", "prompt-2"));
    });

    expect(result.current.activePrompt?.promptId).toBe("prompt-1");
    expect(result.current.queuedCount).toBe(1);
    await act(() => result.current.answerPrompt(result.current.activePrompt!, "secret"));
    expect(answerGitAuthPrompt).toHaveBeenCalledWith("op-1", "prompt-1", "secret");
    expect(result.current.activePrompt?.promptId).toBe("prompt-2");

    act(() => operationHandler?.({ operationId: "op-2", status: "cancelled" }));
    expect(result.current.activePrompt).toBeNull();
  });
});
