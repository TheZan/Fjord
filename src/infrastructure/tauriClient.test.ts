import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { getBranches } from "@/infrastructure/tauriClient";

describe("abortable Tauri queries", () => {
  beforeEach(() => tauri.invoke.mockReset());

  it("rejects an obsolete query when its signal is aborted", async () => {
    let resolveInvoke!: (value: unknown[]) => void;
    tauri.invoke.mockReturnValue(new Promise((resolve) => (resolveInvoke = resolve)));
    const controller = new AbortController();

    const result = getBranches("repo-1", controller.signal);
    controller.abort();
    resolveInvoke([]);

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
