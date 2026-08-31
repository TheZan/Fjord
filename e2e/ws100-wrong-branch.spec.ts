import { expect, test } from "@playwright/test";
import { installTauriMock } from "./fixtures/tauriMock";
import { ws100Fixture } from "./fixtures/workspaceFixtures";

test("filters ws-100 to the backend WrongBranch result set", async ({ page }) => {
  await installTauriMock(page, ws100Fixture);
  await page.goto("/");

  await page.getByRole("button", { name: "All repositories", exact: true }).click();

  const screen = page.locator("[data-shell-screen]");
  await expect(screen.getByRole("heading", { name: "All repositories" })).toBeVisible();
  await expect(screen.getByText("100 repos", { exact: true })).toBeVisible();

  const wrongBranch = screen.getByRole("button", { name: "Wrong branch", exact: true });
  await expect(wrongBranch).toHaveAttribute("aria-pressed", "false");
  await wrongBranch.click();

  await expect(wrongBranch).toHaveAttribute("aria-pressed", "true");
  await expect(screen.getByText("10 repos", { exact: true })).toBeVisible();
  await expect(screen.getByText("repo-000", { exact: true })).toBeVisible();
  await expect(screen.getByText("repo-010", { exact: true })).toBeVisible();
  await expect(screen.getByText("repo-001", { exact: true })).toHaveCount(0);
  await expect(screen.getByText("repo-011", { exact: true })).toHaveCount(0);

  await screen.getByRole("button", { name: "Clear", exact: true }).click();

  await expect(wrongBranch).toHaveAttribute("aria-pressed", "false");
  await expect(screen.getByText("100 repos", { exact: true })).toBeVisible();
  await expect(screen.getByText("repo-001", { exact: true })).toBeVisible();
});
