import { act, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const infra = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  relaunchApp: vi.fn(),
}));
vi.mock("@/infrastructure/updater", () => infra);

import { updateCoordinator } from "@/application/update/UpdateCoordinator";
import { UpdateDialog } from "@/presentation/UpdateDialog";

beforeEach(() => {
  infra.checkForUpdate.mockReset();
  infra.downloadAndInstallUpdate.mockReset();
  infra.relaunchApp.mockReset();
  updateCoordinator.close();
});

describe("UpdateDialog", () => {
  it("renders nothing when idle", () => {
    const { container } = render(<UpdateDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the available dialog with Later and Update and restart", async () => {
    infra.checkForUpdate.mockResolvedValue({
      version: "0.2.0",
      currentVersion: "0.1.0",
      body: "release notes",
      close: vi.fn().mockResolvedValue(undefined),
    });
    render(<UpdateDialog />);

    await updateCoordinator.checkManually();

    const dialog = await screen.findByRole("dialog", { name: "update.available.title" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "update.available.later" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "update.available.updateAndRestart" })).toBeInTheDocument();
    expect((await axe.run(dialog)).violations).toEqual([]);
  });

  it("hides again after Later is chosen", async () => {
    infra.checkForUpdate.mockResolvedValue({
      version: "0.2.0",
      currentVersion: "0.1.0",
      body: null,
      close: vi.fn().mockResolvedValue(undefined),
    });
    const { container } = render(<UpdateDialog />);
    await updateCoordinator.checkManually();
    await screen.findByRole("dialog");

    act(() => updateCoordinator.later());

    expect(container).toBeEmptyDOMElement();
  });

  it("shows download progress while downloading", async () => {
    infra.checkForUpdate.mockResolvedValue({
      version: "0.2.0",
      currentVersion: "0.1.0",
      body: null,
      close: vi.fn().mockResolvedValue(undefined),
    });
    let resolveDownload: () => void = () => undefined;
    infra.downloadAndInstallUpdate.mockImplementation(
      (
        _update: unknown,
        onProgress: (progress: { downloadedBytes: number; totalBytes: number | null }) => void,
      ) =>
        new Promise<void>((resolve) => {
          onProgress({ downloadedBytes: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024 });
          resolveDownload = resolve;
        }),
    );
    render(<UpdateDialog />);
    await updateCoordinator.checkManually();
    await screen.findByRole("dialog");

    const donePromise = updateCoordinator.updateAndRestart();

    const progressDialog = await screen.findByRole("dialog", { name: "update.downloading.title" });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect((await axe.run(progressDialog)).violations).toEqual([]);

    resolveDownload();
    await donePromise;
  });

  it("shows the failed dialog with Try again when download/install fails", async () => {
    infra.checkForUpdate.mockResolvedValue({
      version: "0.2.0",
      currentVersion: "0.1.0",
      body: null,
      close: vi.fn().mockResolvedValue(undefined),
    });
    infra.downloadAndInstallUpdate.mockRejectedValue(new Error("disk full"));
    render(<UpdateDialog />);
    await updateCoordinator.checkManually();
    await screen.findByRole("dialog");

    await updateCoordinator.updateAndRestart();

    const dialog = await screen.findByRole("dialog", { name: "update.failed.title" });
    expect(screen.getByRole("button", { name: "update.failed.tryAgain" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "update.failed.close" })).toBeInTheDocument();
    expect((await axe.run(dialog)).violations).toEqual([]);
  });

  it("shows a relaunch-only failure without a Try again button when install succeeded but restart did not", async () => {
    infra.checkForUpdate.mockResolvedValue({
      version: "0.2.0",
      currentVersion: "0.1.0",
      body: null,
      close: vi.fn().mockResolvedValue(undefined),
    });
    infra.downloadAndInstallUpdate.mockResolvedValue(undefined);
    infra.relaunchApp.mockRejectedValue(new Error("os blocked restart"));
    render(<UpdateDialog />);
    await updateCoordinator.checkManually();
    await screen.findByRole("dialog");

    await updateCoordinator.updateAndRestart();

    await screen.findByRole("dialog", { name: "update.failed.title" });
    expect(screen.queryByRole("button", { name: "update.failed.tryAgain" })).not.toBeInTheDocument();
  });
});
