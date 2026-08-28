import { describe, expect, it } from "vitest";
import { buildStashMenuItems, copiedStashValue } from "@/application/stashActions";
import type { StashEntry } from "@/domain/git";

const stash: StashEntry = {
  id: "immutable-stash-oid",
  index: 3,
  refName: "stash@{3}",
  message: "On main: duplicate title",
  title: "duplicate title",
  base: "immutable-base-oid",
  branch: "main",
  createdAt: "2026-08-28T00:00:00Z",
  filesChanged: 2,
  hasIndexState: true,
  hasUntracked: false,
};

describe("shared stash action model", () => {
  it("builds the normative menu with danger Drop last and capability-based Reveal", () => {
    const treeItems = buildStashMenuItems(true);
    expect(treeItems.map((item) => item.id)).toEqual([
      "apply", "pop", "createBranch", "copyRef", "copySha", "copyBaseSha", "revealInGraph", "drop",
    ]);
    expect(treeItems.at(-1)).toMatchObject({ id: "drop", danger: true, separatorBefore: true });
    expect(buildStashMenuItems(false).map((item) => item.id)).toEqual([
      "apply", "pop", "createBranch", "copyRef", "copySha", "copyBaseSha", "drop",
    ]);
  });

  it("copies the current positional ref and immutable stash/base identities", () => {
    expect(copiedStashValue("copyRef", { ...stash, index: 7, refName: "stash@{7}" })).toBe("stash@{7}");
    expect(copiedStashValue("copySha", { ...stash, index: 7, refName: "stash@{7}" })).toBe(stash.id);
    expect(copiedStashValue("copyBaseSha", { ...stash, index: 7, refName: "stash@{7}" })).toBe(stash.base);
  });
});
