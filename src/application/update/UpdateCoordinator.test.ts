import { beforeEach, describe, expect, it, vi } from "vitest";

const infra = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  relaunchApp: vi.fn(),
}));

vi.mock("@/infrastructure/updater", () => infra);

import { UpdateCoordinator } from "@/application/update/UpdateCoordinator";
import type { Update } from "@/infrastructure/updater";

function fakeUpdate(overrides: Partial<{ version: string; currentVersion: string; body: string | null }> = {}) {
  return {
    version: overrides.version ?? "0.2.0",
    currentVersion: overrides.currentVersion ?? "0.1.0",
    body: overrides.body ?? null,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Update;
}

beforeEach(() => {
  infra.checkForUpdate.mockReset();
  infra.downloadAndInstallUpdate.mockReset();
  infra.relaunchApp.mockReset();
});

describe("UpdateCoordinator", () => {
  it("reports up-to-date when no update is available", async () => {
    infra.checkForUpdate.mockResolvedValue(null);
    const coordinator = new UpdateCoordinator();

    await coordinator.checkManually();

    expect(coordinator.getSnapshot().phase).toBe("up-to-date");
  });

  it("fails a startup check silently, back to idle with no visible error", async () => {
    infra.checkForUpdate.mockRejectedValue(new Error("network down"));
    const coordinator = new UpdateCoordinator();

    await coordinator.checkOnStartup();

    expect(coordinator.getSnapshot()).toMatchObject({ phase: "idle", error: null });
  });

  it("surfaces a manual check failure inline instead of silently", async () => {
    infra.checkForUpdate.mockRejectedValue(new Error("network down"));
    const coordinator = new UpdateCoordinator();

    await coordinator.checkManually();

    expect(coordinator.getSnapshot()).toMatchObject({ phase: "check-failed", error: "network down" });
  });

  it("transitions to available with version info when an update exists", async () => {
    infra.checkForUpdate.mockResolvedValue(fakeUpdate({ version: "0.2.0", currentVersion: "0.1.0", body: "notes" }));
    const coordinator = new UpdateCoordinator();

    await coordinator.checkManually();

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: "available",
      info: { version: "0.2.0", currentVersion: "0.1.0", notes: "notes" },
    });
  });

  it("discards the candidate and returns to idle on Later", async () => {
    const update = fakeUpdate();
    infra.checkForUpdate.mockResolvedValue(update);
    const coordinator = new UpdateCoordinator();
    await coordinator.checkManually();

    coordinator.later();

    expect(coordinator.getSnapshot().phase).toBe("idle");
    expect(update.close).toHaveBeenCalledOnce();
  });

  it("downloads, installs, reports progress, and relaunches on Update and restart", async () => {
    const update = fakeUpdate();
    infra.checkForUpdate.mockResolvedValue(update);
    infra.downloadAndInstallUpdate.mockImplementation(
      async (_update: Update, onProgress: (progress: { downloadedBytes: number; totalBytes: number | null }) => void) => {
        onProgress({ downloadedBytes: 10, totalBytes: 20 });
        onProgress({ downloadedBytes: 20, totalBytes: 20 });
      },
    );
    infra.relaunchApp.mockResolvedValue(undefined);
    const coordinator = new UpdateCoordinator();
    await coordinator.checkManually();

    const observedDownloaded: number[] = [];
    coordinator.subscribe(() => {
      const progress = coordinator.getSnapshot().progress;
      if (progress) observedDownloaded.push(progress.downloadedBytes);
    });

    await coordinator.updateAndRestart();

    expect(infra.downloadAndInstallUpdate).toHaveBeenCalledOnce();
    expect(infra.relaunchApp).toHaveBeenCalledOnce();
    // Progress is reported as it arrives (10, then 20) — later notifications
    // may repeat 20 as unrelated phase transitions fire, so assert the
    // meaningful sequence occurred rather than the exact notification count.
    expect(observedDownloaded.filter((value, index, all) => value !== all[index - 1])).toEqual([0, 10, 20]);
    expect(update.close).toHaveBeenCalledOnce();
  });

  it("reports update-failed and leaves the installation untouched when download/install fails", async () => {
    const update = fakeUpdate();
    infra.checkForUpdate.mockResolvedValue(update);
    infra.downloadAndInstallUpdate.mockRejectedValue(new Error("disk full"));
    const coordinator = new UpdateCoordinator();
    await coordinator.checkManually();

    await coordinator.updateAndRestart();

    expect(coordinator.getSnapshot()).toMatchObject({ phase: "update-failed", error: "disk full" });
    expect(infra.relaunchApp).not.toHaveBeenCalled();
  });

  it("reports relaunch-failed distinctly when install succeeded but restart did not", async () => {
    const update = fakeUpdate();
    infra.checkForUpdate.mockResolvedValue(update);
    infra.downloadAndInstallUpdate.mockResolvedValue(undefined);
    infra.relaunchApp.mockRejectedValue(new Error("os blocked restart"));
    const coordinator = new UpdateCoordinator();
    await coordinator.checkManually();

    await coordinator.updateAndRestart();

    expect(coordinator.getSnapshot()).toMatchObject({ phase: "relaunch-failed", error: "os blocked restart" });
  });

  it("collapses a startup check racing a manual check into one operation", async () => {
    let resolveCheck: (value: Update | null) => void = () => undefined;
    infra.checkForUpdate.mockImplementation(
      () =>
        new Promise<Update | null>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const coordinator = new UpdateCoordinator();

    const startupPromise = coordinator.checkOnStartup();
    await coordinator.checkManually();
    expect(infra.checkForUpdate).toHaveBeenCalledOnce();

    resolveCheck(null);
    await startupPromise;
    expect(coordinator.getSnapshot().phase).toBe("up-to-date");
  });

  it("ignores repeated manual checks while one is already in flight", async () => {
    let resolveCheck: (value: Update | null) => void = () => undefined;
    infra.checkForUpdate.mockImplementation(
      () =>
        new Promise<Update | null>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const coordinator = new UpdateCoordinator();

    const first = coordinator.checkManually();
    await coordinator.checkManually();
    await coordinator.checkManually();
    expect(infra.checkForUpdate).toHaveBeenCalledOnce();

    resolveCheck(null);
    await first;
  });

  it("runs the automatic startup check at most once per coordinator lifetime", async () => {
    infra.checkForUpdate.mockResolvedValue(null);
    const coordinator = new UpdateCoordinator();

    await coordinator.checkOnStartup();
    await coordinator.checkOnStartup();

    expect(infra.checkForUpdate).toHaveBeenCalledOnce();
  });

  it("does not let Update and restart run twice concurrently", async () => {
    const update = fakeUpdate();
    infra.checkForUpdate.mockResolvedValue(update);
    let resolveDownload: () => void = () => undefined;
    infra.downloadAndInstallUpdate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve;
        }),
    );
    infra.relaunchApp.mockResolvedValue(undefined);
    const coordinator = new UpdateCoordinator();
    await coordinator.checkManually();

    const first = coordinator.updateAndRestart();
    await coordinator.updateAndRestart();
    expect(infra.downloadAndInstallUpdate).toHaveBeenCalledOnce();

    resolveDownload();
    await first;
  });
});
