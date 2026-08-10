import { describe, expect, it, vi } from "vitest";
import { createAppShortcutBindings, type AppShortcutActions } from "@/application/appShortcuts";
import { dispatchShortcut } from "@/application/shortcutRegistry";

function actions(): AppShortcutActions {
  return {
    openPalette: vi.fn(),
    openRepositorySwitcher: vi.fn(),
    openSettings: vi.fn(),
    openRepositorySearch: vi.fn(),
    openGlobalSearch: vi.fn(),
    commit: vi.fn(),
    refreshRepository: vi.fn(),
    refreshWorkspace: vi.fn(),
    switchWorkspace: vi.fn(),
    openHelp: vi.fn(),
    closeTopOverlay: vi.fn(),
  };
}

describe("app shortcuts", () => {
  it("wires settings and numbered workspace navigation", () => {
    const handlers = actions();
    const bindings = createAppShortcutBindings({ workspaceCount: 3, actions: handlers });

    dispatchShortcut(bindings, [], new KeyboardEvent("keydown", { code: "Comma", ctrlKey: true, cancelable: true }));
    dispatchShortcut(bindings, [], new KeyboardEvent("keydown", { code: "Digit2", ctrlKey: true, cancelable: true }));

    expect(handlers.openSettings).toHaveBeenCalledOnce();
    expect(handlers.switchWorkspace).toHaveBeenCalledWith(1);
  });

  it("resolves repository search and refresh ahead of global bindings", () => {
    const handlers = actions();
    const bindings = createAppShortcutBindings({ workspaceCount: 0, actions: handlers });

    dispatchShortcut(bindings, ["repository"], new KeyboardEvent("keydown", { code: "KeyF", ctrlKey: true }));
    dispatchShortcut(bindings, ["repository"], new KeyboardEvent("keydown", { code: "KeyR", ctrlKey: true }));

    expect(handlers.openRepositorySearch).toHaveBeenCalledOnce();
    expect(handlers.refreshRepository).toHaveBeenCalledOnce();
    expect(handlers.refreshWorkspace).not.toHaveBeenCalled();
  });
});
