import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { AllReposView } from "@/presentation/AllReposView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) =>
      key === "dashboard.repoCountValue" ? `${values?.count ?? 0} repositories` : key,
  }),
}));

describe("AllReposView", () => {
  it("passes an automated accessibility scan", async () => {
    const { container } = render(
      <AllReposView
        rows={[]}
        statusByRepo={{}}
        selectedRepoId={null}
        filter=""
        onFilterChange={vi.fn()}
        onSelect={vi.fn()}
        utilities={<div data-testid="shell-utilities" />}
      />,
    );
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });

  it("renders the empty state and reports filter input changes", () => {
    const onFilterChange = vi.fn();

    render(
      <AllReposView
        rows={[]}
        statusByRepo={{}}
        selectedRepoId={null}
        filter=""
        onFilterChange={onFilterChange}
        onSelect={vi.fn()}
        utilities={<div data-testid="shell-utilities" />}
      />,
    );

    const input = screen.getByPlaceholderText("allRepositories.filterPlaceholder");
    fireEvent.change(input, { target: { value: "api" } });

    expect(screen.getByText("allRepositories.empty")).toBeInTheDocument();
    expect(screen.getByText("0 repositories")).toBeInTheDocument();
    expect(onFilterChange).toHaveBeenCalledWith("api");
  });
});
