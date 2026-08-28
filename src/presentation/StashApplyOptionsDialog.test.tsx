import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StashEntry } from "@/domain/git";
import { StashApplyOptionsDialog } from "@/presentation/StashApplyOptionsDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const stash: StashEntry = {
  id: "stash-id", index: 2, refName: "stash@{2}", message: "WIP", title: "WIP",
  base: "base-id", branch: "main", createdAt: "2026-08-28T00:00:00Z", filesChanged: 1,
  hasIndexState: false, hasUntracked: false,
};

describe("StashApplyOptionsDialog", () => {
  it("disables restore-index with a visible reason when no index state exists", () => {
    render(<StashApplyOptionsDialog action="apply" stash={stash} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: /stash.options.restoreIndex/ })).toBeDisabled();
    expect(screen.getByText("stash.options.restoreIndexUnavailable")).toBeInTheDocument();
  });

  it("passes the restore-index choice to both Apply and Pop flows", () => {
    const onConfirm = vi.fn();
    const view = render(
      <StashApplyOptionsDialog action="apply" stash={{ ...stash, hasIndexState: true }} onClose={vi.fn()} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "stash.options.applyConfirm" }));
    expect(onConfirm).toHaveBeenLastCalledWith(true);

    view.rerender(
      <StashApplyOptionsDialog key="pop" action="pop" stash={{ ...stash, hasIndexState: true }} onClose={vi.fn()} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "stash.options.popConfirm" }));
    expect(onConfirm).toHaveBeenLastCalledWith(true);
  });
});
