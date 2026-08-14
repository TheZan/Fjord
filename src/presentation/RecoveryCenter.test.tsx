import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecoveryDiff, useReflog } from "@/application/useReflog";
import type { ReflogEntry } from "@/domain/git";
import { RecoveryCenter } from "@/presentation/RecoveryCenter";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

vi.mock("@/application/useReflog", () => ({
  useReflog: vi.fn(),
  useRecoveryDiff: vi.fn(),
}));

const entry: ReflogEntry = {
  index: 0,
  oldId: "1111111111111111111111111111111111111111",
  newId: "2222222222222222222222222222222222222222",
  committerName: "Ada",
  timestamp: "2026-08-14T10:00:00Z",
  operation: "reset",
  message: "moving to HEAD~1",
  commit: {
    id: "2222222222222222222222222222222222222222",
    parentIds: [],
    message: "Known good state",
    authorName: "Ada",
    authorEmail: "ada@example.test",
    authoredAt: "2026-08-14T10:00:00Z",
    refs: [],
  },
};

const repo = {
  id: "repo-1",
  workspaceId: "workspace-1",
  name: "Fjord",
  path: "/dev/fjord",
  sortOrder: 0,
};

function props() {
  return {
    repo,
    ready: true,
    actionPending: null,
    actionError: null,
    actionSuccess: null,
    onBack: vi.fn(),
    onCreateBranch: vi.fn(),
    onRestore: vi.fn(),
  };
}

describe("RecoveryCenter", () => {
  beforeEach(() => {
    vi.mocked(useReflog).mockReturnValue({
      entries: [entry],
      refs: ["refs/heads/main"],
      loading: false,
      loadingMore: false,
      hasMore: false,
      loadMore: vi.fn(),
      error: null,
    });
    vi.mocked(useRecoveryDiff).mockReturnValue({
      files: [{ path: "README.md", changeType: "modified", additions: 1, deletions: 1 }],
      loading: false,
      error: null,
    });
  });

  it.each([
    { loading: true, error: null, entries: [] as ReflogEntry[] },
    { loading: false, error: "read failed", entries: [] as ReflogEntry[] },
    { loading: false, error: null, entries: [] as ReflogEntry[] },
  ])("always explains reflog recovery limits", (state) => {
    vi.mocked(useReflog).mockReturnValue({
      ...state,
      refs: [],
      loadingMore: false,
      hasMore: false,
      loadMore: vi.fn(),
    });

    render(<RecoveryCenter {...props()} />);

    expect(screen.getByText("recovery.explanation")).toBeVisible();
  });

  it("lists the safe branch action first and routes restore through its owner", async () => {
    const viewProps = props();
    const { container } = render(<RecoveryCenter {...viewProps} />);
    const create = screen.getByRole("button", { name: "recovery.createBranch" });
    const restore = screen.getByRole("button", { name: "recovery.restore" });
    const copy = screen.getByRole("button", { name: "recovery.copySha" });

    expect(create.compareDocumentPosition(restore) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(restore.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(restore);
    expect(viewProps.onRestore).toHaveBeenCalledWith(entry.newId);

    fireEvent.click(create);
    fireEvent.change(screen.getByLabelText("context.branchName"), { target: { value: "rescue" } });
    fireEvent.click(screen.getByRole("button", { name: "context.create" }));
    expect(viewProps.onCreateBranch).toHaveBeenCalledWith("rescue", entry.newId);
    expect(screen.getByText("README.md")).toBeVisible();
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });
});
