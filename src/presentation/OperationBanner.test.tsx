import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import type { RepoOperation, RepoOperationState } from "@/domain/generated";
import { OperationBanner } from "@/presentation/OperationBanner";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (!values) return key;
      return `${key} ${Object.values(values).join(" ")}`;
    },
  }),
}));

function state(
  operation: RepoOperation,
  overrides: Partial<RepoOperationState> = {},
): RepoOperationState {
  return {
    operation,
    conflictedPaths: [],
    available: [],
    detectedExternally: false,
    ...overrides,
  };
}

function props(operationState: RepoOperationState) {
  return {
    state: operationState,
    validated: true,
    pendingControl: null,
    onControl: vi.fn(),
    onOpenMergeTool: vi.fn(),
  } as const;
}

describe("OperationBanner", () => {
  it.each([
    [{ kind: "merge", head: "head", incoming: ["incoming"] }, "operationBanner.states.merge"],
    [{ kind: "rebase", rebaseKind: "merge", onto: "base", current: 3, total: 7, headName: "refs/heads/topic" }, "operationBanner.states.rebase"],
    [{ kind: "cherryPick", commit: "1234567890" }, "operationBanner.states.cherryPick"],
    [{ kind: "revert", commit: "1234567890" }, "operationBanner.states.revert"],
    [{ kind: "bisect", good: 2, bad: 1 }, "operationBanner.states.bisect"],
    [{ kind: "detached", head: "1234567890" }, "operationBanner.states.detached"],
    [{ kind: "unbornBranch" }, "operationBanner.states.unbornBranch"],
  ] satisfies Array<[RepoOperation, string]>)(
    "renders %# operation state",
    (operation, titleKey) => {
      render(<OperationBanner {...props(state(operation))} />);
      expect(screen.getByText(new RegExp(titleKey))).toBeInTheDocument();
    },
  );

  it("shows rebase progress, internal wording, and dispatches available controls", () => {
    const bannerProps = props(state(
      {
        kind: "rebase",
        rebaseKind: "interactive",
        onto: "base",
        current: 3,
        total: 7,
        headName: "refs/heads/topic",
      },
      { available: ["continue", "skip", "abort"] },
    ));
    render(<OperationBanner {...bannerProps} />);

    expect(screen.getByText(/operationBanner.states.rebase 3 7/)).toBeInTheDocument();
    expect(screen.getByText("operationBanner.startedHere")).toBeInTheDocument();
    for (const control of ["continue", "skip", "abort"] as const) {
      fireEvent.click(screen.getByRole("button", { name: `operationBanner.controls.${control}` }));
      expect(bannerProps.onControl).toHaveBeenCalledWith(control);
    }
  });

  it("uses distinct external wording, lists bounded conflicts, and opens the merge tool", () => {
    const bannerProps = props(state(
      { kind: "merge", head: "head", incoming: ["incoming"] },
      {
        detectedExternally: true,
        conflictedPaths: ["a", "b", "c", "d", "e", "f"],
        available: ["abort"],
      },
    ));
    render(<OperationBanner {...bannerProps} />);

    expect(screen.getByText("operationBanner.external")).toBeInTheDocument();
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.queryByText("f")).not.toBeInTheDocument();
    expect(screen.getByText(/operationBanner.moreConflicts 1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "repoStatus.openMergeTool" }));
    expect(bannerProps.onOpenMergeTool).toHaveBeenCalledOnce();
  });

  it("disables controls while validation is pending and explains why", () => {
    render(
      <OperationBanner
        {...props(state(
          { kind: "cherryPick", commit: "1234567" },
          { available: ["skip", "abort"] },
        ))}
        validated={false}
      />,
    );

    for (const control of ["skip", "abort"] as const) {
      const button = screen.getByRole("button", { name: `operationBanner.controls.${control}` });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "snapshot.validationFailed");
    }
  });

  it("renders nothing for a normal repository", () => {
    const { container } = render(<OperationBanner {...props(state({ kind: "normal" }))} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("passes an automated accessibility scan", async () => {
    const { container } = render(
      <OperationBanner
        {...props(state(
          { kind: "revert", commit: "1234567" },
          { available: ["continue", "abort"], conflictedPaths: ["src/app.ts"] },
        ))}
      />,
    );
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });
});
