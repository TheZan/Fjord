// Thin wrapper over `@tauri-apps/plugin-updater`/`@tauri-apps/plugin-process`
// — the only place either is imported directly, mirroring the rule
// `tauriClient.ts` follows for `@tauri-apps/api`. Both plugins are only
// registered in signed release builds (crates/fjord-app/src/lib.rs), so
// every call here can reject in dev/unsigned builds — callers decide how to
// present that, this module just passes it through.

import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type { Update };

export interface UpdateDownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

export async function checkForUpdate(): Promise<Update | null> {
  return check();
}

/** Downloads and installs in one call; reports download progress as it arrives. */
export async function downloadAndInstallUpdate(
  update: Update,
  onProgress: (progress: UpdateDownloadProgress) => void,
): Promise<void> {
  let downloadedBytes = 0;
  let totalBytes: number | null = null;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        totalBytes = event.data.contentLength ?? null;
        onProgress({ downloadedBytes, totalBytes });
        break;
      case "Progress":
        downloadedBytes += event.data.chunkLength;
        onProgress({ downloadedBytes, totalBytes });
        break;
      case "Finished":
        onProgress({ downloadedBytes: totalBytes ?? downloadedBytes, totalBytes });
        break;
    }
  });
}

export async function relaunchApp(): Promise<void> {
  await relaunch();
}
