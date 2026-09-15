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
    const bindings = createAppShortcutBindings({ workspaceCount: 3, hasOpenOverlay: false, actions: handlers });

    dispatchShortcut(bindings, [], new KeyboardEvent("keydown", { code: "Comma", ctrlKey: true, cancelable: true }));
    dispatchShortcut(bindings, [], new KeyboardEvent("keydown", { code: "Digit2", ctrlKey: true, cancelable: true }));

    expect(handlers.openSettings).toHaveBeenCalledOnce();
    expect(handlers.switchWorkspace).toHaveBeenCalledWith(1);
  });

  it("resolves repository search and refresh ahead of global bindings", () => {
    const handlers = actions();
    const bindings = createAppShortcutBindings({ workspaceCount: 0, hasOpenOverlay: false, actions: handlers });

    dispatchShortcut(bindings, ["repository"], new KeyboardEvent("keydown", { code: "KeyF", ctrlKey: true }));
    dispatchShortcut(bindings, ["repository"], new KeyboardEvent("keydown", { code: "KeyR", ctrlKey: true }));

    expect(handlers.openRepositorySearch).toHaveBeenCalledOnce();
    expect(handlers.refreshRepository).toHaveBeenCalledOnce();
    expect(handlers.refreshWorkspace).not.toHaveBeenCalled();
  });

  it("only consumes Escape when a shell overlay can close", () => {
    const handlers = actions();
    const event = () => new KeyboardEvent("keydown", { code: "Escape", key: "Escape", cancelable: true });

    const closed = dispatchShortcut(
      createAppShortcutBindings({ workspaceCount: 0, hasOpenOverlay: false, actions: handlers }),
      ["repository"],
      event(),
    );
    expect(closed).toBe(false);

    const opened = dispatchShortcut(
      createAppShortcutBindings({ workspaceCount: 0, hasOpenOverlay: true, actions: handlers }),
      ["dialog"],
      event(),
    );
    expect(opened).toBe(true);
    expect(handlers.closeTopOverlay).toHaveBeenCalledOnce();
  });
});
