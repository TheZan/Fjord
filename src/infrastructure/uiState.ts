import type { UiState, UiStatePatch } from "@/domain/generated";
import { getUiState, updateUiState } from "@/infrastructure/tauriClient";

export const LEGACY_REPO_LAYOUT_KEY = "fjord:repo-layout:v1";

interface LegacyPaneSizes {
  left?: number;
  right?: number;
}

let stateRequest: Promise<UiState> | null = null;
let stateWrite: Promise<UiState> | null = null;

export function loadUiState(): Promise<UiState> {
  if (!stateRequest) {
    stateRequest = getUiState()
      .then(migrateLegacyPaneSizes)
      .catch((error) => {
        stateRequest = null;
        throw error;
      });
  }
  return stateRequest;
}

export function saveRepoPaneSizes(treeWidth: number, inspectorWidth: number): Promise<UiState> {
  return saveUiState({ sidebar: null, repo: { treeWidth, inspectorWidth } });
}

export function saveSidebarWidth(width: number): Promise<UiState> {
  return saveUiState({ sidebar: { width }, repo: null });
}

function saveUiState(patch: UiStatePatch): Promise<UiState> {
  const previous = stateWrite ?? loadUiState();
  stateWrite = previous.catch(defaultUiState).then(() =>
    updateUiState(patch).then((state) => {
      stateRequest = Promise.resolve(state);
      return state;
    }),
  );
  return stateWrite;
}

function migrateLegacyPaneSizes(state: UiState): Promise<UiState> | UiState {
  const legacy = readLegacyPaneSizes();
  if (!legacy) return state;

  const treeWidth = state.repo.treeWidth ?? finiteNumber(legacy.left);
  const inspectorWidth = state.repo.inspectorWidth ?? finiteNumber(legacy.right);
  const migration =
    treeWidth !== state.repo.treeWidth || inspectorWidth !== state.repo.inspectorWidth
      ? updateUiState({ sidebar: null, repo: { treeWidth, inspectorWidth } })
      : Promise.resolve(state);
  return migration.then((updated) => {
    localStorage.removeItem(LEGACY_REPO_LAYOUT_KEY);
    return updated;
  });
}

function readLegacyPaneSizes(): LegacyPaneSizes | null {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_REPO_LAYOUT_KEY) ?? "null") as LegacyPaneSizes | null;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function defaultUiState(): UiState {
  return { version: 1, sidebar: { width: null }, repo: { treeWidth: null, inspectorWidth: null } };
}
