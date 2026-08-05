import { describe, expect, it } from "vitest";
import {
  buildFileTree,
  directoryPathsOf,
  splitPath,
  type FileTreeDir,
  type FileTreeNode,
} from "./fileTree";

interface Entry {
  path: string;
}

function names<T>(nodes: FileTreeNode<T>[]): string[] {
  return nodes.map((node) => node.name);
}

function dir<T>(nodes: FileTreeNode<T>[], name: string): FileTreeDir<T> {
  const found = nodes.find((node) => node.kind === "dir" && node.name === name);
  if (!found || found.kind !== "dir") throw new Error(`no directory named ${name}`);
  return found;
}

describe("buildFileTree", () => {
  it("nests files under their directories", () => {
    const tree = buildFileTree<Entry>([{ path: "src/app.ts" }, { path: "src/ui.ts" }]);

    expect(names(tree)).toEqual(["src"]);
    expect(names(dir(tree, "src").children)).toEqual(["app.ts", "ui.ts"]);
  });

  it("collapses a chain of single-child directories into one row", () => {
    const tree = buildFileTree<Entry>([{ path: "src/domain/deep/git.ts" }]);

    expect(names(tree)).toEqual(["src/domain/deep"]);
    expect(names(dir(tree, "src/domain/deep").children)).toEqual(["git.ts"]);
  });

  it("stops collapsing where a directory branches", () => {
    const tree = buildFileTree<Entry>([
      { path: "src/a/one.ts" },
      { path: "src/b/two.ts" },
    ]);

    expect(names(tree)).toEqual(["src"]);
    expect(names(dir(tree, "src").children)).toEqual(["a", "b"]);
  });

  it("does not collapse past a directory that holds files of its own", () => {
    const tree = buildFileTree<Entry>([{ path: "src/root.ts" }, { path: "src/deep/leaf.ts" }]);

    const src = dir(tree, "src");
    expect(names(src.children)).toEqual(["deep", "root.ts"]);
  });

  it("sorts directories before files", () => {
    const tree = buildFileTree<Entry>([{ path: "a.ts" }, { path: "z/b.ts" }]);

    expect(names(tree)).toEqual(["z", "a.ts"]);
  });

  it("keeps the full path on each file while showing only the basename", () => {
    const tree = buildFileTree<Entry>([{ path: "src/domain/git.ts" }]);
    const [file] = dir(tree, "src/domain").children;

    expect(file.kind).toBe("file");
    expect(file.name).toBe("git.ts");
    expect(file.path).toBe("src/domain/git.ts");
  });

  it("handles files at the repository root", () => {
    const tree = buildFileTree<Entry>([{ path: "README.md" }]);

    expect(names(tree)).toEqual(["README.md"]);
  });
});

describe("directoryPathsOf", () => {
  it("lists every directory row, nested ones included", () => {
    const paths = directoryPathsOf([{ path: "src/a/one.ts" }, { path: "src/b/two.ts" }]);

    expect(paths.sort()).toEqual(["src", "src/a", "src/b"]);
  });

  it("reports a collapsed run as the single row it renders as", () => {
    // The tree shows one `src/domain/deep` row, so that — not `src` or
    // `src/domain` — is what "collapse all" has to target.
    expect(directoryPathsOf([{ path: "src/domain/deep/git.ts" }])).toEqual(["src/domain/deep"]);
  });

  it("is empty when every file sits at the root", () => {
    expect(directoryPathsOf([{ path: "README.md" }])).toEqual([]);
  });
});

describe("splitPath", () => {
  it("separates the directory prefix from the file name", () => {
    expect(splitPath("src/domain/git.ts")).toEqual({ dir: "src/domain/", name: "git.ts" });
  });

  it("reports no directory for a root-level file", () => {
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});
