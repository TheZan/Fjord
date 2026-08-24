import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addIgnoreRule, checkoutBranch, createBranchAt, discardPatch, exportPatch, getWorkingFileDiffWithGenerations, preflightDestructiveAction, previewIgnoreRule, runCommitAndPushRepo, runContinueOperation, runExecuteDestructiveAction, runFetchRepo, runMergeBranch, runPublishBranch, runPushBranchToRemotes, runPushRepo, runSquashMergeBranch, runStashAndCheckout, stagePatch, unstagePatch } from "@/infrastructure/tauriClient";
import { pickSaveDestination } from "@/infrastructure/dialog";
import { invalidateRepoData } from "@/application/invalidateRepoData";
import { rejectWorkingDiffSnapshot } from "@/application/diffSnapshotAuthority";
import { RepoDetailContainer } from "@/presentation/RepoDetailContainer";
import type { RepositoryEntry } from "@/domain/workspace";

const snapshotMock = vi.hoisted(() => ({
  validated: true,
  ensureValidated: vi.fn<() => Promise<boolean>>(async () => true),
}));
const authorityMock = vi.hoisted(() => ({ rejected: false }));
const operationStateMock = vi.hoisted(() => ({
  state: {
    operation: { kind: "normal" as const },
    conflictedPaths: [],
    available: [],
    detectedExternally: false,
  } as import("@/domain/generated").RepoOperationState,
}));
const queryClientMock = vi.hoisted(() => ({
  setQueryData: vi.fn(),
  getQueryData: vi.fn(() => operationStateMock.state),
  invalidateQueries: vi.fn(async () => undefined),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => key === "checkoutOverwrite.stashed"
      ? `Your work is in ${values?.stashRef}.`
      : key,
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => queryClientMock,
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
vi.mock("@/application/useRepoOperationState", () => ({
  useRepoOperationState: () => ({ state: operationStateMock.state, loading: false, error: null }),
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
vi.mock("@/application/useDiffToolAvailability", () => ({
  useDiffToolAvailability: () => true,
}));
vi.mock("@/application/useStashFileSupported", () => ({
  useStashFileSupported: () => true,
}));
vi.mock("@/application/invalidateRepoData", () => ({
  invalidateRepoData: vi.fn(async () => undefined),
}));
vi.mock("@/application/diffSnapshotAuthority", () => ({
  isWorkingDiffSnapshotRejected: vi.fn(() => authorityMock.rejected),
  rejectWorkingDiffSnapshot: vi.fn(() => { authorityMock.rejected = true; }),
}));
vi.mock("@/presentation/performance", () => ({
  useInteractionCommit: vi.fn(),
}));
vi.mock("@/infrastructure/tauriClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/infrastructure/tauriClient")>()),
  checkoutBranch: vi.fn(async () => undefined),
  previewIgnoreRule: vi.fn(async () => ({ rule: "*.log", alreadyPresent: false })),
  addIgnoreRule: vi.fn(async () => "added" as const),
  createBranchAt: vi.fn(async () => undefined),
  runPushRepo: vi.fn(() => ({ operationId: "operation-1", promise: Promise.resolve() })),
  runPublishBranch: vi.fn(() => ({ operationId: "publish-1", promise: Promise.resolve() })),
  runPushBranchToRemotes: vi.fn(() => ({
    operationId: "push-remotes-1",
    promise: Promise.resolve([
      { remote: "origin", ok: true, errorCode: null },
      { remote: "gitlab", ok: true, errorCode: null },
    ]),
  })),
  runContinueOperation: vi.fn(() => ({
    operationId: "operation-continue",
    promise: Promise.resolve({
      operation: { kind: "normal" },
      conflictedPaths: [],
      available: [],
      detectedExternally: false,
    }),
  })),
  runExecuteDestructiveAction: vi.fn(() => ({
    operationId: "operation-destructive",
    promise: Promise.resolve(null),
  })),
  runStashAndCheckout: vi.fn(() => ({
    operationId: "operation-stash-checkout",
    promise: Promise.resolve("stash@{0}"),
  })),
  runMergeBranch: vi.fn(() => ({
    operationId: "operation-merge",
    promise: Promise.resolve({
      outcome: {
        kind: "conflicted",
        state: {
          operation: { kind: "merge", head: "abc", incoming: ["def"] },
          conflictedPaths: ["src/conflict.ts"],
          available: ["abort"],
          detectedExternally: false,
        },
      },
      source: { refName: "refs/heads/feature", kind: "localBranch" },
      sourceLabel: "feature",
      targetBranch: "main",
      stashRef: null,
      generations: { workingTree: 2, refs: 2, history: 2, stash: 0, config: 0 },
    }),
  })),
  runFetchRepo: vi.fn(() => ({ operationId: "operation-fetch", promise: Promise.resolve() })),
  runSquashMergeBranch: vi.fn(() => ({
    operationId: "operation-squash-merge",
    promise: Promise.resolve({
      outcome: { kind: "staged", message: "Squash of feature\n\nDetails" },
      source: { refName: "refs/heads/feature", kind: "localBranch" },
      sourceLabel: "feature",
      targetBranch: "main",
      targetCommit: "target-commit",
      stashRef: null,
      generations: { workingTree: 2, refs: 1, history: 1, stash: 0, config: 0 },
    }),
  })),
  runCommitAndPushRepo: vi.fn(() => ({
    operationId: "operation-commit-push",
    promise: Promise.resolve({
      commitId: "abc123",
      commitSucceeded: true,
      pushSucceeded: true,
      pushErrorCode: null,
    }),
  })),
  stagePatch: vi.fn(async () => ({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 })),
  unstagePatch: vi.fn(async () => ({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 })),
  discardPatch: vi.fn(async () => ({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 })),
  getWorkingFileDiffWithGenerations: vi.fn(async () => ({
    generations: { workingTree: 4, refs: 2, history: 1, stash: 0, config: 0 },
    data: {
      path: "file.txt",
      changeType: "modified",
      oldMode: 33188,
      newMode: 33188,
      isBinary: false,
      tooLarge: false,
      fileBytes: 10,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }],
      totalHunks: 1,
      totalLines: 1,
      offset: 0,
      truncated: false,
      nextOffset: null,
      baseDigest: "whole-file-digest",
    },
  })),
  preflightDestructiveAction: vi.fn(),
  exportPatch: vi.fn(async () => undefined),
  getPatchText: vi.fn(async () => "patch text"),
}));

