import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { getBranches, setRepositoryActivity } from "@/infrastructure/tauriClient";
import { beginInteraction, setInteractionDiagnosticsEnabled } from "@/presentation/performance";

describe("abortable Tauri queries", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    setInteractionDiagnosticsEnabled(false);
  });

  it("rejects an obsolete query when its signal is aborted", async () => {
    let resolveInvoke!: (value: unknown) => void;
    tauri.invoke.mockReturnValue(new Promise((resolve) => (resolveInvoke = resolve)));
    const controller = new AbortController();

    const result = getBranches("repo-1", controller.signal);
    controller.abort();
    resolveInvoke({ data: [], generations: zeroGenerations() });

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("carries the active interaction id on the IPC call", async () => {
    tauri.invoke.mockResolvedValue({ data: [], generations: zeroGenerations() });
    setInteractionDiagnosticsEnabled(true);
    const interactionId = beginInteraction(new Event("click"));

    await getBranches("repo-1");

    expect(tauri.invoke).toHaveBeenCalledWith("get_branches", {
      repoId: "repo-1",
      interactionId,
    });
  });

  it("sends repository activity as an explicit nullable navigation state", async () => {
    tauri.invoke.mockResolvedValue(undefined);

    await setRepositoryActivity("workspace-1", "repo-1");

    expect(tauri.invoke).toHaveBeenCalledWith("set_repository_activity", {
      workspaceId: "workspace-1",
      repoId: "repo-1",
    });
  });
});

function zeroGenerations() {
  return { workingTree: 0, refs: 0, history: 0, stash: 0, config: 0 };
}
