// Thin wrapper over Tauri's `invoke` — the only place `@tauri-apps/api`
// is imported directly. Command names must match docs/specs/ipc-commands.md
// and the `#[tauri::command]` fn names in crates/fjord-app exactly
// (verb_noun, snake_case, no translation layer).

import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "@/domain/settings";
import type { RepositoryEntry, Workspace } from "@/domain/workspace";

export function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

export function updateSettings(settings: Settings): Promise<Settings> {
  return invoke("update_settings", { settings });
}

export function listWorkspaces(): Promise<Workspace[]> {
  return invoke("list_workspaces");
}

export function createWorkspace(name: string): Promise<Workspace> {
  return invoke("create_workspace", { name });
}

export function listRepositories(workspaceId: string): Promise<RepositoryEntry[]> {
  return invoke("list_repositories", { workspaceId });
}

export function addRepository(workspaceId: string, path: string): Promise<RepositoryEntry> {
  return invoke("add_repository", { workspaceId, path });
}
