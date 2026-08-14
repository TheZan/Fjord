import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { CreateRepositoryDialog } from "@/presentation/CreateRepositoryDialog";

const pickFolder = vi.fn();
vi.mock("@/infrastructure/dialog", () => ({ pickFolder: () => pickFolder() }));
vi.mock("@/application/errorMessage", () => ({
  userErrorMessage: (error: { code?: string }) => `error:${error.code ?? "unexpected"}`,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function props(overrides: Partial<React.ComponentProps<typeof CreateRepositoryDialog>> = {}) {
  return {
    workspaceId: "workspace-1",
    onCreate: vi.fn(),
    onSuccess: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

async function fillForm() {
  fireEvent.change(screen.getByLabelText("createRepository.name"), {
    target: { value: "fjord-local" },
  });
  pickFolder.mockResolvedValue("/repos");
  fireEvent.click(screen.getByRole("button", { name: "createRepository.choose" }));
  await waitFor(() => expect(screen.getByDisplayValue("/repos")).toBeInTheDocument());
}

describe("CreateRepositoryDialog", () => {
  it("validates inputs and creates the typed default-main request", async () => {
    const repository = {
      id: "repo-1",
      workspaceId: "workspace-1",
      name: "fjord-local",
      path: "/repos/fjord-local",
      sortOrder: 0,
    };
    const callbacks = props({ onCreate: vi.fn(async () => ({ repository })) });
    render(<CreateRepositoryDialog {...callbacks} />);
    expect(screen.getByRole("button", { name: "createRepository.submit" })).toBeDisabled();

    await fillForm();
    fireEvent.click(screen.getByRole("button", { name: "createRepository.submit" }));

    expect(callbacks.onCreate).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      destinationParent: "/repos",
      directoryName: "fjord-local",
      initialBranch: "main",
    });
    await waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledWith({ repository }));
  });

  it("keeps the form disabled while creating and surfaces a typed failure", async () => {
    let rejectCreate: (reason: unknown) => void = () => undefined;
    const pendingCreate = new Promise<never>((_resolve, reject) => {
      rejectCreate = reject;
    });
    const callbacks = props({ onCreate: vi.fn(() => pendingCreate) });
    render(<CreateRepositoryDialog {...callbacks} />);
    await fillForm();
    fireEvent.click(screen.getByRole("button", { name: "createRepository.submit" }));
    expect(screen.getByLabelText("createRepository.name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "createRepository.creating" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(callbacks.onBack).not.toHaveBeenCalled();

    rejectCreate({ code: "create_repository_destination_not_empty" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "error:create_repository_destination_not_empty",
    );
  });

  it("traps initial focus and dismisses with Escape only while idle", async () => {
    const callbacks = props();
    render(<CreateRepositoryDialog {...callbacks} />);
    expect(screen.getByLabelText("createRepository.name")).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(callbacks.onBack).toHaveBeenCalledOnce();
  });

  it("rejects unsafe repository names and branch names before dispatch", async () => {
    const callbacks = props();
    render(<CreateRepositoryDialog {...callbacks} />);
    fireEvent.change(screen.getByLabelText("createRepository.name"), {
      target: { value: "../fjord" },
    });
    expect(screen.getByText("createRepository.validation.name")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("createRepository.name"), {
      target: { value: "fjord" },
    });
    pickFolder.mockResolvedValue("/repos");
    fireEvent.click(screen.getByRole("button", { name: "createRepository.choose" }));
    await waitFor(() => expect(screen.getByDisplayValue("/repos")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("createRepository.initialBranch"), {
      target: { value: "bad branch" },
    });
    expect(screen.getByText("createRepository.validation.branch")).toBeInTheDocument();
    expect(callbacks.onCreate).not.toHaveBeenCalled();
  });

  it("passes an automated accessibility scan", async () => {
    const { container } = render(<CreateRepositoryDialog {...props()} />);
    expect(
      (await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations,
    ).toEqual([]);
  });
});
