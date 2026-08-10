import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepositorySnapshotMarker } from "@/presentation/RepoDetailView";
import { WorkingChangesPanel } from "@/presentation/WorkingChangesPanel";
import type { WorkingChanges } from "@/domain/git";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === "snapshot.stale") return `Saved at ${values?.time}; checking live state`;
      if (key.startsWith("working.commit")) return `Commit ${values?.count ?? 0}`;
      return key;
    },
  }),
}));

const changes: WorkingChanges = {
  staged: [{ path: "README.md", changeType: "modified", conflicted: false }],
  unstaged: [],
};

describe("repository snapshot UI", () => {
  it("keeps the staleness marker visible until live validation completes", () => {
    const { rerender } = render(
      <RepositorySnapshotMarker validated={false} capturedAt="2026-08-10T10:00:00Z" />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/checking live state/i);

    rerender(
      <RepositorySnapshotMarker validated capturedAt="2026-08-10T10:00:00Z" />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not make commit available while working changes are unvalidated", () => {
    const props = {
      changes,
      loading: false,
      error: null,
      busy: false,
      selectedFile: null,
      onSelectFile: vi.fn(),
      onStage: vi.fn(),
      onUnstage: vi.fn(),
      onCommit: vi.fn(async () => true),
    };
    const { rerender } = render(<WorkingChangesPanel {...props} validated={false} />);
    fireEvent.change(screen.getByPlaceholderText("working.summaryPlaceholder"), {
      target: { value: "Snapshot-safe commit" },
    });

    expect(screen.getByRole("button", { name: "Commit 1" })).toBeDisabled();

    rerender(<WorkingChangesPanel {...props} validated />);
    expect(screen.getByRole("button", { name: "Commit 1" })).toBeEnabled();
  });
});
