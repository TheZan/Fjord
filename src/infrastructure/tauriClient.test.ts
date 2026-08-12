import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  getBranches,
  getFileDiffPage,
  getWorkingFileDiffPage,
  revealLogFolder,
  setRepositoryActivity,
  stagePatch,
  unstagePatch,
} from "@/infrastructure/tauriClient";
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

  it("reveals the application-owned log folder without accepting a path", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    await revealLogFolder();
    expect(tauri.invoke).toHaveBeenCalledWith("reveal_log_folder", {});
  });

  it("sends the explicit large-file override for commit diff windows", async () => {
    tauri.invoke.mockResolvedValue({ data: {}, generations: zeroGenerations() });

    await getFileDiffPage("repo-1", "deadbeef", "large.txt", 0, 1_000, "show", true);

    expect(tauri.invoke).toHaveBeenCalledWith("get_file_diff", {
      repoId: "repo-1",
      commitId: "deadbeef",
      path: "large.txt",
      offset: 0,
      limit: 1_000,
      whitespace: "show",
      loadAnyway: true,
    });
  });

  it("sends the explicit large-file override for working diff windows", async () => {
    tauri.invoke.mockResolvedValue({ data: {}, generations: zeroGenerations() });

    await getWorkingFileDiffPage("repo-1", "large.txt", false, 0, 1_000, "show", true);

    expect(tauri.invoke).toHaveBeenCalledWith("get_working_file_diff", {
      repoId: "repo-1",
      path: "large.txt",
      staged: false,
      offset: 0,
      limit: 1_000,
      whitespace: "show",
      loadAnyway: true,
    });
  });

  it("sends a stage patch selection with its coherent generation stamp", async () => {
    const selection = {
      path: "src/main.rs",
      source: "worktree" as const,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }],
      baseDigest: "digest",
    };
    const expectedGenerations = zeroGenerations();
    const resultingGenerations = { ...expectedGenerations, workingTree: 1 };
    tauri.invoke.mockResolvedValue(resultingGenerations);

    await expect(stagePatch("repo-1", selection, expectedGenerations)).resolves.toEqual(
      resultingGenerations,
    );
    expect(tauri.invoke).toHaveBeenCalledWith("stage_patch", {
      repoId: "repo-1",
      selection,
      expectedGenerations,
    });
  });

  it("sends an index patch selection for partial unstaging", async () => {
    const selection = {
      path: "src/main.rs",
      source: "index" as const,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }],
      baseDigest: "digest",
    };
    const expectedGenerations = zeroGenerations();
    const resultingGenerations = { ...expectedGenerations, workingTree: 1 };
    tauri.invoke.mockResolvedValue(resultingGenerations);

    await expect(unstagePatch("repo-1", selection, expectedGenerations)).resolves.toEqual(
      resultingGenerations,
    );
    expect(tauri.invoke).toHaveBeenCalledWith("unstage_patch", {
      repoId: "repo-1",
      selection,
      expectedGenerations,
    });
  });
});

function zeroGenerations() {
  return { workingTree: 0, refs: 0, history: 0, stash: 0, config: 0 };
}
