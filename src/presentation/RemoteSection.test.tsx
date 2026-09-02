import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRemotes } from "@/application/useRemotes";
import { runFetchRepo } from "@/infrastructure/tauriClient";
import { RemoteSection } from "@/presentation/RemoteSection";
import type { RemoteInfo, RemoveRemotePreflight } from "@/domain/workspace";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/application/useRemotes", () => ({ useRemotes: vi.fn() }));
vi.mock("@/application/errorMessage", () => ({
  userErrorMessage: (error: { code?: string }) => `error:${error.code ?? "unexpected"}`,
}));
vi.mock("@/infrastructure/tauriClient", () => ({ runFetchRepo: vi.fn() }));

const sanitizedRemote: RemoteInfo = {
  name: "origin",
  fetchUrl: "https://[REDACTED]@example.test/team/fjord.git",
  pushUrl: null,
};

describe("RemoteSection", () => {
  const addRemote = vi.fn();
  const editRemote = vi.fn();
  const renameRemote = vi.fn();
  const preflightRemoveRemote = vi.fn();
  const removeRemote = vi.fn();
  const pushToRemotes = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockRemotes([sanitizedRemote]);
    vi.mocked(runFetchRepo).mockReturnValue({ operationId: "fetch:1", promise: Promise.resolve() });
  });

  it("renders sanitized URLs only and never copies them into mutation inputs", () => {
    mockRemotes([{
      ...sanitizedRemote,
      pushUrl: "https://[REDACTED]@push.example.test/team/fjord.git",
    }]);
    renderSection();
    expect(screen.getByText("https://[REDACTED]@example.test/team/fjord.git")).toBeInTheDocument();
    expect(screen.getByText("https://[REDACTED]@push.example.test/team/fjord.git")).toBeInTheDocument();
    expect(screen.queryByText(/username|token|secret/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "remotes.editLabel" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("remotes.newFetchUrl")).toHaveValue("");
    expect(within(dialog).getByLabelText("remotes.newPushUrl")).toHaveValue("");
    expect(editRemote).not.toHaveBeenCalled();
  });

  it("keeps the add-and-optional-fetch flow", async () => {
    addRemote.mockResolvedValue({ name: "origin", fetchUrl: "/fixtures/remote.git", pushUrl: null });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "remotes.add" }));
    expect(screen.getByLabelText("remotes.name")).toHaveValue("origin");
    expect(screen.getByRole("button", { name: "remotes.submit" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("remotes.url"), { target: { value: "/fixtures/remote.git" } });
    fireEvent.click(screen.getByRole("button", { name: "remotes.submit" }));

    await waitFor(() => expect(addRemote).toHaveBeenCalledWith("origin", "/fixtures/remote.git"));
    await waitFor(() => expect(runFetchRepo).toHaveBeenCalledWith("repo-1", "origin"));
  });

  it("edits the fetch URL and clears an absent explicit push URL", async () => {
    editRemote.mockResolvedValue({ ...sanitizedRemote, fetchUrl: "https://new.example.test/fjord.git" });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "remotes.editLabel" }));
    fireEvent.change(screen.getByLabelText("remotes.newFetchUrl"), {
      target: { value: "https://new.example.test/fjord.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "remotes.save" }));
    await waitFor(() => expect(editRemote).toHaveBeenCalledWith(
      "origin",
      "https://new.example.test/fjord.git",
      null,
    ));
  });

  it("sets an explicit push URL only from newly entered full state", async () => {
    editRemote.mockResolvedValue({
      ...sanitizedRemote,
      fetchUrl: "https://new.example.test/fjord.git",
      pushUrl: "ssh://git@push.example.test/team/fjord.git",
    });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "remotes.editLabel" }));
    fireEvent.change(screen.getByLabelText("remotes.newFetchUrl"), {
      target: { value: "https://new.example.test/fjord.git" },
    });
    fireEvent.click(screen.getByLabelText("remotes.useSeparatePushUrl"));
    fireEvent.change(screen.getByLabelText("remotes.newPushUrl"), {
      target: { value: "ssh://git@push.example.test/team/fjord.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "remotes.save" }));
    await waitFor(() => expect(editRemote).toHaveBeenCalledWith(
      "origin",
      "https://new.example.test/fjord.git",
      "ssh://git@push.example.test/team/fjord.git",
    ));
  });

  it("clears an existing explicit push URL without submitting its sanitized display value", async () => {
    mockRemotes([{ ...sanitizedRemote, pushUrl: "https://[REDACTED]@push.example.test/fjord.git" }]);
    editRemote.mockResolvedValue({ ...sanitizedRemote, fetchUrl: "../new.git" });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "remotes.editLabel" }));
    fireEvent.change(screen.getByLabelText("remotes.newFetchUrl"), { target: { value: "../new.git" } });
    fireEvent.click(screen.getByLabelText("remotes.useSeparatePushUrl"));
    fireEvent.click(screen.getByRole("button", { name: "remotes.save" }));
    await waitFor(() => expect(editRemote).toHaveBeenCalledWith("origin", "../new.git", null));
  });

  it("rejects a no-op rename in the UI and submits a changed name", async () => {
    renameRemote.mockResolvedValue({ ...sanitizedRemote, name: "mirror" });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "remotes.renameLabel" }));
    const input = screen.getByLabelText("remotes.name");
    expect(input).toHaveValue("origin");
    expect(screen.getByRole("button", { name: "remotes.rename" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "mirror" } });
    fireEvent.click(screen.getByRole("button", { name: "remotes.rename" }));
    await waitFor(() => expect(renameRemote).toHaveBeenCalledWith("origin", "mirror"));
  });

  it("keeps the rename dialog open with a stable duplicate-name error", async () => {
    renameRemote.mockRejectedValue({ code: "remote_rename_target_exists" });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "remotes.renameLabel" }));
    fireEvent.change(screen.getByLabelText("remotes.name"), { target: { value: "upstream" } });
    fireEvent.click(screen.getByRole("button", { name: "remotes.rename" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("error:remote_rename_target_exists");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("preflights removal, names orphaned branches, and confirms with the exact plan", async () => {
    const preflight: RemoveRemotePreflight = {
      remote: "origin",
      orphanedUpstreams: ["main", "release/1"],
      configGeneration: 9,
      confirmationToken: "exact-token",
    };
    preflightRemoveRemote.mockResolvedValue(preflight);
    removeRemote.mockResolvedValue(undefined);
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "remotes.removeLabel" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("release/1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "remotes.remove" }));
    await waitFor(() => expect(removeRemote).toHaveBeenCalledWith(preflight));
  });

  it("cancels a preflighted removal without mutation", async () => {
    preflightRemoveRemote.mockResolvedValue({
      remote: "origin",
      orphanedUpstreams: [],
      configGeneration: 3,
      confirmationToken: "unused",
    });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "remotes.removeLabel" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "context.cancel" }));
    expect(removeRemote).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps a failed form open and blocks duplicate submissions while pending", async () => {
    let rejectEdit!: (reason: unknown) => void;
    editRemote.mockReturnValue(new Promise((_resolve, reject) => { rejectEdit = reject; }));
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "remotes.editLabel" }));
    fireEvent.change(screen.getByLabelText("remotes.newFetchUrl"), { target: { value: "https://bad.test" } });
    const save = screen.getByRole("button", { name: "remotes.save" });
    fireEvent.click(save);
    expect(screen.getByRole("button", { name: "remotes.saving" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "remotes.saving" }));
    expect(editRemote).toHaveBeenCalledTimes(1);
    rejectEdit({ code: "remote_url_invalid" });
    expect(await screen.findByRole("alert")).toHaveTextContent("error:remote_url_invalid");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("pushes to every selected remote and reports each result separately", async () => {
    mockRemotes([
      { name: "origin", fetchUrl: "https://github.test/team/fjord.git", pushUrl: null },
      { name: "gitlab", fetchUrl: "https://gitlab.test/team/fjord.git", pushUrl: null },
    ]);
    pushToRemotes.mockResolvedValue([
      { remote: "origin", ok: true, errorCode: null },
      { remote: "gitlab", ok: false, errorCode: "git_remote_rejected" },
    ]);
    renderSection();
    const destinations = screen.getAllByRole("checkbox");
    fireEvent.click(destinations[0]);
    fireEvent.click(destinations[1]);
    fireEvent.click(screen.getByRole("button", { name: "remotes.pushSelected" }));
    await waitFor(() => expect(pushToRemotes).toHaveBeenCalledWith(["origin", "gitlab"]));
    expect(await screen.findByText("origin: remotes.pushSuccess")).toBeInTheDocument();
    expect(screen.getByText("gitlab: remotes.pushFailure")).toBeInTheDocument();
  });

  function mockRemotes(remotes: RemoteInfo[]) {
    vi.mocked(useRemotes).mockReturnValue({
      remotes,
      loading: false,
      error: null,
      addRemote,
      editRemote,
      renameRemote,
      preflightRemoveRemote,
      removeRemote,
    });
  }

  function renderSection() {
    return render(<RemoteSection repoId="repo-1" onPushToRemotes={pushToRemotes} />);
  }
});