vi.mock("@/infrastructure/dialog", () => ({
  pickSaveDestination: vi.fn(async () => "C:\\Users\\me\\file.txt.patch"),
}));

vi.mock("@/presentation/RepoDetailView", () => ({
  RepoDetailView: ({
    actionConfirmation,
    onAction,
    onCheckout,
    onConfirmAction,
    onApplyHunk,
    onDiscardPatch,
    onCommit,
    actionPending,
    actionError,
    actionSuccess,
    operationState,
    onOperationControl,
    onOpenRecoveryCenter,
    onPublishBranch,
    onPushToRemotes,
    onMergeBranch,
    onSquashMergeBranch,
    onWorkingFileAction,
    pendingDraftMessage,
  }: {
    actionConfirmation: { kind: string; branch?: string } | null;
    onAction: (action: "push" | "stash-pop") => void;
    onCheckout: (branch: string) => void;
    onConfirmAction: () => void;
    onApplyHunk: (selection: import("@/domain/git").PatchSelection, generations: import("@/domain/git").GenerationSet) => Promise<boolean>;
    onDiscardPatch: (
      action: import("@/domain/git").DestructiveAction,
      selection: import("@/domain/git").PatchSelection,
      generations: import("@/domain/git").GenerationSet,
      confirmationToken: string,
    ) => Promise<boolean>;
    onCommit: (message: string, amend: boolean, push: boolean) => Promise<boolean>;
    actionPending: string | null;
    actionError: string | null;
    actionSuccess: string | null;
    operationState: import("@/domain/generated").RepoOperationState | null;
    onOperationControl: (control: import("@/domain/generated").OperationControl) => void;
    onOpenRecoveryCenter: () => void;
    onPublishBranch: (branch: string) => void;
    onPushToRemotes: (remotes: string[]) => Promise<import("@/domain/workspace").RemotePushResult[] | null>;
    onMergeBranch: (source: import("@/domain/git").MergeSource) => void;
    onSquashMergeBranch: (source: import("@/domain/git").MergeSource) => void;
    onWorkingFileAction: (
      action: import("@/application/useWorkingFileActions").WorkingFileAction,
      target: import("@/domain/git").WorkingFileTarget,
    ) => void;
    pendingDraftMessage: string | null;
  }) => (
    <div>
      <output data-testid="action-pending">{actionPending ?? ""}</output>
      <output data-testid="pending-draft-message">{pendingDraftMessage ?? ""}</output>
      <output data-testid="action-error">{actionError ?? ""}</output>
      <output data-testid="action-success">{actionSuccess ?? ""}</output>
      <button type="button" onClick={() => onCheckout("feature")}>local checkout</button>
      <button type="button" onClick={() => onCheckout("origin/feature")}>remote checkout</button>
      <button type="button" onClick={() => onAction("push")}>push</button>
      <button type="button" onClick={() => onPublishBranch("main")}>push and set upstream</button>
      <button type="button" onClick={() => void onPushToRemotes(["origin", "gitlab"])}>push to remotes</button>
      <button type="button" onClick={() => onAction("stash-pop")}>stash pop</button>
      <button type="button" onClick={() => onMergeBranch({ refName: "refs/heads/feature", kind: "localBranch" })}>merge feature</button>
      <button type="button" onClick={() => onMergeBranch({ refName: "refs/remotes/origin/feature", kind: "remoteTracking" })}>merge remote feature</button>
      <button type="button" onClick={() => onSquashMergeBranch({ refName: "refs/heads/feature", kind: "localBranch" })}>squash merge feature</button>
      <button type="button" onClick={() => onWorkingFileAction("discard", { path: "file.txt", source: "worktree" })}>discard working file</button>
      <button type="button" onClick={() => onWorkingFileAction("ignoreExtension", { path: "logs/debug.log", source: "worktree" })}>ignore log files</button>
      <button type="button" onClick={() => onWorkingFileAction("createPatch", { path: "file.txt", source: "worktree" })}>create patch</button>
      <button type="button" onClick={onOpenRecoveryCenter}>open recovery</button>
      <button type="button" onClick={() => void onApplyHunk({ path: "file.txt", source: "worktree", baseDigest: "digest", hunks: [] }, { workingTree: 4, refs: 2, history: 1, stash: 0, config: 0 })}>stage hunk</button>
      <button type="button" onClick={() => void onApplyHunk({ path: "file.txt", source: "index", baseDigest: "digest", hunks: [] }, { workingTree: 4, refs: 2, history: 1, stash: 0, config: 0 })}>unstage lines</button>
      <button type="button" onClick={() => void onDiscardPatch(
        { kind: "discard", selection: { kind: "lines", path: "file.txt", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [0] } },
        { path: "file.txt", source: "worktree", baseDigest: "digest", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [0] }] },
        { workingTree: 4, refs: 2, history: 1, stash: 0, config: 0 },
        "confirmation-token",
      )}>discard lines</button>
      <button type="button" onClick={() => void onCommit("Ship it", false, true)}>commit and push</button>
      {operationState?.operation.kind !== "normal" ? (
        <>
          <button type="button" onClick={() => onOperationControl("continue")}>continue operation</button>
          <button type="button" onClick={() => onOperationControl("abort")}>abort operation</button>
        </>
      ) : null}
      {actionConfirmation ? (
        <button type="button" onClick={onConfirmAction}>
          confirm {actionConfirmation.kind} {actionConfirmation.branch}
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("@/presentation/MergeDialog", () => ({
  MergeDialog: ({ onConfirm }: {
    onConfirm: (
      mode: import("@/domain/git").MergeMode,
      policy: import("@/domain/git").MergeDirtyPolicy,
      fetchFirst: boolean,
    ) => void;
  }) => (
    <>
      <button type="button" onClick={() => onConfirm("default", "refuse", false)}>confirm merge</button>
      <button type="button" onClick={() => onConfirm("default", "refuse", true)}>confirm merge with fetch</button>
    </>
  ),
}));

vi.mock("@/presentation/SquashMergeDialog", () => ({
  SquashMergeDialog: ({ onConfirm }: {
    onConfirm: (policy: import("@/domain/git").MergeDirtyPolicy) => void;
  }) => <button type="button" onClick={() => onConfirm("refuse")}>confirm squash merge</button>,
}));

vi.mock("@/presentation/RecoveryCenter", () => ({
  RecoveryCenter: ({ onBack, onCreateBranch, onRestore }: {
    onBack: () => void;
    onCreateBranch: (name: string, commitId: string) => void;
    onRestore: (commitId: string) => void;
  }) => (
    <div>
      <button type="button" onClick={onBack}>close recovery</button>
      <button type="button" onClick={() => onCreateBranch("rescue", "deadbeef")}>recovery branch</button>
      <button type="button" onClick={() => onRestore("deadbeef")}>recovery restore</button>
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
    vi.mocked(previewIgnoreRule).mockClear();
    vi.mocked(addIgnoreRule).mockReset();
    vi.mocked(addIgnoreRule).mockResolvedValue("added");
    vi.mocked(createBranchAt).mockClear();
    vi.mocked(runPushRepo).mockClear();
    vi.mocked(runPublishBranch).mockReset();
    vi.mocked(runPublishBranch).mockReturnValue({
      operationId: "publish-1",
      promise: Promise.resolve(),
    });
    vi.mocked(runPushBranchToRemotes).mockClear();
    vi.mocked(runContinueOperation).mockClear();
    vi.mocked(runStashAndCheckout).mockReset();
    vi.mocked(runStashAndCheckout).mockReturnValue({
      operationId: "operation-stash-checkout",
      promise: Promise.resolve("stash@{0}"),
    });
    vi.mocked(runMergeBranch).mockClear();
    vi.mocked(runSquashMergeBranch).mockClear();
    vi.mocked(runFetchRepo).mockReset();
    vi.mocked(runFetchRepo).mockReturnValue({
      operationId: "operation-fetch",
      promise: Promise.resolve(),
    });
    vi.mocked(runExecuteDestructiveAction).mockReset();
    vi.mocked(runExecuteDestructiveAction).mockReturnValue({
      operationId: "operation-destructive",
      promise: Promise.resolve(null),
    });
    vi.mocked(runCommitAndPushRepo).mockReset();
    vi.mocked(runCommitAndPushRepo).mockReturnValue({
      operationId: "operation-commit-push",
      promise: Promise.resolve({
        commitId: "abc123",
        commitSucceeded: true,
        pushSucceeded: true,
        pushErrorCode: null,
      }),
    });
    vi.mocked(stagePatch).mockReset();
    vi.mocked(stagePatch).mockResolvedValue({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 });
    vi.mocked(unstagePatch).mockReset();
    vi.mocked(unstagePatch).mockResolvedValue({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 });
    vi.mocked(discardPatch).mockReset();
    vi.mocked(discardPatch).mockResolvedValue({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 });
    vi.mocked(getWorkingFileDiffWithGenerations).mockClear();
    vi.mocked(preflightDestructiveAction).mockReset();
    vi.mocked(invalidateRepoData).mockClear();
    vi.mocked(rejectWorkingDiffSnapshot).mockClear();
    authorityMock.rejected = false;
    operationStateMock.state = {
      operation: { kind: "normal" },
      conflictedPaths: [],
      available: [],
      detectedExternally: false,
    };
    queryClientMock.setQueryData.mockClear();
    queryClientMock.getQueryData.mockClear();
    snapshotMock.validated = true;
    snapshotMock.ensureValidated.mockReset();
    snapshotMock.ensureValidated.mockResolvedValue(true);
  });

  it("requires confirmation before checking out an origin branch", async () => {
    render(
      <RepoDetailContainer
        repo={repo}
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

  it("publishes explicitly and refreshes upstream state after success", async () => {
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "push and set upstream" }));
    expect(runPublishBranch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "confirm publish main" }));

    await waitFor(() => expect(runPublishBranch).toHaveBeenCalledWith("repo-1"));
    await waitFor(() => expect(invalidateRepoData).toHaveBeenCalledWith(
      queryClientMock,
      "repo-1",
      "workspace-1",
      ["status", "refs"],
    ));
  });

  it("pushes the current branch to explicitly selected remotes", async () => {
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "push to remotes" }));

    await waitFor(() => expect(runPushBranchToRemotes).toHaveBeenCalledWith(
      "repo-1",
      ["origin", "gitlab"],
    ));
    await waitFor(() => expect(invalidateRepoData).toHaveBeenCalledWith(
      queryClientMock,
      "repo-1",
      "workspace-1",
      ["status", "refs"],
    ));
  });

  it("offers safe checkout recovery and reports the retained stash exactly", async () => {
    vi.mocked(checkoutBranch).mockRejectedValueOnce({
      code: "checkout_would_overwrite",
      paths: ["src/main.rs"],
    });
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "local checkout" }));

    expect(await screen.findByRole("dialog", { name: "checkoutOverwrite.title" })).toBeInTheDocument();
    expect(screen.getByText("src/main.rs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "checkoutOverwrite.stash" }));

    await waitFor(() => expect(runStashAndCheckout).toHaveBeenCalledWith("repo-1", "feature"));
    expect(await screen.findByText("Your work is in stash@{0}.")).toBeInTheDocument();
  });

  it("routes safe-checkout discard through the shared preflight", async () => {
    const action = { kind: "checkoutDiscard" as const, branch: "feature" };
    vi.mocked(checkoutBranch).mockRejectedValueOnce({
      code: "checkout_would_overwrite",
      paths: ["src/main.rs"],
    });
    vi.mocked(preflightDestructiveAction).mockResolvedValue(actionPreflight(action, "checkout-token"));
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "local checkout" }));
    fireEvent.click(await screen.findByRole("button", { name: "checkoutOverwrite.discard" }));

    expect(await screen.findByRole("dialog", { name: "preflight.checkoutDiscard.title" })).toBeInTheDocument();
    expect(preflightDestructiveAction).toHaveBeenCalledWith("repo-1", action, null);
  });

  it("does not create a network operation when snapshot revalidation fails", async () => {
    snapshotMock.validated = false;
    snapshotMock.ensureValidated.mockResolvedValue(false);
    const view = renderContainer();

    view.rerender(
      <RepoDetailContainer
        repo={repo}
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
        command={{ id: 2, kind: "repoAction", action: "push" }}
        onBack={vi.fn()}
        utilities={<div data-testid="shell-utilities" />}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^confirm origin/ }));

    await waitFor(() => expect(runPushRepo).toHaveBeenCalledOnce());
    expect(order).toEqual(["validated", "operation-created"]);
  });

  it("offers force-with-lease only after a non-fast-forward push and executes the confirmed lease", async () => {
    vi.mocked(runPushRepo)
      .mockImplementationOnce(() => ({ operationId: "push-1", promise: Promise.reject({ code: "git_non_fast_forward" }) }))
      .mockReturnValueOnce({ operationId: "push-2", promise: Promise.resolve() });
    vi.mocked(preflightDestructiveAction)
      .mockResolvedValueOnce(forcePreflight("token-1"))
      .mockResolvedValueOnce(forcePreflight("token-2"));
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "push" }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm origin/ }));

    expect(await screen.findByText("preflight.forceWithLease.title")).toBeInTheDocument();
    expect(preflightDestructiveAction).toHaveBeenCalledWith("repo-1", { kind: "forceWithLease" }, null);
    await waitFor(() => expect(screen.getByTestId("action-pending").textContent).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "preflight.forceWithLease.confirm" }));

    await waitFor(() => expect(runPushRepo).toHaveBeenLastCalledWith(
      "repo-1",
      true,
      { workingTree: 1, refs: 2, history: 3, stash: 0, config: 0 },
      "token-2",
    ));
  });

  it("does not offer force-with-lease for other push failures", async () => {
    vi.mocked(runPushRepo).mockImplementationOnce(() => ({
      operationId: "push-1",
      promise: Promise.reject({ code: "git_remote_rejected" }),
    }));
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "push" }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm origin/ }));

    await waitFor(() => expect(runPushRepo).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId("action-pending").textContent).toBe(""));
    expect(screen.queryByText("preflight.forceWithLease.title")).not.toBeInTheDocument();
    expect(preflightDestructiveAction).not.toHaveBeenCalled();
  });

  it("routes stash pop through fresh shared preflight facts and the bound executor", async () => {
    const action = { kind: "stashPop" as const, index: 0 };
    vi.mocked(preflightDestructiveAction)
      .mockResolvedValueOnce(actionPreflight(action, "stash-token-1"))
      .mockResolvedValueOnce(actionPreflight(action, "stash-token-2"));
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "stash pop" }));
    expect(await screen.findByText("preflight.stashPop.title")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "preflight.stashPop.confirm" }));

    await waitFor(() => expect(runExecuteDestructiveAction).toHaveBeenCalledWith(
      "repo-1",
      action,
      { workingTree: 1, refs: 2, history: 3, stash: 0, config: 0 },
      "stash-token-2",
    ));
    expect(invalidateRepoData).toHaveBeenCalledWith(
      expect.anything(),
      "repo-1",
      "workspace-1",
      ["status", "working", "stashes"],
    );
  });

  it("creates a recovery branch without checking it out", async () => {
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "open recovery" }));
    fireEvent.click(screen.getByRole("button", { name: "recovery branch" }));

    await waitFor(() => expect(createBranchAt).toHaveBeenCalledWith(
      "repo-1",
      "rescue",
      "deadbeef",
      false,
    ));
    expect(invalidateRepoData).toHaveBeenCalledWith(
      expect.anything(),
      "repo-1",
      "workspace-1",
      ["refs", "history", "reflog"],
    );
  });

  it("routes Recovery Center restore through shared preflight and exact execution", async () => {
    const action = { kind: "recoveryRestore" as const, commitId: "deadbeef" };
    vi.mocked(preflightDestructiveAction)
      .mockResolvedValueOnce(actionPreflight(action, "recovery-token-1"))
      .mockResolvedValueOnce(actionPreflight(action, "recovery-token-2"));
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "open recovery" }));
    fireEvent.click(screen.getByRole("button", { name: "recovery restore" }));
    expect(await screen.findByText("preflight.recoveryRestore.title")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "preflight.recoveryRestore.confirm" }));

    await waitFor(() => expect(runExecuteDestructiveAction).toHaveBeenCalledWith(
      "repo-1",
      action,
      { workingTree: 1, refs: 2, history: 3, stash: 0, config: 0 },
      "recovery-token-2",
    ));
    expect(invalidateRepoData).toHaveBeenCalledWith(
      expect.anything(),
      "repo-1",
      "workspace-1",
      ["status", "working", "history", "refs", "reflog"],
    );
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

  it("routes context-menu whole-file discard through the shared token preflight", async () => {
    const action = { kind: "discard" as const, selection: { kind: "file" as const, path: "file.txt" } };
    vi.mocked(preflightDestructiveAction)
      .mockResolvedValueOnce(actionPreflight(action, "discard-file-token-1"))
      .mockResolvedValueOnce(actionPreflight(action, "discard-file-token-2"));
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "discard working file" }));
    expect(await screen.findByRole("dialog", { name: "preflight.discard.title" })).toBeInTheDocument();
    expect(discardPatch).not.toHaveBeenCalled();
    expect(preflightDestructiveAction).toHaveBeenCalledWith(
      "repo-1",
      action,
      expect.objectContaining({
        path: "file.txt",
        source: "worktree",
        baseDigest: "whole-file-digest",
      }),
    );

    const confirm = screen.getByRole("button", { name: "preflight.discard.confirm" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(discardPatch).toHaveBeenCalledWith(
      "repo-1",
      action,
      expect.objectContaining({ baseDigest: "whole-file-digest" }),
      { workingTree: 1, refs: 2, history: 3, stash: 0, config: 0 },
      "discard-file-token-2",
    ));
  });

  it("previews an ignore rule before the validated mutation and refreshes working state", async () => {
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "ignore log files" }));

    expect(await screen.findByText("*.log")).toBeInTheDocument();
    expect(previewIgnoreRule).toHaveBeenCalledWith("repo-1", "logs/debug.log", "extension");
    expect(addIgnoreRule).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "workingFile.ignore.confirm" }));

    await waitFor(() => expect(addIgnoreRule).toHaveBeenCalledWith(
      "repo-1",
      "logs/debug.log",
      "extension",
    ));
    await waitFor(() => expect(invalidateRepoData).toHaveBeenCalledWith(
      expect.anything(),
      "repo-1",
      "workspace-1",
      ["status", "working"],
    ));
    expect(await screen.findByText("workingFile.ignore.added")).toBeInTheDocument();
  });

  it("exports a whole-file patch to the picked destination and reports where it was saved", async () => {
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "create patch" }));

    await waitFor(() => expect(exportPatch).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ path: "file.txt", source: "worktree", baseDigest: "whole-file-digest" }),
      "C:\\Users\\me\\file.txt.patch",
    ));
    expect(pickSaveDestination).toHaveBeenCalledWith("file.txt.patch");
    expect(await screen.findByTestId("action-success")).toHaveTextContent(
      "workingFile.patchSaved",
    );
  });

  it("does not submit a second patch mutation from rapid clicks", async () => {
    let resolveMutation!: () => void;
    vi.mocked(stagePatch).mockImplementationOnce(() => new Promise((resolve) => { resolveMutation = () => resolve({ workingTree: 5, refs: 2, history: 1, stash: 0, config: 0 }); }));
    renderContainer();

    const stage = screen.getByRole("button", { name: "stage hunk" });
    fireEvent.click(stage);
    fireEvent.click(stage);
    expect(stagePatch).toHaveBeenCalledOnce();

    resolveMutation();
    await waitFor(() => expect(invalidateRepoData).toHaveBeenCalledOnce());
  });

  it.each(["patch_stale", "patch_apply_failed"])('keeps a rejected patch snapshot disabled when refresh completes without a new diff after %s', async (code) => {
    vi.mocked(stagePatch).mockRejectedValue({ code });
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "stage hunk" }));

    await waitFor(() => expect(rejectWorkingDiffSnapshot).toHaveBeenCalledWith(
      expect.anything(), "repo-1", "file.txt", "worktree",
    ));
    expect(stagePatch).toHaveBeenCalledOnce();
    await waitFor(() => expect(invalidateRepoData).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "stage hunk" }));
    expect(stagePatch).toHaveBeenCalledOnce();
  });

  it("does not reopen a preflight on the rejected snapshot after refresh failure", async () => {
    vi.mocked(invalidateRepoData).mockRejectedValueOnce(new Error("refresh failed"));
    vi.mocked(discardPatch).mockRejectedValue({ code: "preflight_stale" });
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "discard lines" }));

    await waitFor(() => expect(discardPatch).toHaveBeenCalledOnce());
    await waitFor(() => expect(rejectWorkingDiffSnapshot).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "discard lines" }));
    expect(discardPatch).toHaveBeenCalledOnce();
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

  it.each(["preflight_stale", "patch_stale", "patch_apply_failed"])("refreshes and never retries discard after %s", async (code) => {
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

  it("reports a surviving commit distinctly when its push fails", async () => {
    vi.mocked(runCommitAndPushRepo).mockReturnValue({
      operationId: "operation-commit-push",
      promise: Promise.resolve({
        commitId: "abc123",
        commitSucceeded: true,
        pushSucceeded: false,
        pushErrorCode: "git_remote_rejected",
      }),
    });
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "commit and push" }));

    await waitFor(() => expect(runCommitAndPushRepo).toHaveBeenCalledWith("repo-1", "Ship it", false));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent("working.commitPushFailed"));
    expect(invalidateRepoData).toHaveBeenCalledWith(
      expect.anything(), "repo-1", "workspace-1", ["status", "working", "history", "refs"],
    );
  });

  it("runs an operation control and publishes its returned state before invalidation", async () => {
    operationStateMock.state = {
      operation: {
        kind: "rebase",
        rebaseKind: "merge",
        onto: "base",
        current: 1,
        total: 2,
        headName: "refs/heads/topic",
      },
      conflictedPaths: [],
      available: ["continue", "skip", "abort"],
      detectedExternally: true,
    };
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "continue operation" }));

    await waitFor(() => expect(runContinueOperation).toHaveBeenCalledWith("repo-1"));
    expect(queryClientMock.setQueryData).toHaveBeenCalledWith(
      ["repos", "repo-1", "operationState"],
      {
        operation: { kind: "normal" },
        conflictedPaths: [],
        available: [],
        detectedExternally: false,
      },
    );
    expect(invalidateRepoData).toHaveBeenCalledWith(
      expect.anything(),
      "repo-1",
      "workspace-1",
      ["status", "operation", "working", "history", "refs"],
    );
  });

  it("publishes a conflicted merge result directly to the operation banner cache", async () => {
    renderContainer();
    fireEvent.click(screen.getByRole("button", { name: "merge feature" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm merge" }));

    await waitFor(() => expect(runMergeBranch).toHaveBeenCalledWith(
      "repo-1",
      { refName: "refs/heads/feature", kind: "localBranch" },
      "default",
      "refuse",
    ));
    expect(queryClientMock.setQueryData).toHaveBeenCalledWith(
      ["repos", "repo-1", "operationState"],
      expect.objectContaining({
        operation: { kind: "merge", head: "abc", incoming: ["def"] },
        conflictedPaths: ["src/conflict.ts"],
      }),
    );
  });

  it("reports a retained merge stash even when the operation is cancelled", async () => {
    vi.mocked(runMergeBranch).mockReturnValueOnce({
      operationId: "operation-merge",
      promise: Promise.reject({ code: "operation_cancelled", stash_ref: "stash@{0}" }),
    });
    renderContainer();
    fireEvent.click(screen.getByRole("button", { name: "merge feature" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm merge" }));

    await waitFor(() => expect(screen.getByTestId("action-success")).toHaveTextContent(
      "merge.dirty.stashRetained",
    ));
    expect(screen.getByTestId("action-error")).toBeEmptyDOMElement();
  });

  it("fetches the remote before merging, re-resolves the preflight, then merges", async () => {
    renderContainer();
    fireEvent.click(screen.getByRole("button", { name: "merge remote feature" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm merge with fetch" }));

    await waitFor(() => expect(runMergeBranch).toHaveBeenCalledWith(
      "repo-1",
      { refName: "refs/remotes/origin/feature", kind: "remoteTracking" },
      "default",
      "refuse",
    ));
    expect(runFetchRepo).toHaveBeenCalledWith("repo-1", "origin");
    expect(queryClientMock.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["repos", "repo-1", "mergePreflight", "refs/remotes/origin/feature"],
    });
    const fetchOrder = vi.mocked(runFetchRepo).mock.invocationCallOrder[0];
    const mergeOrder = vi.mocked(runMergeBranch).mock.invocationCallOrder[0];
    expect(fetchOrder).toBeLessThan(mergeOrder);
  });

  it("cancels the merge without calling merge_branch when the fetch fails", async () => {
    vi.mocked(runFetchRepo).mockReturnValueOnce({
      operationId: "operation-fetch",
      promise: Promise.reject({ code: "network_unreachable" }),
    });
    renderContainer();
    fireEvent.click(screen.getByRole("button", { name: "merge remote feature" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm merge with fetch" }));

    await waitFor(() => expect(screen.getByTestId("action-pending")).toBeEmptyDOMElement());
    expect(runFetchRepo).toHaveBeenCalledWith("repo-1", "origin");
    expect(runMergeBranch).not.toHaveBeenCalled();
  });

  it("stages a squash merge and hands the suggested message to the commit draft", async () => {
    renderContainer();
    fireEvent.click(screen.getByRole("button", { name: "squash merge feature" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm squash merge" }));

    await waitFor(() => expect(runSquashMergeBranch).toHaveBeenCalledWith(
      "repo-1",
      { refName: "refs/heads/feature", kind: "localBranch" },
      "refuse",
    ));
    await waitFor(() => expect(screen.getByTestId("pending-draft-message")).toHaveTextContent(
      "Squash of feature",
    ));
    expect(invalidateRepoData).toHaveBeenCalledWith(
      queryClientMock,
      "repo-1",
      "workspace-1",
      ["status", "working", "stashes", "merge"],
    );
  });

  it("reports a conflicted squash merge naming the files to resolve", async () => {
    vi.mocked(runSquashMergeBranch).mockReturnValueOnce({
      operationId: "operation-squash-merge",
      promise: Promise.resolve({
        outcome: { kind: "conflicted", paths: ["src/app.ts"] },
        source: { refName: "refs/heads/feature", kind: "localBranch" },
        sourceLabel: "feature",
        targetBranch: "main",
        targetCommit: "target-commit",
        stashRef: null,
        generations: { workingTree: 2, refs: 1, history: 1, stash: 0, config: 0 },
      }),
    });
    renderContainer();
    fireEvent.click(screen.getByRole("button", { name: "squash merge feature" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm squash merge" }));

    await waitFor(() => expect(screen.getByTestId("action-success")).toHaveTextContent(
      "squashMerge.outcome.conflicted",
    ));
    expect(screen.getByTestId("pending-draft-message")).toBeEmptyDOMElement();
  });

  it("routes operation abort through destructive preflight", async () => {
    operationStateMock.state = {
      operation: { kind: "merge", head: "topic", incoming: ["topic"] },
      conflictedPaths: ["conflict.txt"],
      available: ["abort"],
      detectedExternally: true,
    };
    const action = { kind: "abortOperation" as const };
    vi.mocked(preflightDestructiveAction)
      .mockResolvedValueOnce(actionPreflight(action, "abort-token-1"))
      .mockResolvedValueOnce(actionPreflight(action, "abort-token-2"));
    renderContainer();

    fireEvent.click(screen.getByRole("button", { name: "abort operation" }));
    expect(await screen.findByText("preflight.abortOperation.title")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "preflight.abortOperation.confirm" }));

    await waitFor(() => expect(runExecuteDestructiveAction).toHaveBeenCalledWith(
      "repo-1",
      action,
      { workingTree: 1, refs: 2, history: 3, stash: 0, config: 0 },
      "abort-token-2",
    ));
  });
});

function renderContainer() {
  return render(
    <RepoDetailContainer
      repo={repo}
      command={null}
      onBack={vi.fn()}
      utilities={<div data-testid="shell-utilities" />}
    />,
  );
}

function forcePreflight(confirmationToken: string) {
  return {
    action: { kind: "forceWithLease" as const },
    consequences: [{
      kind: "remoteRefUpdated" as const,
      remote: "origin",
      refName: "refs/heads/main",
      droppedCommits: 1,
    }],
    recoverable: "reflog" as const,
    blockers: [],
    generations: { workingTree: 1, refs: 2, history: 3, stash: 0, config: 0 },
    forceWithLease: {
      remote: "origin",
      refName: "refs/heads/main",
      expectedOid: "abc123",
    },
    confirmationToken,
  };
}

function actionPreflight(
  action: import("@/domain/git").DestructiveAction,
  confirmationToken: string,
) {
  return {
    action,
    consequences: [],
    recoverable: "notRecoverable" as const,
    blockers: [],
    generations: { workingTree: 1, refs: 2, history: 3, stash: 0, config: 0 },
    forceWithLease: null,
    confirmationToken,
  };
}
