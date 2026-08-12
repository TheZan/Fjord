export type DiffLanguage = "javascript" | "rust" | "python" | "json" | "css" | "markup" | "shell" | "powershell";

export type HighlightTokenKind = "keyword" | "literal" | "number" | "string" | "comment" | "type" | "tag";

export interface HighlightToken {
  start: number;
  length: number;
  kind: HighlightTokenKind;
}

export interface HighlightLineInput {
  key: string;
  content: string;
  pairKey?: string;
  kind?: "context" | "addition" | "deletion";
}

export interface HighlightedLine {
  key: string;
  tokens: HighlightToken[];
  wordChanges: TextRange[];
}

export interface TextRange {
  start: number;
  length: number;
}

export const MAX_HIGHLIGHT_LINES = 240;
export const MAX_HIGHLIGHT_CHARACTERS = 120_000;
export const WORD_DIFF_SIMILARITY_THRESHOLD = 0.45;
const MAX_WORD_TOKENS_PER_LINE = 400;

const LANGUAGE_BY_EXTENSION: Record<string, DiffLanguage> = {
  cjs: "javascript",
  css: "css",
  htm: "markup",
  html: "markup",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  mjs: "javascript",
  ps1: "powershell",
  py: "python",
  rs: "rust",
  scss: "css",
  sh: "shell",
  ts: "javascript",
  tsx: "javascript",
  xml: "markup",
  yaml: "shell",
  yml: "shell",
  zsh: "shell",
};

