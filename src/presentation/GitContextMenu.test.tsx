import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "@/presentation/GitContextMenu";

describe("ContextMenu", () => {
  afterEach(cleanup);

  it("moves focus with arrows, skips disabled items, and selects with Enter", async () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu
        position={{ x: 20, y: 20 }}
        items={[
          { id: "checkout", label: "Checkout", icon: "checkout" },
          { id: "rename", label: "Rename", disabled: true },
          { id: "copy", label: "Copy", icon: "copy", shortcut: "Ctrl+C" },
        ]}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Checkout" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Copy/ })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("copy");
  });

  it("runs a displayed shortcut regardless of the active keyboard layout", async () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu
        position={{ x: 20, y: 20 }}
        items={[
          { id: "checkout", label: "Checkout", icon: "checkout" },
          { id: "copy", label: "Copy", icon: "copy", shortcut: "Ctrl+C" },
        ]}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "с", code: "KeyC", ctrlKey: true });

    expect(onSelect).toHaveBeenCalledWith("copy");
  });

  it("opens submenus with the keyboard and restores focus after Escape", async () => {
    const onSelect = vi.fn();
    render(<MenuHarness onSelect={onSelect} />);
    const origin = screen.getByRole("button", { name: "Open menu" });
    origin.focus();
    fireEvent.click(origin);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy path" })).toHaveFocus());

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Relative path" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy path" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    await waitFor(() => expect(origin).toHaveFocus());
    expect(onSelect).not.toHaveBeenCalled();
  });
});

function MenuHarness({ onSelect }: { onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open menu</button>
    {open ? (
      <ContextMenu
        position={{ x: 20, y: 20 }}
        items={[{
          id: "copy",
          label: "Copy path",
          children: [
            { id: "relative", label: "Relative path" },
            { id: "absolute", label: "Absolute path" },
          ],
        }]}
        onSelect={onSelect}
        onClose={() => setOpen(false)}
      />
    ) : null}
  </>;
}
