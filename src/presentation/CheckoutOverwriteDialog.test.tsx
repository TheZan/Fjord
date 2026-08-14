import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { CheckoutOverwriteDialog } from "@/presentation/CheckoutOverwriteDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("CheckoutOverwriteDialog", () => {
  it("presents cancel, stash, and destructive recovery choices accessibly", async () => {
    const onCancel = vi.fn();
    const onStash = vi.fn();
    const onDiscard = vi.fn();
    const { container } = render(
      <CheckoutOverwriteDialog
        branch="feature"
        paths={["src/main.rs", "README.md"]}
        pending={false}
        onCancel={onCancel}
        onStash={onStash}
        onDiscard={onDiscard}
      />,
    );

    expect(screen.getByRole("dialog", { name: "checkoutOverwrite.title" })).toBeInTheDocument();
    expect(screen.getByText("src/main.rs")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "checkoutOverwrite.stash" }));
    fireEvent.click(screen.getByRole("button", { name: "checkoutOverwrite.discard" }));
    fireEvent.click(screen.getByRole("button", { name: "context.cancel" }));
    expect(onStash).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
