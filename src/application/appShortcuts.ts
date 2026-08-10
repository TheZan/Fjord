import type { ShortcutBinding } from "@/application/shortcutRegistry";

export interface AppShortcutActions {
  openPalette: () => void;
  openRepositorySwitcher: () => void;
  openSettings: () => void;
  openRepositorySearch: () => void;
  openGlobalSearch: () => void;
  commit: () => void;
  refreshRepository: () => void;
  refreshWorkspace: () => void;
  switchWorkspace: (index: number) => void;
  openHelp: () => void;
  closeTopOverlay: () => void;
}

export function createAppShortcutBindings({
  workspaceCount,
  actions,
}: {
  workspaceCount: number;
  actions: AppShortcutActions;
}): ShortcutBinding[] {
  const bindings: ShortcutBinding[] = [
    binding("palette.open", "KeyK", { primary: true }, "global", actions.openPalette),
    binding("switcher.open", "KeyP", { primary: true }, "global", actions.openRepositorySwitcher),
    binding("settings.open", "Comma", { primary: true }, "global", actions.openSettings),
    binding("search.global", "KeyF", { primary: true, shift: true }, "global", actions.openGlobalSearch),
    binding("refresh.workspace", "KeyR", { primary: true }, "global", actions.refreshWorkspace),
    binding("help.open", "Slash", { shift: true }, "global", actions.openHelp),
    binding("escape", "Escape", {}, "global", actions.closeTopOverlay),
  ];

  for (let index = 0; index < Math.min(workspaceCount, 9); index += 1) {
    bindings.push(
      binding(
        `workspace.switch.${index + 1}`,
        `Digit${index + 1}`,
        { primary: true },
        "global",
        () => actions.switchWorkspace(index),
      ),
    );
  }

  bindings.push(
    binding("search.repository", "KeyF", { primary: true }, "repository", actions.openRepositorySearch),
    binding("commit", "Enter", { primary: true }, "repository", actions.commit),
    binding("refresh.repository", "KeyR", { primary: true }, "repository", actions.refreshRepository),
  );

  return bindings;
}

function binding(
  id: string,
  code: string,
  modifiers: ShortcutBinding["modifiers"],
  scope: ShortcutBinding["scope"],
  handler: ShortcutBinding["handler"],
): ShortcutBinding {
  return { id, code, modifiers, scope, handler };
}
