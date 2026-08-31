import type { Page } from "@playwright/test";
import type { Settings } from "../../src/domain/settings";
import type { UiState, UiStatePatch } from "../../src/domain/generated";
import type { TauriWorkspaceFixture } from "./workspaceFixtures";

const settings: Settings = {
  locale: "en",
  theme: "light",
  defaultIde: null,
  autoFetch: false,
  performanceDiagnostics: false,
  gitExecutablePath: null,
  diffTool: null,
};

const initialUiState: UiState = {
  version: 1,
  sidebar: { width: null, collapsedWorkspaces: [] },
  repo: {
    treeWidth: null,
    inspectorWidth: null,
    diffMode: "unified",
    fileViewMode: "path",
  },
  selection: { workspaceId: "ws-100", repositoryId: null },
  overview: { filters: [] },
};

/** Installs the deterministic backend at Tauri's existing IPC boundary. */
export async function installTauriMock(page: Page, fixture: TauriWorkspaceFixture) {
  await page.addInitScript(
    ({ backend, startupSettings, startupUiState }) => {
      let callbackId = 1;
      let eventId = 1;
      const callbacks = new Map<number, (payload: unknown) => void>();
      const uiState = structuredClone(startupUiState);

      function applyUiStatePatch(patch: UiStatePatch) {
        if (patch.sidebar) {
          if (patch.sidebar.width !== null) uiState.sidebar.width = patch.sidebar.width;
          if (patch.sidebar.collapsedWorkspaces !== null) {
            uiState.sidebar.collapsedWorkspaces = patch.sidebar.collapsedWorkspaces;
          }
        }
        if (patch.repo) {
          if (patch.repo.treeWidth !== null) uiState.repo.treeWidth = patch.repo.treeWidth;
          if (patch.repo.inspectorWidth !== null) {
            uiState.repo.inspectorWidth = patch.repo.inspectorWidth;
          }
          if (patch.repo.diffMode !== null) uiState.repo.diffMode = patch.repo.diffMode;
          if (patch.repo.fileViewMode !== null) uiState.repo.fileViewMode = patch.repo.fileViewMode;
        }
        if (patch.selection) uiState.selection = patch.selection;
        if (patch.overview?.filters !== null && patch.overview?.filters !== undefined) {
          uiState.overview.filters = patch.overview.filters;
        }
      }

      async function invoke(command: string, args: Record<string, unknown> = {}) {
        switch (command) {
          case "activate_after_first_paint":
          case "set_repository_activity":
          case "plugin:event|unlisten":
            return undefined;
          case "plugin:event|listen":
            return eventId++;
          case "get_settings":
            return structuredClone(startupSettings);
          case "list_workspaces":
            return structuredClone(backend.workspaces);
          case "list_repositories":
            return backend.repositories.filter(
              (repository) => repository.workspaceId === args.workspaceId,
            );
          case "get_workspace_status":
            return structuredClone(backend.statuses);
          case "get_workspace_health":
            return structuredClone(backend.health);
          case "get_ui_state":
            return structuredClone(uiState);
          case "update_ui_state":
            applyUiStatePatch(args.patch as UiStatePatch);
            return structuredClone(uiState);
          case "plugin:updater|check":
            return null;
          default:
            throw new Error(`Unexpected Tauri command in E2E: ${command}`);
        }
      }

      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          invoke,
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { label: "main" },
          },
          transformCallback(callback: (payload: unknown) => void, once = false) {
            const id = callbackId++;
            callbacks.set(id, (payload) => {
              callback(payload);
              if (once) callbacks.delete(id);
            });
            return id;
          },
          unregisterCallback(id: number) {
            callbacks.delete(id);
          },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: {
          unregisterListener() {},
        },
      });

      localStorage.setItem(
        "fjord:startup-preferences:v1",
        JSON.stringify({ locale: "en", theme: "light", performanceDiagnostics: false }),
      );
    },
    { backend: fixture, startupSettings: settings, startupUiState: initialUiState },
  );
}
