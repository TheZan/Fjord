// Turns a flat list of repository-relative paths into the nested shape the
// "Tree" view renders. Kept separate from the component (like graphLayout.ts)
// because the interesting part — collapsing single-child directory chains —
// is pure logic worth testing on its own.

export interface FileTreeFile<T> {
  kind: "file";
  /** Basename only; the full path lives on `item`. */
  name: string;
  path: string;
  item: T;
}

export interface FileTreeDir<T> {
  kind: "dir";
  /** Possibly a collapsed run of segments, e.g. `src/Results.Application`. */
  name: string;
  /** Full path of the directory, used as a stable key and collapse handle. */
  path: string;
  children: FileTreeNode<T>[];
}

export type FileTreeNode<T> = FileTreeDir<T> | FileTreeFile<T>;

interface MutableDir<T> {
  dirs: Map<string, MutableDir<T>>;
  files: { name: string; item: T }[];
}

function emptyDir<T>(): MutableDir<T> {
  return { dirs: new Map(), files: [] };
}

/**
 * Builds the tree. Directories that hold exactly one subdirectory and no
 * files of their own are merged into a single row — without this, a path like
 * `src/Results.Application/Queries/GetDiplomaMultiPdfQuery/Handler.cs` costs
 * four rows of indentation to show one file.
 */
export function buildFileTree<T extends { path: string }>(items: T[]): FileTreeNode<T>[] {
  const root = emptyDir<T>();

  for (const item of items) {
    const segments = item.path.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    const fileName = segments[segments.length - 1];
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      let next = dir.dirs.get(segment);
      if (!next) {
        next = emptyDir<T>();
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.push({ name: fileName, item });
  }

  return flatten(root, "");
}

function flatten<T extends { path: string }>(dir: MutableDir<T>, prefix: string): FileTreeNode<T>[] {
  const dirNodes: FileTreeDir<T>[] = [];

  for (const [name, child] of dir.dirs) {
    let displayName = name;
    let path = prefix ? `${prefix}/${name}` : name;
    let node = child;

    // Collapse `a/b/c` into one row while each level is a lone subdirectory.
    while (node.files.length === 0 && node.dirs.size === 1) {
      const [onlyName, onlyChild] = [...node.dirs.entries()][0];
      displayName = `${displayName}/${onlyName}`;
      path = `${path}/${onlyName}`;
      node = onlyChild;
    }

    dirNodes.push({ kind: "dir", name: displayName, path, children: flatten(node, path) });
  }

  dirNodes.sort((a, b) => a.name.localeCompare(b.name));

  const fileNodes: FileTreeFile<T>[] = dir.files
    .map(({ name, item }) => ({ kind: "file" as const, name, path: item.path, item }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...dirNodes, ...fileNodes];
}

/**
 * Every directory row the tree will render, for "collapse all". Derived from
 * a built tree rather than from raw paths because directory *rows* are the
 * collapsed runs (`src/domain/deep`), not the individual segments.
 */
export function collectDirectoryPaths<T>(nodes: FileTreeNode<T>[]): string[] {
  const out: string[] = [];

  for (const node of nodes) {
    if (node.kind === "dir") {
      out.push(node.path);
      out.push(...collectDirectoryPaths(node.children));
    }
  }

  return out;
}

/** Convenience for callers that hold a flat file list rather than a tree. */
export function directoryPathsOf<T extends { path: string }>(items: T[]): string[] {
  return collectDirectoryPaths(buildFileTree(items));
}

/** `src/domain/git.ts` -> `{ dir: "src/domain/", name: "git.ts" }`. */
export function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  if (index === -1) return { dir: "", name: path };
  return { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}
