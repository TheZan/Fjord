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
});
