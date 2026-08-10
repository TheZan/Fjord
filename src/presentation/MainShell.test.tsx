import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MainShell, ShellUtilities } from "@/presentation/MainShell";

describe("MainShell", () => {
  it("places the shared Search and Settings controls inside each screen header without a utility row", () => {
    const onOpenSearch = vi.fn();
    const onOpenSettings = vi.fn();
    const { container, rerender } = renderShell("Overview", onOpenSearch, onOpenSettings);

    for (const name of ["Overview", "All repositories", "Repository"]) {
      rerender(shell(name, onOpenSearch, onOpenSettings));
      const main = container.querySelector("main")!;
      const screenSlot = main.querySelector("[data-shell-screen]")!;
      const utilities = screenSlot.querySelector("[data-shell-utilities]")!;
      expect(main.firstElementChild).toBe(screenSlot);
      expect(main.querySelector("[data-shell-utility-bar]")).not.toBeInTheDocument();
      expect(utilities).toContainElement(screen.getByRole("button", { name: "Search" }));
      expect(utilities).toContainElement(screen.getByRole("button", { name: "Settings" }));
      expect(utilities.querySelectorAll("button")).toHaveLength(2);
      expect(screenSlot).toHaveTextContent(name);
    }

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSearch).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

function renderShell(name: string, onOpenSearch: () => void, onOpenSettings: () => void) {
  return render(shell(name, onOpenSearch, onOpenSettings));
}

function shell(name: string, onOpenSearch: () => void, onOpenSettings: () => void) {
  return (
    <MainShell>
      <header>
        <span>{name}</span>
        <ShellUtilities
          searchLabel="Search"
          settingsLabel="Settings"
          onOpenSearch={onOpenSearch}
          onOpenSettings={onOpenSettings}
        />
      </header>
    </MainShell>
  );
}
