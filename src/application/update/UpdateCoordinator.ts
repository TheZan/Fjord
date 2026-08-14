// Module-level singleton state machine for the whole update lifecycle:
// check → available → download/install → relaunch, plus every failure and
// race case. Both the startup check (App.tsx) and the manual check
// (SettingsDialog) call the same instance, so there is exactly one update
// operation in flight at a time and exactly one dialog can ever be open —
// no separate state-management dependency, just `useSyncExternalStore`
// (see `useUpdateState.ts`).

import {
  checkForUpdate,
  downloadAndInstallUpdate,
  relaunchApp,
  type Update,
  type UpdateDownloadProgress,
} from "@/infrastructure/updater";
import {
  INITIAL_UPDATE_SNAPSHOT,
  isBusyPhase,
  type UpdateSnapshot,
  type UpdateTrigger,
} from "@/application/update/updateModel";

type Listener = () => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class UpdateCoordinator {
  private snapshot: UpdateSnapshot = INITIAL_UPDATE_SNAPSHOT;
  private readonly listeners = new Set<Listener>();
  private activeUpdate: Update | null = null;
  private startupCheckStarted = false;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UpdateSnapshot => this.snapshot;

  private set(patch: Partial<UpdateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private discardActiveUpdate(): void {
    if (this.activeUpdate) {
      const stale = this.activeUpdate;
      this.activeUpdate = null;
      void stale.close().catch(() => undefined);
    }
  }

  /** At most one automatic check per launch — App.tsx calls this once, a few seconds after first paint. */
  async checkOnStartup(): Promise<void> {
    if (this.startupCheckStarted || isBusyPhase(this.snapshot.phase)) return;
    this.startupCheckStarted = true;
    await this.runCheck("startup");
  }

  /** Settings → "Check for updates". Reuses the same state machine, never a second implementation. */
  async checkManually(): Promise<void> {
    if (isBusyPhase(this.snapshot.phase)) return;
    await this.runCheck("manual");
  }

  private async runCheck(trigger: UpdateTrigger): Promise<void> {
    this.discardActiveUpdate();
    this.set({ phase: "checking", trigger, error: null, progress: null, info: null });

    let update: Update | null;
    try {
      update = await checkForUpdate();
    } catch (error) {
      // A startup check failing (no network, or the updater plugin isn't
      // registered in this build) is silent per the runtime-update-check
      // contract; a manual check reports it inline in Settings.
      if (trigger === "startup") {
        this.set({ phase: "idle", trigger: null });
        return;
      }
      this.set({ phase: "check-failed", error: errorMessage(error) });
      return;
    }

    if (!update) {
      this.set({ phase: "up-to-date" });
      return;
    }

    this.activeUpdate = update;
    this.set({
      phase: "available",
      info: { version: update.version, currentVersion: update.currentVersion, notes: update.body ?? null },
    });
  }

  /** Declines the offered update. Discards the cached candidate; a later check starts fresh. */
  later(): void {
    if (this.snapshot.phase !== "available") return;
    this.discardActiveUpdate();
    this.set({ phase: "idle", trigger: null, info: null });
  }

  /** Dismisses an inline/dialog result (`up-to-date`, `check-failed`) without starting anything new. */
  acknowledge(): void {
    if (isBusyPhase(this.snapshot.phase)) return;
    this.set({ phase: "idle", trigger: null, error: null, info: null });
  }

  async updateAndRestart(): Promise<void> {
    if (this.snapshot.phase !== "available" || !this.activeUpdate) return;
    const update = this.activeUpdate;

    this.set({ phase: "downloading", progress: { downloadedBytes: 0, totalBytes: null } });
    try {
      await downloadAndInstallUpdate(update, (progress: UpdateDownloadProgress) => this.set({ progress }));
    } catch (error) {
      this.discardActiveUpdate();
      this.set({ phase: "update-failed", error: errorMessage(error) });
      return;
    }

    this.discardActiveUpdate();
    this.set({ phase: "relaunching" });
    try {
      await relaunchApp();
      // A successful relaunch tears this process down; if it somehow
      // resolves without restarting, fall through to idle instead of
      // leaving the UI stuck showing "Relaunching…" forever.
      this.set({ phase: "idle", trigger: null });
    } catch (error) {
      // The update *was* installed — only the restart failed, so this must
      // not claim "your installation was not changed" (that message is only
      // true for update-failed).
      this.set({ phase: "relaunch-failed", error: errorMessage(error) });
    }
  }

  /** "Try again" from `update-failed`/`relaunch-failed`/`check-failed` — re-runs the last check from scratch. */
  retry(): void {
    if (isBusyPhase(this.snapshot.phase)) return;
    void this.runCheck(this.snapshot.trigger ?? "manual");
  }

  close(): void {
    if (isBusyPhase(this.snapshot.phase)) return;
    this.discardActiveUpdate();
    this.set({ phase: "idle", trigger: null, error: null, info: null, progress: null });
  }
}

export const updateCoordinator = new UpdateCoordinator();
