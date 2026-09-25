/// <reference types="node" />
import { expect, test, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { installTauriMock } from "./fixtures/tauriMock";

// P12-MERGE-03 (docs/specs/conflict-resolution.md §Testing strategy, E2E):
// merge a conflicting branch from the branch tree, resolve every path inside
// Fjord with no merge tool configured, Continue, and assert the merge
// commit's tree is exactly the chosen sides.
test("resolves a real merge conflict entirely inside Fjord and commits the chosen sides", async ({ page }) => {
  test.setTimeout(60_000);
  const directory = mkdtempSync(join(tmpdir(), "fjord-conflict-e2e-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "-b", "develop");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "Fjord E2E"); git("config", "user.email", "e2e@fjord.invalid");
  writeFileSync(join(directory, "a.txt"), "base a\n");
  writeFileSync(join(directory, "b.txt"), "base b\n");
  writeFileSync(join(directory, "gone.txt"), "base gone\n");
  git("add", "."); git("commit", "-m", "base");
  git("branch", "feature");
  writeFileSync(join(directory, "a.txt"), "develop a\n");
  writeFileSync(join(directory, "b.txt"), "develop b\n");
  writeFileSync(join(directory, "gone.txt"), "develop edit\n");
  git("commit", "-am", "develop change");
  git("checkout", "feature");
  writeFileSync(join(directory, "a.txt"), "feature a\n");
  writeFileSync(join(directory, "b.txt"), "feature b\n");
  git("rm", "-q", "gone.txt");
  git("commit", "-am", "feature change");
  git("checkout", "develop");
  const developTip = git("rev-parse", "develop");
  const featureTip = git("rev-parse", "feature");

  const executable = resolve("target/debug/examples/rebase_e2e" + (process.platform === "win32" ? ".exe" : ""));
  const fixtureExecutable = join(directory, ".git", "rebase_e2e" + (process.platform === "win32" ? ".exe" : ""));
  copyFileSync(executable, fixtureExecutable);
  const child = spawn(fixtureExecutable, [directory], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const queue: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const calls: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith("FJORD_E2E:")) return;
    const response = JSON.parse(line.slice("FJORD_E2E:".length));
    const pending = queue.shift()!;
    if (response.error) pending.reject(new Error(response.error)); else pending.resolve(response.result);
  });
  child.on("error", (error) => queue.splice(0).forEach((pending) => pending.reject(error)));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
  child.on("exit", (code) => queue.splice(0).forEach((pending) => pending.reject(new Error(`Git fixture exited ${code}: ${stderr}`))));
  try {
    await page.exposeFunction("fjordRealGit", (command: string, args: Record<string, unknown>) => new Promise((resolve, reject) => {
      if (child.exitCode !== null) { reject(new Error(`Git fixture exited: ${stderr}`)); return; }
      calls.push(command); queue.push({ resolve, reject }); child.stdin.write(JSON.stringify({ command, args }) + "\n");
    }));
    await installTauriMock(page, {
      workspaces: [{ id: "ws-100", name: "Conflicts", sortOrder: 0, expectedBranch: null }],
      repositories: [{ id: "repo-conflict", workspaceId: "ws-100", name: "conflict-fixture", path: directory, sortOrder: 0 }],
      statuses: [{ repoId: "repo-conflict", status: { branch: "develop", ahead: 0, behind: 0, dirtyCount: 0, hasConflict: false }, lastSyncedAt: null }],
      health: [],
    });
    await page.goto("/");
    await page.getByText("conflict-fixture", { exact: true }).first().click();

    await page.getByRole("list").getByRole("button", { name: "feature", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Merge feature into develop…", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Merge", exact: true }).click();
    // The dialog closes once the merge's query invalidation settles; under this
    // fixture one refetch runs through TanStack's retry backoff (~7 s).
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 });

    await page.getByText("Uncommitted changes", { exact: true }).first().click();
    const group = page.getByRole("region", { name: "Conflicts" });
    await expect(group.getByRole("option")).toHaveCount(3);
    await expect(group.getByText("changed on develop, deleted on feature")).toBeVisible();

    await resolveFromMenu(page, "a.txt", "Keep develop version");
    await expect(group.getByRole("option")).toHaveCount(2);
    await resolveFromMenu(page, "b.txt", "Keep feature version");
    await expect(group.getByRole("option")).toHaveCount(1);
    await resolveFromMenu(page, "gone.txt", "Delete file");
    await expect(page.getByRole("region", { name: "Conflicts" })).toHaveCount(0);

    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(() => git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length).toBe(3);
    expect(git("rev-parse", "HEAD^1")).toBe(developTip);
    expect(git("rev-parse", "HEAD^2")).toBe(featureTip);
    expect(git("rev-parse", "HEAD:a.txt")).toBe(git("rev-parse", `${developTip}:a.txt`));
    expect(git("rev-parse", "HEAD:b.txt")).toBe(git("rev-parse", `${featureTip}:b.txt`));
    expect(git("ls-tree", "--name-only", "HEAD")).toBe(["a.txt", "b.txt"].join("\n"));
    expect(existsSync(join(directory, "gone.txt"))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
    expect(calls).toEqual(expect.arrayContaining([
      "get_merge_preflight", "merge_branch", "get_conflicts", "resolve_conflict", "continue_operation",
    ]));
    expect(calls).not.toContain("open_merge_tool");
  } finally {
    child.stdin.end();
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

async function resolveFromMenu(page: Page, file: string, action: string) {
  const group = page.getByRole("region", { name: "Conflicts" });
  await group.getByRole("option", { name: new RegExp(file.replace(".", "\\.")) }).click({ button: "right" });
  await page.getByRole("menu", { name: file }).getByRole("menuitem", { name: action, exact: true }).click();
}
