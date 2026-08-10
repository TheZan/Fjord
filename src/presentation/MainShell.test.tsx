import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MainShell } from "@/presentation/MainShell";

describe("MainShell", () => {
  it("keeps exactly Search and Settings in the same top-right strip for every main screen", () => {
    const onOpenSearch = vi.fn();
    const onOpenSettings = vi.fn();
    const { container, rerender } = renderShell("Overview", onOpenSearch, onOpenSettings);

    for (const name of ["Overview", "All repositories", "Repository"]) {
      rerender(shell(name, onOpenSearch, onOpenSettings));
      const main = container.querySelector("main")!;
      const utilityBar = main.querySelector("[data-shell-utility-bar]")!;
      expect(main.firstElementChild).toBe(utilityBar);
      expect(utilityBar).toContainElement(screen.getByRole("button", { name: "Search" }));
      expect(utilityBar).toContainElement(screen.getByRole("button", { name: "Settings" }));
      expect(utilityBar.querySelectorAll("button")).toHaveLength(2);
      expect(main.querySelector("[data-shell-screen]")).toHaveTextContent(name);
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
    <MainShell
      searchLabel="Search"
      settingsLabel="Settings"
      onOpenSearch={onOpenSearch}
      onOpenSettings={onOpenSettings}
    >
      <div>{name}</div>
    </MainShell>
  );
}
