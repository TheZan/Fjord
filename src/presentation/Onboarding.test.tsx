import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Onboarding } from "@/presentation/Onboarding";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("Onboarding", () => {
  it("can create a workspace and continue into repository onboarding", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<Onboarding onCreate={onCreate} />);

    fireEvent.change(screen.getByPlaceholderText("onboarding.workspacePlaceholder"), {
      target: { value: "Projects" },
    });
    fireEvent.click(screen.getByRole("button", { name: "onboarding.createAndAdd" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Projects", true));
  });

  it("can create a workspace without forcing repository setup", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<Onboarding onCreate={onCreate} />);

    fireEvent.click(screen.getByRole("button", { name: "onboarding.createOnly" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("", false));
  });
});
