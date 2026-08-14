import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { RepositoryOnboardingDialog } from "@/presentation/RepositoryOnboardingDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function actions() {
  return {
    onOpenExisting: vi.fn(),
    onScanFolder: vi.fn(),
    onClone: vi.fn(),
    onCreate: vi.fn(),
    onClose: vi.fn(),
  };
}

describe("RepositoryOnboardingDialog", () => {
  it("exposes every localized entry point and dispatches each available action", () => {
    const callbacks = actions();
    render(<RepositoryOnboardingDialog {...callbacks} />);

    const entries = ["openExisting", "scanFolder", "clone", "create"] as const;
    for (const entry of entries) {
      fireEvent.click(
        screen.getByRole("button", {
          name: `repositoryOnboarding.actions.${entry}.label`,
        }),
      );
    }

    expect(callbacks.onOpenExisting).toHaveBeenCalledOnce();
    expect(callbacks.onScanFolder).toHaveBeenCalledOnce();
    expect(callbacks.onClone).toHaveBeenCalledOnce();
    expect(callbacks.onCreate).toHaveBeenCalledOnce();
    expect(callbacks.onClose).toHaveBeenCalledTimes(4);
  });

  it("keeps future mutation entries visible with an accessible disabled reason", () => {
    render(
      <RepositoryOnboardingDialog
        onOpenExisting={vi.fn()}
        onScanFolder={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "repositoryOnboarding.actions.clone.label" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "repositoryOnboarding.actions.create.label" }),
    ).toBeDisabled();
    expect(screen.getAllByText("repositoryOnboarding.unavailable")).toHaveLength(2);
  });

  it("focuses the first action, traps keyboard focus, closes on Escape, and restores focus", () => {
    const callbacks = actions();
    const view = render(<button type="button">Invoker</button>);
    const invoker = screen.getByRole("button", { name: "Invoker" });
    invoker.focus();

    view.rerender(
      <>
        <button type="button">Invoker</button>
        <RepositoryOnboardingDialog {...callbacks} />
      </>,
    );

    const first = screen.getByRole("button", {
      name: "repositoryOnboarding.actions.openExisting.label",
    });
    const cancel = screen.getByRole("button", { name: "context.cancel" });
    expect(first).toHaveFocus();

    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(callbacks.onClose).toHaveBeenCalledOnce();

    view.rerender(<button type="button">Invoker</button>);
    expect(screen.getByRole("button", { name: "Invoker" })).toHaveFocus();
  });

  it("passes an automated accessibility scan", async () => {
    const { container } = render(<RepositoryOnboardingDialog {...actions()} />);
    expect(
      (await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations,
    ).toEqual([]);
  });
});
