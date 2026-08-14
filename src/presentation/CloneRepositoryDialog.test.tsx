import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { CloneRepositoryDialog, inferCloneDirectoryName } from "@/presentation/CloneRepositoryDialog";

const pickFolder = vi.fn();
vi.mock("@/infrastructure/dialog", () => ({ pickFolder: () => pickFolder() }));
vi.mock("@/application/errorMessage", () => ({
  userErrorMessage: (error: { code?: string }) => `error:${error.code ?? "unexpected"}`,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function props(overrides: Partial<React.ComponentProps<typeof CloneRepositoryDialog>> = {}) {
  return {
    workspaceId: "workspace-1",
    operations: {},
    onClone: vi.fn(),
    onCancelOperation: vi.fn(),
    onSuccess: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

async function fillForm() {
  fireEvent.change(screen.getByLabelText("clone.url"), {
    target: { value: "git@example.test:team/fjord.git" },
  });
  pickFolder.mockResolvedValue("/repos");
  fireEvent.click(screen.getByRole("button", { name: "clone.choose" }));
  await waitFor(() => expect(screen.getByDisplayValue("/repos")).toBeInTheDocument());
}

describe("CloneRepositoryDialog", () => {
  it("infers folder names from common plain Git URLs", () => {
    expect(inferCloneDirectoryName("https://example.test/team/fjord.git")).toBe("fjord");
    expect(inferCloneDirectoryName("git@example.test:team/fjord.git")).toBe("fjord");
    expect(inferCloneDirectoryName("ssh://git@example.test/team/fjord.git/")).toBe("fjord");
  });

  it("validates inputs, dispatches the typed request, and opens the one result", async () => {
    const repository = {
      id: "repo-1",
      workspaceId: "workspace-1",
      name: "fjord",
      path: "/repos/fjord",
      sortOrder: 0,
    };
    const callbacks = props({
      onClone: vi.fn(() => ({ operationId: "clone:1", promise: Promise.resolve({ repository }) })),
    });
    render(<CloneRepositoryDialog {...callbacks} />);
    expect(screen.getByRole("button", { name: "clone.submit" })).toBeDisabled();

    await fillForm();
    expect(screen.getByDisplayValue("fjord")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "clone.submit" }));

    expect(callbacks.onClone).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      url: "git@example.test:team/fjord.git",
      destinationParent: "/repos",
      directoryName: "fjord",
      branch: null,
    });
    await waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledWith({ repository }));
  });

  it("shows operation progress and dispatches cancellation", async () => {
    let rejectClone: (reason: unknown) => void = () => undefined;
    const pendingClone = new Promise<never>((_resolve, reject) => {
      rejectClone = reject;
    });
    const callbacks = props({
      onClone: vi.fn(() => ({ operationId: "clone:2", promise: pendingClone })),
      onCancelOperation: vi.fn(() => rejectClone({ code: "operation_cancelled" })),
    });
    const view = render(<CloneRepositoryDialog {...callbacks} />);
    await fillForm();
    fireEvent.click(screen.getByRole("button", { name: "clone.submit" }));
    view.rerender(
      <CloneRepositoryDialog
        {...callbacks}
        operations={{
          "clone:2": {
            operationId: "clone:2",
            kind: "clone",
            scope: { type: "workspace", workspaceId: "workspace-1" },
            status: "progress",
            repoId: null,
            completed: 4,
            total: 10,
            message: "Receiving objects",
            error: null,
          },
        }}
      />,
    );
    expect(screen.getByText("Receiving objects")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "clone.progress" })).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
    fireEvent.click(screen.getByRole("button", { name: "operations.cancel" }));
    expect(callbacks.onCancelOperation).toHaveBeenCalledWith("clone:2");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "clone.submit" })).toBeEnabled(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("surfaces typed failures and supports keyboard dismissal when idle", async () => {
    const callbacks = props({
      onClone: vi.fn(() => ({
        operationId: "clone:3",
        promise: Promise.reject({ code: "clone_destination_exists" }),
      })),
    });
    render(<CloneRepositoryDialog {...callbacks} />);
    expect(screen.getByLabelText("clone.url")).toHaveFocus();
    await fillForm();
    fireEvent.click(screen.getByRole("button", { name: "clone.submit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("error:clone_destination_exists");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(callbacks.onBack).toHaveBeenCalledOnce();
  });

  it("passes an automated accessibility scan", async () => {
    const { container } = render(<CloneRepositoryDialog {...props()} />);
    expect(
      (await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations,
    ).toEqual([]);
  });
});
