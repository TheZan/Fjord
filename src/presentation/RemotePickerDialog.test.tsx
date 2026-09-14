import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRemotes } from "@/application/useRemotes";
import { RemotePickerDialog } from "@/presentation/RemotePickerDialog";
import type { RemoteInfo } from "@/domain/workspace";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/application/useRemotes", () => ({ useRemotes: vi.fn() }));

const origin: RemoteInfo = { name: "origin", fetchUrl: "../origin.git", pushUrl: null };
const upstream: RemoteInfo = { name: "upstream", fetchUrl: "../upstream.git", pushUrl: null };

describe("RemotePickerDialog", () => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockState({ remotes: [origin, upstream], loading: false, error: null });
  });

  it("uses one keyboard-accessible selection and confirms the exact remote", async () => {
    renderPicker("fetch");
    const select = screen.getByLabelText("remotes.picker.remoteLabel");
    await waitFor(() => expect(select).toHaveFocus());
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.change(select, { target: { value: "upstream" } });
    fireEvent.keyDown(select, { key: "Tab" });
    fireEvent.click(screen.getByRole("button", { name: "remotes.picker.fetchConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith({ remote: "upstream", upstream: null });
  });

  it("filters upstream branches through the selected remote", () => {
    render(
      <RemotePickerDialog
        repoId="repo-1"
        kind="setUpstream"
        branch="topic"
        remoteBranches={["origin/main", "origin/topic", "upstream/develop"]}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByLabelText("remotes.picker.remoteLabel"), {
      target: { value: "upstream" },
    });
    expect(screen.getByRole("option", { name: "develop" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "main" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "remotes.picker.setUpstreamConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith({ remote: "upstream", upstream: "upstream/develop" });
  });

  it.each([
    [{ remotes: [], loading: true, error: null }, "remotes.picker.loading", "status"],
    [{ remotes: [], loading: false, error: null }, "remotes.picker.empty", "status"],
    [{ remotes: [], loading: false, error: "load failed" }, "load failed", "alert"],
  ] as const)("renders picker state %# without enabling confirm", (state, message, role) => {
    mockState(state);
    renderPicker("publish");
    expect(screen.getByRole(role)).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "remotes.picker.publishConfirm" })).toBeDisabled();
  });

  it("disables set-upstream when the selected remote has no remote branches", () => {
    render(
      <RemotePickerDialog
        repoId="repo-1"
        kind="setUpstream"
        branch="topic"
        remoteBranches={["upstream/develop"]}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("remotes.picker.noBranches");
    expect(screen.getByRole("button", { name: "remotes.picker.setUpstreamConfirm" })).toBeDisabled();
  });

  it("cancels without confirming and supports Escape", () => {
    renderPicker("fetch");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("wraps keyboard focus and restores the invoking control on close", () => {
    const { unmount: unmountTrigger } = render(<button>Open remotes</button>);
    const trigger = screen.getByRole("button", { name: "Open remotes" });
    trigger.focus();
    const { unmount } = renderPicker("fetch");
    const select = screen.getByLabelText("remotes.picker.remoteLabel");
    const confirm = screen.getByRole("button", { name: "remotes.picker.fetchConfirm" });
    expect(select).toHaveFocus();

    fireEvent.keyDown(select, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(select).toHaveFocus();
    unmount();
    expect(trigger).toHaveFocus();
    unmountTrigger();
  });

  function renderPicker(kind: "fetch" | "publish") {
    return render(
      <RemotePickerDialog
        repoId="repo-1"
        kind={kind}
        branch="main"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
  }

  function mockState(state: { remotes: readonly RemoteInfo[]; loading: boolean; error: string | null }) {
    vi.mocked(useRemotes).mockReturnValue({
      ...state,
      remotes: [...state.remotes],
      addRemote: vi.fn(),
      editRemote: vi.fn(),
      renameRemote: vi.fn(),
      preflightRemoveRemote: vi.fn(),
      removeRemote: vi.fn(),
    });
  }
});
