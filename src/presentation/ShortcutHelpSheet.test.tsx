import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAppShortcutBindings, type AppShortcutActions } from "@/application/appShortcuts";
import { ShortcutHelpSheet } from "@/presentation/ShortcutHelpSheet";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => ({
    "shortcuts.key.primary": "Ctrl/Cmd",
    "shortcuts.key.alt": "Alt",
    "shortcuts.key.shift": "Shift",
    "shortcuts.key.escape": "Esc",
    "shortcuts.key.enter": "Enter",
  }[key] ?? `${key}${values?.number ?? ""}`) }),
}));

const actions = new Proxy({}, { get: () => vi.fn() }) as AppShortcutActions;

describe("ShortcutHelpSheet", () => {
  it("renders every registered binding with a localized label", () => {
    const bindings = createAppShortcutBindings({ workspaceCount: 3, actions });
    render(<ShortcutHelpSheet bindings={bindings} onClose={vi.fn()} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(bindings.length);
    for (const binding of bindings) {
      const label = binding.id.startsWith("workspace.switch.")
        ? `shortcuts.workspace${binding.id.split(".").at(-1)}`
        : `shortcuts.${binding.id.replaceAll(".", "_")}`;
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("Ctrl/Cmd+Shift+F")).toBeInTheDocument();
  });
});