const KEYWORDS: Record<DiffLanguage, ReadonlySet<string>> = {
  javascript: new Set(["as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else", "export", "extends", "finally", "for", "from", "function", "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "of", "private", "protected", "public", "return", "static", "switch", "throw", "try", "type", "typeof", "var", "void", "while", "yield"]),
  rust: new Set(["as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "type", "unsafe", "use", "where", "while"]),
  python: new Set(["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]),
  json: new Set(),
  css: new Set(["important"]),
  markup: new Set(),
  shell: new Set(["case", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "select", "then", "until", "while"]),
  powershell: new Set(["begin", "break", "catch", "class", "continue", "data", "do", "dynamicparam", "else", "elseif", "end", "enum", "exit", "filter", "finally", "for", "foreach", "from", "function", "if", "in", "param", "process", "return", "switch", "throw", "trap", "try", "until", "using", "while"]),
};

const LITERALS = new Set(["false", "null", "true", "undefined", "None", "False", "True"]);

export function languageForPath(path: string): DiffLanguage | null {
  const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  if (["dockerfile", "makefile"].includes(name)) return "shell";
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

export function highlightDiffLines(
  language: DiffLanguage | null,
  lines: HighlightLineInput[],
  wordDiff = false,
): { lines: HighlightedLine[]; skipped: "budget" | null } {
  const characters = lines.reduce((total, line) => total + line.content.length, 0);
  if (lines.length > MAX_HIGHLIGHT_LINES || characters > MAX_HIGHLIGHT_CHARACTERS) {
    return { lines: [], skipped: "budget" };
  }
  const wordChanges = wordDiff ? computeWordChanges(lines) : new Map<string, TextRange[]>();
  return {
    lines: lines.map((line) => ({
      key: line.key,
      tokens: language ? tokenizeLine(language, line.content) : [],
      wordChanges: wordChanges.get(line.key) ?? [],
    })),
    skipped: null,
  };
}

export function wordDiffPair(
  deletion: string,
  addition: string,
  threshold = WORD_DIFF_SIMILARITY_THRESHOLD,
): { deletion: TextRange[]; addition: TextRange[]; similarity: number } | null {
  const left = wordSegments(deletion);
  const right = wordSegments(addition);
  const leftComparable = left.filter((segment) => !segment.whitespace);
  const rightComparable = right.filter((segment) => !segment.whitespace);
  if (leftComparable.length === 0 || rightComparable.length === 0) return null;
  if (leftComparable.length > MAX_WORD_TOKENS_PER_LINE || rightComparable.length > MAX_WORD_TOKENS_PER_LINE) return null;
  const matches = longestCommonSubsequence(leftComparable, rightComparable);
  const similarity = (2 * matches.length) / (leftComparable.length + rightComparable.length);
  if (similarity < threshold || similarity === 1) return null;
  const leftMatched = new Set(matches.map(([leftIndex]) => leftIndex));
  const rightMatched = new Set(matches.map(([, rightIndex]) => rightIndex));
  return {
    deletion: mergeRanges(leftComparable.filter((_, index) => !leftMatched.has(index))),
    addition: mergeRanges(rightComparable.filter((_, index) => !rightMatched.has(index))),
    similarity,
  };
}

function computeWordChanges(lines: HighlightLineInput[]): Map<string, TextRange[]> {
  const pairs = new Map<string, { deletion?: HighlightLineInput; addition?: HighlightLineInput }>();
  for (const line of lines) {
    if (!line.pairKey || (line.kind !== "addition" && line.kind !== "deletion")) continue;
    const pair = pairs.get(line.pairKey) ?? {};
    pair[line.kind] = line;
    pairs.set(line.pairKey, pair);
  }
  const changes = new Map<string, TextRange[]>();
  for (const pair of pairs.values()) {
    if (!pair.deletion || !pair.addition) continue;
    const wordDiff = wordDiffPair(pair.deletion.content, pair.addition.content);
    if (!wordDiff) continue;
    changes.set(pair.deletion.key, wordDiff.deletion);
    changes.set(pair.addition.key, wordDiff.addition);
  }
  return changes;
}

interface WordSegment extends TextRange {
  value: string;
  whitespace: boolean;
}

function wordSegments(content: string): WordSegment[] {
  return [...content.matchAll(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu)].map((match) => ({
    start: match.index,
    length: match[0].length,
    value: match[0],
    whitespace: /^\s+$/.test(match[0]),
  }));
}

function longestCommonSubsequence(left: WordSegment[], right: WordSegment[]): Array<[number, number]> {
  const lengths = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      lengths[leftIndex][rightIndex] = left[leftIndex].value === right[rightIndex].value
        ? lengths[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(lengths[leftIndex + 1][rightIndex], lengths[leftIndex][rightIndex + 1]);
    }
  }
  const matches: Array<[number, number]> = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex].value === right[rightIndex].value) {
      matches.push([leftIndex, rightIndex]);
      leftIndex += 1;
      rightIndex += 1;
    } else if (lengths[leftIndex + 1][rightIndex] >= lengths[leftIndex][rightIndex + 1]) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return matches;
}

function mergeRanges(segments: WordSegment[]): TextRange[] {
  const ranges: TextRange[] = [];
  for (const segment of segments) {
    const previous = ranges.at(-1);
    if (previous && previous.start + previous.length === segment.start) previous.length += segment.length;
    else ranges.push({ start: segment.start, length: segment.length });
  }
  return ranges;
}

export function tokenizeLine(language: DiffLanguage, content: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const commentLength = commentAt(language, content, cursor);
    if (commentLength > 0) {
      tokens.push({ start: cursor, length: content.length - cursor, kind: "comment" });
      break;
    }

    const quote = content[cursor];
    if (quote === '"' || quote === "'" || (quote === "`" && language === "javascript")) {
      const end = scanString(content, cursor, quote);
      tokens.push({ start: cursor, length: end - cursor, kind: "string" });
      cursor = end;
      continue;
    }

    if (language === "markup" && content[cursor] === "<") {
      const tag = content.slice(cursor).match(/^<\/?[A-Za-z][\w:-]*/)?.[0];
      if (tag) {
        tokens.push({ start: cursor, length: tag.length, kind: "tag" });
        cursor += tag.length;
        continue;
      }
    }

    const number = content.slice(cursor).match(/^(?:0[xob][0-9a-f]+|\d+(?:\.\d+)?)/i)?.[0];
    if (number) {
      tokens.push({ start: cursor, length: number.length, kind: "number" });
      cursor += number.length;
      continue;
    }

    const identifier = content.slice(cursor).match(/^[A-Za-z_$][\w$-]*/)?.[0];
    if (identifier) {
      const normalized = language === "powershell" ? identifier.toLowerCase() : identifier;
      const kind = LITERALS.has(identifier)
        ? "literal"
        : KEYWORDS[language].has(normalized)
          ? "keyword"
          : /^[A-Z]/.test(identifier)
            ? "type"
            : null;
      if (kind) tokens.push({ start: cursor, length: identifier.length, kind });
      cursor += identifier.length;
      continue;
    }
    cursor += 1;
  }
  return tokens;
}

function commentAt(language: DiffLanguage, content: string, cursor: number): number {
  if (language === "markup" && content.startsWith("<!--", cursor)) return 4;
  if (["javascript", "rust", "css"].includes(language) && content.startsWith("//", cursor)) return 2;
  if (["python", "shell", "powershell"].includes(language) && content[cursor] === "#") return 1;
  return 0;
}

function scanString(content: string, start: number, quote: string): number {
  let cursor = start + 1;
  while (cursor < content.length) {
    if (content[cursor] === "\\") cursor += 2;
    else if (content[cursor] === quote) return cursor + 1;
    else cursor += 1;
  }
  return content.length;
}
