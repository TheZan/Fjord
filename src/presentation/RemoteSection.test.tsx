import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRemotes } from "@/application/useRemotes";
import { runFetchRepo } from "@/infrastructure/tauriClient";
import { RemoteSection } from "@/presentation/RemoteSection";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/application/useRemotes", () => ({ useRemotes: vi.fn() }));
vi.mock("@/application/errorMessage", () => ({
  userErrorMessage: (error: { code?: string }) => `error:${error.code ?? "unexpected"}`,
}));
vi.mock("@/infrastructure/tauriClient", () => ({ runFetchRepo: vi.fn() }));

describe("RemoteSection", () => {
  const addRemote = vi.fn();

  beforeEach(() => {
    addRemote.mockReset();
    vi.mocked(runFetchRepo).mockReset();
    vi.mocked(useRemotes).mockReturnValue({
      remotes: [{ name: "origin", fetchUrl: "https://[REDACTED]@example.test/team/fjord.git", pushUrl: null }],
      loading: false,
      error: null,
      addRemote,
    });
    vi.mocked(runFetchRepo).mockReturnValue({ operationId: "fetch:1", promise: Promise.resolve() });
  });

  it("renders only the sanitized remote URL supplied by the backend", () => {
    render(<RemoteSection repoId="repo-1" />);
    expect(screen.getByText("https://[REDACTED]@example.test/team/fjord.git")).toBeInTheDocument();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });

  it("defaults to origin, adds a remote, and optionally fetches it", async () => {
    addRemote.mockResolvedValue({ name: "origin", fetchUrl: "/fixtures/remote.git", pushUrl: null });
    render(<RemoteSection repoId="repo-1" />);
    fireEvent.click(screen.getByRole("button", { name: "remotes.add" }));
    expect(screen.getByLabelText("remotes.name")).toHaveValue("origin");
    expect(screen.getByRole("button", { name: "remotes.submit" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("remotes.url"), { target: { value: "/fixtures/remote.git" } });
    fireEvent.click(screen.getByRole("button", { name: "remotes.submit" }));

    await waitFor(() => expect(addRemote).toHaveBeenCalledWith("origin", "/fixtures/remote.git"));
    await waitFor(() => expect(runFetchRepo).toHaveBeenCalledWith("repo-1", "origin"));
  });

  it("surfaces duplicate-name failures without weakening the flow", async () => {
    addRemote.mockRejectedValue({ code: "remote_name_exists" });
    render(<RemoteSection repoId="repo-1" />);
    fireEvent.click(screen.getByRole("button", { name: "remotes.add" }));
    fireEvent.change(screen.getByLabelText("remotes.url"), { target: { value: "https://example.test/fjord.git" } });
    fireEvent.click(screen.getByRole("button", { name: "remotes.submit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("error:remote_name_exists");
    expect(runFetchRepo).not.toHaveBeenCalled();
  });
});
