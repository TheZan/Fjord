import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutBranch, discardPatch, runPushRepo, stagePatch, unstagePatch } from "@/infrastructure/tauriClient";
import { invalidateRepoData } from "@/application/invalidateRepoData";
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
  stagePatch: vi.fn(async () => ({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 })),
  unstagePatch: vi.fn(async () => ({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 })),
  discardPatch: vi.fn(async () => ({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 })),
}));

vi.mock("@/presentation/RepoDetailView", () => ({
  RepoDetailView: ({
    actionConfirmation,
    onAction,
    onCheckout,
    onConfirmAction,
    onApplyHunk,
    onDiscardPatch,
  }: {
    actionConfirmation: { kind: string; branch?: string } | null;
    onAction: (action: "push") => void;
    onCheckout: (branch: string) => void;
    onConfirmAction: () => void;
    onApplyHunk: (selection: import("@/domain/git").PatchSelection, generations: import("@/domain/git").GenerationSet) => Promise<boolean>;
    onDiscardPatch: (
      action: import("@/domain/git").DestructiveAction,
      selection: import("@/domain/git").PatchSelection,
      generations: import("@/domain/git").GenerationSet,
      confirmationToken: string,
    ) => Promise<boolean>;
  }) => (
    <div>
      <button type="button" onClick={() => onCheckout("origin/feature")}>remote checkout</button>
      <button type="button" onClick={() => onAction("push")}>push</button>
      <button type="button" onClick={() => void onApplyHunk({ path: "file.txt", source: "worktree", baseDigest: "digest", hunks: [] }, { workingTree: 4, refs: 2, history: 1, stash: 0, config: 0 })}>stage hunk</button>
      <button type="button" onClick={() => void onApplyHunk({ path: "file.txt", source: "index", baseDigest: "digest", hunks: [] }, { workingTree: 4, refs: 2, history: 1, stash: 0, config: 0 })}>unstage lines</button>
      <button type="button" onClick={() => void onDiscardPatch(
        { kind: "discard", selection: { kind: "lines", path: "file.txt", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [0] } },
        { path: "file.txt", source: "worktree", baseDigest: "digest", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [0] }] },
        { workingTree: 4, refs: 2, history: 1, stash: 0, config: 0 },
        "confirmation-token",
      )}>discard lines</button>
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
    vi.mocked(stagePatch).mockReset();
    vi.mocked(stagePatch).mockResolvedValue({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 });
    vi.mocked(unstagePatch).mockReset();
    vi.mocked(unstagePatch).mockResolvedValue({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 });
    vi.mocked(discardPatch).mockReset();
    vi.mocked(discardPatch).mockResolvedValue({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 });
    vi.mocked(invalidateRepoData).mockClear();
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

  it("refreshes rather than retrying a stale hunk selection", async () => {
    vi.mocked(stagePatch).mockRejectedValue({ code: "patch_stale" });
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "stage hunk" }));

    await waitFor(() => expect(stagePatch).toHaveBeenCalledOnce());
    await waitFor(() => expect(invalidateRepoData).toHaveBeenCalledWith(
      expect.anything(), "repo-1", "workspace-1", ["status", "working"],
    ));
    expect(stagePatch).toHaveBeenCalledOnce();
  });

  it("refreshes working state after successful stage and unstage patch mutations", async () => {
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "stage hunk" }));
    await waitFor(() => expect(stagePatch).toHaveBeenCalledOnce());
    await waitFor(() => expect(invalidateRepoData).toHaveBeenCalledWith(
      expect.anything(), "repo-1", "workspace-1", ["status", "working"],
    ));

    vi.mocked(invalidateRepoData).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "unstage lines" }));
    await waitFor(() => expect(unstagePatch).toHaveBeenCalledOnce());
    await waitFor(() => expect(invalidateRepoData).toHaveBeenCalledWith(
      expect.anything(), "repo-1", "workspace-1", ["status", "working"],
    ));
  });

  it.each(["preflight_stale", "patch_stale"])("refreshes and never retries discard after %s", async (code) => {
    vi.mocked(discardPatch).mockRejectedValue({ code });
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "discard lines" }));

    await waitFor(() => expect(discardPatch).toHaveBeenCalledOnce());
    expect(discardPatch).toHaveBeenCalledWith(
      "repo-1",
      {
        kind: "discard",
        selection: {
          kind: "lines",
          path: "file.txt",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [0],
        },
      },
      {
        path: "file.txt",
        source: "worktree",
        baseDigest: "digest",
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [0] }],
      },
      { workingTree: 4, refs: 2, history: 1, stash: 0, config: 0 },
      "confirmation-token",
    );
    await waitFor(() => expect(invalidateRepoData).toHaveBeenCalledWith(
      expect.anything(), "repo-1", "workspace-1", ["status", "working"],
    ));
    expect(discardPatch).toHaveBeenCalledOnce();
  });

  it("refreshes repository state after successful discard", async () => {
    renderContainer();
    fireEvent.click(screen.getByRole("button", { name: "discard lines" }));

    await waitFor(() => expect(discardPatch).toHaveBeenCalledOnce());
    await waitFor(() => expect(invalidateRepoData).toHaveBeenCalledWith(
      expect.anything(), "repo-1", "workspace-1", ["status", "working"],
    ));
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
