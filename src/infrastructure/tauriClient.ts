// Thin wrapper over Tauri's `invoke` — the only place `@tauri-apps/api`
// is imported directly. Command names must match docs/specs/ipc-commands.md
// and the `#[tauri::command]` fn names in crates/fjord-app exactly
// (verb_noun, snake_case, no translation layer).

import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "@/domain/settings";

export function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

export function updateSettings(settings: Settings): Promise<Settings> {
  return invoke("update_settings", { settings });
}
