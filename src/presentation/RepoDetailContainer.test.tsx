import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutBranch, runPushRepo } from "@/infrastructure/tauriClient";
import { RepoDetailContainer } from "@/presentation/RepoDetailContainer";
import type { RepositoryEntry } from "@/domain/workspace";

const snapshotMock = vi.hoisted(() => ({
  validated: true,
  ensureValidated: vi.fn<() => Promise<boolean>>(async () => true),
}));

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
    validated: snapshotMock.validated,
    capturedAt: null,
    ensureValidated: snapshotMock.ensureValidated,
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
  runPushRepo: vi.fn(() => ({ operationId: "operation-1", promise: Promise.resolve() })),
}));

vi.mock("@/presentation/RepoDetailView", () => ({
  RepoDetailView: ({
    actionConfirmation,
    onAction,
    onCheckout,
    onConfirmAction,
  }: {
    actionConfirmation: { kind: string; branch?: string } | null;
    onAction: (action: "push") => void;
    onCheckout: (branch: string) => void;
    onConfirmAction: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => onCheckout("origin/feature")}>remote checkout</button>
      <button type="button" onClick={() => onAction("push")}>push</button>
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
    vi.mocked(runPushRepo).mockClear();
    snapshotMock.validated = true;
    snapshotMock.ensureValidated.mockReset();
    snapshotMock.ensureValidated.mockResolvedValue(true);
  });

  it("requires confirmation before checking out an origin branch", async () => {
    render(
      <RepoDetailContainer
        repo={repo}
        autoFetch={false}
        command={null}
        onBack={vi.fn()}
        utilities={<div data-testid="shell-utilities" />}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "remote checkout" }));

    expect(checkoutBranch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "confirm remote-checkout origin/feature" }));
    await waitFor(() => expect(checkoutBranch).toHaveBeenCalledWith("repo-1", "origin/feature"));
  });

  it("does not create a network operation when snapshot revalidation fails", async () => {
    snapshotMock.validated = false;
    snapshotMock.ensureValidated.mockResolvedValue(false);
    const view = renderContainer();

    view.rerender(
      <RepoDetailContainer
        repo={repo}
        autoFetch={false}
        command={{ id: 1, kind: "repoAction", action: "push" }}
        onBack={vi.fn()}
        utilities={<div data-testid="shell-utilities" />}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^confirm origin/ }));

    await waitFor(() => expect(snapshotMock.ensureValidated).toHaveBeenCalledOnce());
    expect(runPushRepo).not.toHaveBeenCalled();
  });

  it("completes snapshot validation before creating a network operation", async () => {
    snapshotMock.validated = false;
    const order: string[] = [];
    snapshotMock.ensureValidated.mockImplementation(async () => {
      order.push("validated");
      return true;
    });
    vi.mocked(runPushRepo).mockImplementation(() => {
      order.push("operation-created");
      return { operationId: "operation-1", promise: Promise.resolve() };
    });
    const view = renderContainer();

    view.rerender(
      <RepoDetailContainer
        repo={repo}
        autoFetch={false}
        command={{ id: 2, kind: "repoAction", action: "push" }}
        onBack={vi.fn()}
        utilities={<div data-testid="shell-utilities" />}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^confirm origin/ }));

    await waitFor(() => expect(runPushRepo).toHaveBeenCalledOnce());
    expect(order).toEqual(["validated", "operation-created"]);
  });
});

function renderContainer() {
  return render(
    <RepoDetailContainer
      repo={repo}
      autoFetch={false}
      command={null}
      onBack={vi.fn()}
      utilities={<div data-testid="shell-utilities" />}
    />,
  );
}
