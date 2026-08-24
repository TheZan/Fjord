import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateStashDialog } from "@/presentation/CreateStashDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const serialized = values
        ? Object.entries(values).map(([name, value]) => `${name}=${value}`).join(",")
        : "";
      return serialized ? `${key}:${serialized}` : key;
    },
  }),
}));

describe("CreateStashDialog", () => {
  it("submits the edited name and the exact one-path scope", () => {
    const onConfirm = vi.fn();
    render(
      <CreateStashDialog
        initialScope={{ kind: "paths", paths: ["a.txt"] }}
        selectedPaths={[{ path: "a.txt", untracked: false }]}
        pathsSupported
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.change(screen.getByLabelText("stash.create.name"), { target: { value: "My stash" } });
    fireEvent.click(screen.getByRole("button", { name: "stash.create.confirm" }));
    expect(onConfirm).toHaveBeenCalledWith({
      scope: { kind: "paths", paths: ["a.txt"] },
      message: "My stash",
      includeUntracked: true,
    });
  });

  it("excludes selected untracked paths from the effective request when unticked", () => {
    const onConfirm = vi.fn();
    render(
      <CreateStashDialog
        initialScope={{ kind: "paths", paths: ["tracked.txt", "new.txt"] }}
        selectedPaths={[
          { path: "tracked.txt", untracked: false },
          { path: "new.txt", untracked: true },
        ]}
        pathsSupported
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByLabelText("stash.create.includeUntracked"));
    expect(screen.getByText(/stash\.create\.untrackedExcluded/)).toHaveTextContent("new.txt");
    expect(screen.getByLabelText("stash.create.selectedFiles")).toHaveTextContent("tracked.txt");
    expect(screen.getByLabelText("stash.create.selectedFiles")).not.toHaveTextContent("new.txt");
    fireEvent.click(screen.getByRole("button", { name: "stash.create.confirm" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: "paths", paths: ["tracked.txt"] },
      includeUntracked: false,
    }));
  });

  it("disables an empty effective Paths scope but keeps All available", () => {
    const onConfirm = vi.fn();
    render(
      <CreateStashDialog
        initialScope={{ kind: "paths", paths: ["new.txt"] }}
        selectedPaths={[{ path: "new.txt", untracked: true }]}
        pathsSupported={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByRole("button", { name: "stash.create.confirm" });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByLabelText("stash.create.all"));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: "all" } }));
  });
});
