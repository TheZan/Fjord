import { describe, expect, it } from "vitest";
import {
  highlightDiffLines,
  languageForPath,
  MAX_HIGHLIGHT_CHARACTERS,
  tokenizeLine,
} from "@/presentation/diffHighlight";

describe("diff syntax highlighting", () => {
  it("detects supported languages without guessing unknown files", () => {
    expect(languageForPath("src/view.tsx")).toBe("javascript");
    expect(languageForPath("crates/domain/src/lib.rs")).toBe("rust");
    expect(languageForPath("notes.log")).toBeNull();
  });

  it("emits bounded non-overlapping tokens", () => {
    expect(tokenizeLine("javascript", 'const answer = "value"; // note')).toEqual([
      { start: 0, length: 5, kind: "keyword" },
      { start: 15, length: 7, kind: "string" },
      { start: 24, length: 7, kind: "comment" },
    ]);
  });

  it("refuses an over-budget visible window instead of finishing late", () => {
    const result = highlightDiffLines("rust", [{ key: "0:0", content: "x".repeat(MAX_HIGHLIGHT_CHARACTERS + 1) }]);

    expect(result).toEqual({ lines: [], skipped: "budget" });
  });

  it("keeps a diff-giant-sized viewport tokenization within the worker budget", () => {
    const lines = Array.from({ length: 120 }, (_, index) => ({
      key: `0:${index}`,
      content: `const value${index} = ${index}; // diff-giant visible window`,
    }));
    const startedAt = performance.now();
    const result = highlightDiffLines("javascript", lines);
    const durationMs = performance.now() - startedAt;

    expect(result.skipped).toBeNull();
    expect(result.lines).toHaveLength(120);
    expect(durationMs).toBeLessThan(50);
  });
});
