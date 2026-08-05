import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AllReposView } from "@/presentation/AllReposView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) =>
      key === "dashboard.repoCountValue" ? `${values?.count ?? 0} repositories` : key,
  }),
}));

describe("AllReposView", () => {
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
      />,
    );

    const input = screen.getByPlaceholderText("allRepositories.filterPlaceholder");
    fireEvent.change(input, { target: { value: "api" } });

    expect(screen.getByText("allRepositories.empty")).toBeInTheDocument();
    expect(screen.getByText("0 repositories")).toBeInTheDocument();
    expect(onFilterChange).toHaveBeenCalledWith("api");
  });
});
