import { describe, expect, it } from "vitest";
import {
  highlightDiffLines,
  languageForPath,
  MAX_HIGHLIGHT_CHARACTERS,
  tokenizeLine,
  wordDiffPair,
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

  it("pairs similar replacements and rejects unrelated lines below the threshold", () => {
    expect(wordDiffPair("return account.total", "return invoice.total")).toMatchObject({
      deletion: [{ start: 7, length: 7 }],
      addition: [{ start: 7, length: 7 }],
      similarity: 0.75,
    });
    expect(wordDiffPair("alpha beta gamma", "one two three")).toBeNull();
  });

  it("computes word changes only for explicit deletion/addition pairs", () => {
    const result = highlightDiffLines(null, [
      { key: "0:0", pairKey: "pair-1", kind: "deletion", content: "return account.total" },
      { key: "0:1", pairKey: "pair-1", kind: "addition", content: "return invoice.total" },
      { key: "0:2", kind: "addition", content: "unpaired" },
    ], true);

    expect(result.lines.map((line) => line.wordChanges)).toEqual([
      [{ start: 7, length: 7 }],
      [{ start: 7, length: 7 }],
      [],
    ]);
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
