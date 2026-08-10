import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutBranch } from "@/infrastructure/tauriClient";
import { RepoDetailContainer } from "@/presentation/RepoDetailContainer";
import type { RepositoryEntry } from "@/domain/workspace";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({}),
}));

vi.mock("@/application/useAutoFetch", () => ({
  useAutoFetch: () => ({ error: null }),
}));
vi.mock("@/application/useCommitLog", () => ({
  useCommitLog: () => ({ commits: [], loading: false }),
}));
vi.mock("@/application/useOperationProgress", () => ({
  useOperationProgress: () => ({}),
}));
vi.mock("@/application/useRepoStatus", () => ({
  useRepoStatus: () => ({
    status: { branch: "main", ahead: 0, behind: 0, dirtyCount: 0, hasConflict: false },
    error: null,
  }),
}));
vi.mock("@/application/useRepositorySnapshot", () => ({
  useRepositorySnapshot: () => ({
    ready: true,
    validated: true,
    capturedAt: null,
    ensureValidated: vi.fn(async () => true),
  }),
}));
vi.mock("@/application/useWorkingChanges", () => ({
  useWorkingChanges: () => ({
    changes: { staged: [], unstaged: [] },
    loading: false,
    error: null,
  }),
}));
vi.mock("@/application/invalidateRepoData", () => ({
  invalidateRepoData: vi.fn(async () => undefined),
}));
vi.mock("@/presentation/performance", () => ({
  useInteractionCommit: vi.fn(),
}));
vi.mock("@/infrastructure/tauriClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/infrastructure/tauriClient")>()),
  checkoutBranch: vi.fn(async () => undefined),
}));

vi.mock("@/presentation/RepoDetailView", () => ({
  RepoDetailView: ({
    actionConfirmation,
    onCheckout,
    onConfirmAction,
  }: {
    actionConfirmation: { kind: string; branch?: string } | null;
    onCheckout: (branch: string) => void;
    onConfirmAction: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => onCheckout("origin/feature")}>remote checkout</button>
      {actionConfirmation ? (
        <button type="button" onClick={onConfirmAction}>
          confirm {actionConfirmation.kind} {actionConfirmation.branch}
        </button>
      ) : null}
    </div>
  ),
}));

const repo: RepositoryEntry = {
  id: "repo-1",
  workspaceId: "workspace-1",
  name: "Fjord",
  path: "/dev/fjord",
  sortOrder: 0,
};

describe("RepoDetailContainer checkout confirmation", () => {
  beforeEach(() => {
    vi.mocked(checkoutBranch).mockClear();
  });

  it("requires confirmation before checking out an origin branch", async () => {
    render(
      <RepoDetailContainer
        repo={repo}
        autoFetch={false}
        command={null}
        onBack={vi.fn()}
        onOpenSearch={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "remote checkout" }));

    expect(checkoutBranch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "confirm remote-checkout origin/feature" }));
    await waitFor(() => expect(checkoutBranch).toHaveBeenCalledWith("repo-1", "origin/feature"));
  });
});
