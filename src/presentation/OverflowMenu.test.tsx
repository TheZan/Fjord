import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { OverflowMenu } from "@/presentation/OverflowMenu";

describe("OverflowMenu", () => {
  it("navigates enabled menu items with arrows and restores trigger focus on Escape", async () => {
    const first = vi.fn();
    const { container } = render(
      <OverflowMenu
        label="More actions"
        items={[
          { id: "first", label: "First", onSelect: first },
          { id: "disabled", label: "Disabled", disabled: true, onSelect: vi.fn() },
          { id: "last", label: "Last", onSelect: vi.fn() },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "More actions" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await Promise.resolve();
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "First" }), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Last" }), { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "First" }), { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("runs a selected action and closes the menu", () => {
    const action = vi.fn();
    render(<OverflowMenu label="More actions" items={[{ id: "run", label: "Run", onSelect: action }]} />);

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Run" }));
    expect(action).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
