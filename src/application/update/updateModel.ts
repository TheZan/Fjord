// Types for the update state machine. Kept separate from
// `UpdateCoordinator.ts` so components can import just the shapes they
// render without pulling in the coordinator singleton.

export type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "check-failed"
  | "available"
  | "downloading"
  | "relaunching"
  | "update-failed"
  | "relaunch-failed";

export type UpdateTrigger = "startup" | "manual";

export interface UpdateAvailableInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
}

export interface UpdateDownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

export interface UpdateSnapshot {
  phase: UpdatePhase;
  trigger: UpdateTrigger | null;
  info: UpdateAvailableInfo | null;
  progress: UpdateDownloadProgress | null;
  error: string | null;
}

export const INITIAL_UPDATE_SNAPSHOT: UpdateSnapshot = {
  phase: "idle",
  trigger: null,
  info: null,
  progress: null,
  error: null,
};

// The phases in which the shared global dialog (App.tsx) should render.
// `up-to-date`/`check-failed` are inline-only (SettingsDialog reads them
// directly) — a background startup check finding nothing new must not pop a
// dialog (docs/releasing.md's runtime-update-check contract).
const DIALOG_PHASES = new Set<UpdatePhase>([
  "available",
  "downloading",
  "relaunching",
  "update-failed",
  "relaunch-failed",
]);

export function isDialogPhase(phase: UpdatePhase): boolean {
  return DIALOG_PHASES.has(phase);
}

// Phases in which starting a new check/download must be refused — the
// single-flight rule from docs/releasing.md's race-safety section.
const BUSY_PHASES = new Set<UpdatePhase>(["checking", "downloading", "relaunching"]);

export function isBusyPhase(phase: UpdatePhase): boolean {
  return BUSY_PHASES.has(phase);
}
