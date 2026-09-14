import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/application/queryKeys";
import { useRemotes } from "@/application/useRemotes";
import {
  addRemote,
  listRemotes,
  preflightRemoveRemote,
  removeRemote,
  renameRemote,
  setRemoteUrl,
} from "@/infrastructure/tauriClient";
import type { RemoteInfo, RemoveRemotePreflight } from "@/domain/workspace";

vi.mock("@/infrastructure/tauriClient", () => ({
  addRemote: vi.fn(),
  listRemotes: vi.fn(),
  preflightRemoveRemote: vi.fn(),
  removeRemote: vi.fn(),
  renameRemote: vi.fn(),
  setRemoteUrl: vi.fn(),
}));

const origin: RemoteInfo = {
  name: "origin",
  fetchUrl: "https://example.test/team/fjord.git",
  pushUrl: null,
};

describe("useRemotes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listRemotes).mockResolvedValue([origin]);
    vi.mocked(addRemote).mockResolvedValue(origin);
  });

  it("keeps the empty remote list stable while loading and after a load failure", async () => {
    let rejectLoad!: (reason: unknown) => void;
    vi.mocked(listRemotes).mockReturnValue(new Promise((_resolve, reject) => { rejectLoad = reject; }));
    const { result, rerender } = renderRemotes();
    const emptyRemotes = result.current.remotes;
    expect(result.current.loading).toBe(true);

    rerender();
    expect(result.current.remotes).toBe(emptyRemotes);
    rejectLoad({ code: "repo_not_found" });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.remotes).toBe(emptyRemotes);
  });

  it("publishes an edited sanitized remote only after the mutation succeeds", async () => {
    let resolveEdit!: (remote: RemoteInfo) => void;
    vi.mocked(setRemoteUrl).mockReturnValue(new Promise((resolve) => { resolveEdit = resolve; }));
    const { client, result } = renderRemotes();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await waitFor(() => expect(result.current.loading).toBe(false));

    let request!: Promise<RemoteInfo>;
    act(() => {
      request = result.current.editRemote(
        "origin",
        "https://user:secret@example.test/team/fjord.git",
        "ssh://git@example.test/team/fjord.git",
      );
    });
    expect(client.getQueryData(queryKeys.repos.remotes("repo-1"))).toEqual([origin]);

    const sanitized: RemoteInfo = {
      name: "origin",
      fetchUrl: "https://[REDACTED]@example.test/team/fjord.git",
      pushUrl: "ssh://git@example.test/team/fjord.git",
    };
    resolveEdit(sanitized);
    await act(async () => { await request; });
    expect(client.getQueryData(queryKeys.repos.remotes("repo-1"))).toEqual([sanitized]);
    expect(JSON.stringify(client.getQueryData(queryKeys.repos.remotes("repo-1")))).not.toContain("secret");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.repos.branches("repo-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.repos.status("repo-1") });
  });

  it("renames the cached remote, preserves sorting, and invalidates dependent queries", async () => {
    const upstream: RemoteInfo = { name: "upstream", fetchUrl: "../upstream.git", pushUrl: null };
    vi.mocked(listRemotes).mockResolvedValue([origin, upstream]);
    const renamed: RemoteInfo = { ...origin, name: "mirror" };
    vi.mocked(renameRemote).mockResolvedValue(renamed);
    const { client, result } = renderRemotes();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await waitFor(() => expect(result.current.remotes).toHaveLength(2));

    await act(async () => { await result.current.renameRemote("origin", "mirror"); });

    expect(client.getQueryData(queryKeys.repos.remotes("repo-1"))).toEqual([renamed, upstream]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.repos.branches("repo-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.repos.status("repo-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.repos.commits("repo-1") });
  });

  it("passes the exact preflight generation and token to remove and updates only after success", async () => {
    const preflight: RemoveRemotePreflight = {
      remote: "origin",
      orphanedUpstreams: ["main", "release"],
      configGeneration: 42,
      confirmationToken: "one-use-token",
    };
    vi.mocked(preflightRemoveRemote).mockResolvedValue(preflight);
    let resolveRemove!: () => void;
    vi.mocked(removeRemote).mockReturnValue(new Promise<void>((resolve) => { resolveRemove = resolve; }));
    const { client, result } = renderRemotes();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(await act(async () => result.current.preflightRemoveRemote("origin"))).toEqual(preflight);
    let request!: Promise<void>;
    act(() => { request = result.current.removeRemote(preflight); });
    expect(client.getQueryData(queryKeys.repos.remotes("repo-1"))).toEqual([origin]);
    resolveRemove();
    await act(async () => { await request; });

    expect(removeRemote).toHaveBeenCalledWith("repo-1", "origin", 42, "one-use-token");
    expect(client.getQueryData(queryKeys.repos.remotes("repo-1"))).toEqual([]);
  });

  it("does not publish optimistic remote state when a mutation fails", async () => {
    vi.mocked(setRemoteUrl).mockRejectedValue({ code: "remote_url_invalid" });
    vi.mocked(renameRemote).mockRejectedValue({ code: "remote_rename_target_exists" });
    const { client, result } = renderRemotes();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(result.current.editRemote("origin", "", null)).rejects.toEqual({ code: "remote_url_invalid" });
      await expect(result.current.renameRemote("origin", "upstream")).rejects.toEqual({
        code: "remote_rename_target_exists",
      });
    });
    expect(client.getQueryData(queryKeys.repos.remotes("repo-1"))).toEqual([origin]);
  });
});

function renderRemotes() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, ...renderHook(() => useRemotes("repo-1"), { wrapper }) };
}
