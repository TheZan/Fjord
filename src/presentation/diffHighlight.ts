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
}

export interface HighlightedLine {
  key: string;
  tokens: HighlightToken[];
}

export const MAX_HIGHLIGHT_LINES = 240;
export const MAX_HIGHLIGHT_CHARACTERS = 120_000;

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
  language: DiffLanguage,
  lines: HighlightLineInput[],
): { lines: HighlightedLine[]; skipped: "budget" | null } {
  const characters = lines.reduce((total, line) => total + line.content.length, 0);
  if (lines.length > MAX_HIGHLIGHT_LINES || characters > MAX_HIGHLIGHT_CHARACTERS) {
    return { lines: [], skipped: "budget" };
  }
  return {
    lines: lines.map((line) => ({ key: line.key, tokens: tokenizeLine(language, line.content) })),
    skipped: null,
  };
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
