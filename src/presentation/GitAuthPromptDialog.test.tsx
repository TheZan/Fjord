import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitAuthPrompt } from "@/domain/generated";
import { GitAuthPromptDialog } from "@/presentation/GitAuthPromptDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const secretPrompt: GitAuthPrompt = {
  operationId: "op-1",
  promptId: "prompt-1",
  prompt: "Password for https://example.test:",
  kind: "secret",
  repositoryName: "Fjord",
  operationKind: "fetch",
};

describe("GitAuthPromptDialog", () => {
  it("uses a password field and clears the secret before IPC settles", async () => {
    let finish: (() => void) | undefined;
    const onAnswer = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(
      <GitAuthPromptDialog
        prompt={secretPrompt}
        queuedCount={1}
        onAnswer={onAnswer}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("gitAuth.secret") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "very-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "gitAuth.continue" }));

    expect(onAnswer).toHaveBeenCalledWith("very-secret");
    expect(input.value).toBe("");
    finish?.();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
  });

  it("answers confirmation prompts without rendering a credential field", () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <GitAuthPromptDialog
        prompt={{ ...secretPrompt, kind: "confirmation", promptId: "prompt-2" }}
        queuedCount={0}
        onAnswer={onAnswer}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "gitAuth.confirm" }));
    expect(onAnswer).toHaveBeenCalledWith("yes");
  });
});
