import { describe, expect, it } from "vitest";
import { mergeDiffWindows } from "@/application/useFileDiff";
import type { FileDiffWindow } from "@/domain/git";

function window(offset: number, contents: string[], nextOffset: number | null): FileDiffWindow {
  return {
    path: "large.txt",
    changeType: "modified",
    oldMode: 0o100644,
    newMode: 0o100644,
    isBinary: false,
    tooLarge: false,
    fileBytes: 100,
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: contents.map((content, index) => ({
          kind: "context",
          oldLineno: offset + index + 1,
          newLineno: offset + index + 1,
          content,
          lineEnding: "lf",
        })),
      },
    ],
    totalHunks: 1,
    totalLines: 4,
    truncated: nextOffset !== null,
    nextOffset,
    baseDigest: null,
  };
}

describe("diff window merging", () => {
  it("joins a split hunk without duplicating its header", () => {
    const merged = mergeDiffWindows([
      window(0, ["a", "b"], 2),
      window(2, ["c", "d"], null),
    ]);

    expect(merged?.hunks).toHaveLength(1);
    expect(merged?.hunks[0].lines.map((line) => line.content)).toEqual(["a", "b", "c", "d"]);
    expect(merged?.truncated).toBe(false);
    expect(merged?.nextOffset).toBeNull();
  });
});
