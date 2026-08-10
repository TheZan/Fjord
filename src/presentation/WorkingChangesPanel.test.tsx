import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkingChangesPanel } from "@/presentation/WorkingChangesPanel";
import type { WorkingChanges } from "@/domain/git";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) =>
      key === "working.commit" ? `Commit ${values?.count ?? 0}` : key,
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      key: index,
      size: 29,
      start: index * 29,
    })),
  }),
}));

const changes: WorkingChanges = {
  unstaged: [
    { path: "src/app.ts", changeType: "modified", conflicted: false },
    { path: "src/conflict.ts", changeType: "modified", conflicted: true },
  ],
  staged: [{ path: "README.md", changeType: "added", conflicted: false }],
};

function props(overrides: Partial<React.ComponentProps<typeof WorkingChangesPanel>> = {}) {
  return {
    changes,
    loading: false,
    error: null,
    busy: false,
    validated: true,
    selectedFile: null,
    onSelectFile: vi.fn(),
    onStage: vi.fn(),
    onUnstage: vi.fn(),
    onCommit: vi.fn(async () => true),
    ...overrides,
  };
}

describe("WorkingChangesPanel", () => {
  it("keeps staged and unstaged actions scoped to the correct files", () => {
    const panelProps = props();
    render(<WorkingChangesPanel {...panelProps} />);

    fireEvent.click(screen.getByText("app.ts"));
    expect(panelProps.onSelectFile).toHaveBeenCalledWith({ path: "src/app.ts", staged: false });

    fireEvent.click(screen.getByRole("button", { name: "working.stageAll" }));
    expect(panelProps.onStage).toHaveBeenCalledWith(["src/app.ts", "src/conflict.ts"]);
    fireEvent.click(screen.getAllByRole("button", { name: "working.stage" })[1]);
    expect(panelProps.onStage).toHaveBeenCalledWith(["src/conflict.ts"]);

    fireEvent.click(screen.getByRole("button", { name: "working.unstageAll" }));
    expect(panelProps.onUnstage).toHaveBeenCalledWith(["README.md"]);
    expect(screen.getByText("working.conflicted")).toBeInTheDocument();
  });

  it("composes a trimmed commit message and clears inputs after success", async () => {
    const onCommit = vi.fn(async () => true);
    render(<WorkingChangesPanel {...props({ onCommit })} />);

    fireEvent.change(screen.getByPlaceholderText("working.summaryPlaceholder"), {
      target: { value: "  Add coverage  " },
    });
    fireEvent.change(screen.getByPlaceholderText("working.descriptionPlaceholder"), {
      target: { value: "  Explain behavior  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit 1" }));

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("Add coverage\n\nExplain behavior"));
    expect(screen.getByPlaceholderText("working.summaryPlaceholder")).toHaveValue("");
    expect(screen.getByPlaceholderText("working.descriptionPlaceholder")).toHaveValue("");
  });

  it("blocks unvalidated mutations and retains the draft after a failed commit", async () => {
    const onCommit = vi.fn(async () => false);
    const panelProps = props({ onCommit, validated: false });
    const view = render(<WorkingChangesPanel {...panelProps} />);
    fireEvent.change(screen.getByPlaceholderText("working.summaryPlaceholder"), {
      target: { value: "Keep me" },
    });

    expect(screen.getByRole("button", { name: "working.stageAll" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Commit 1" })).toBeDisabled();
    view.rerender(<WorkingChangesPanel {...panelProps} validated />);
    fireEvent.keyDown(screen.getByPlaceholderText("working.summaryPlaceholder"), {
      key: "Enter",
      ctrlKey: true,
    });

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("Keep me"));
    expect(screen.getByPlaceholderText("working.summaryPlaceholder")).toHaveValue("Keep me");
  });
});
