import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileEntryList, type FileTreeCollapse } from "@/presentation/FileEntryList";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 3) }, (_, index) => ({
        index,
        key: index,
        size: 29,
        start: index * 29,
      })),
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("FileEntryList", () => {
  afterEach(cleanup);

  it("renders only virtual rows for a large file list", () => {
    const files = Array.from({ length: 100 }, (_, index) => ({ path: `src/file-${index}.ts` }));
    const onSelect = vi.fn();

    render(
      <FileEntryList
        files={files}
        mode="path"
        collapse={emptyCollapse()}
        selectedPath={null}
        onSelect={onSelect}
        renderMark={() => "M"}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByText("file-99.ts")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("file-1.ts"));
    expect(onSelect).toHaveBeenCalledWith(files[1]);
  });

  it("constrains a long file name to the available row width", () => {
    const path = `src/generated/${"LongTypeName".repeat(12)}.Designer.cs`;

    render(
      <FileEntryList
        files={[{ path }]}
        mode="path"
        collapse={emptyCollapse()}
        selectedPath={null}
        onSelect={vi.fn()}
        renderMark={() => "M"}
        renderTrailing={() => <span>+10 -2</span>}
      />,
    );

    const row = screen.getByTitle(path);
    const fileName = screen.getByText(`${"LongTypeName".repeat(12)}.Designer.cs`);
    expect(row).toHaveClass("min-w-0", "overflow-hidden");
    expect(fileName).toHaveClass("min-w-0", "flex-1", "truncate");
  });

  it("forwards identical logical file identity for pointer and keyboard context menus", () => {
    const file = { path: "src/app.ts" };
    const onSelect = vi.fn();
    const onFileContextMenu = vi.fn();
    render(
      <FileEntryList
        files={[file]}
        mode="path"
        collapse={emptyCollapse()}
        selectedPath={null}
        onSelect={onSelect}
        onFileContextMenu={onFileContextMenu}
        renderMark={() => "M"}
      />,
    );
    const row = screen.getByTitle(file.path);

    fireEvent.contextMenu(row, { clientX: 42, clientY: 57 });
    fireEvent.keyDown(row, { key: "ContextMenu" });
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });

    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onFileContextMenu.mock.calls.map(([target]) => target)).toEqual([file, file, file]);
    expect(onFileContextMenu).toHaveBeenNthCalledWith(1, file, { x: 42, y: 57 });
    expect(row).toHaveFocus();
  });

  it("does not expose the file context seam on a tree directory row", () => {
    const onFileContextMenu = vi.fn();
    render(
      <FileEntryList
        files={[{ path: "src/app.ts" }]}
        mode="tree"
        collapse={emptyCollapse()}
        selectedPath={null}
        onSelect={vi.fn()}
        onFileContextMenu={onFileContextMenu}
        renderMark={() => "M"}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /src/ }));
    expect(onFileContextMenu).not.toHaveBeenCalled();
  });
});

function emptyCollapse(): FileTreeCollapse {
  return {
    collapsed: new Set(),
    toggle: vi.fn(),
    collapseAll: vi.fn(),
    expandAll: vi.fn(),
    hasDirectories: false,
    allCollapsed: false,
  };
}
