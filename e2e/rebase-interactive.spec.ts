/// <reference types="node" />
import { expect, test } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { installTauriMock } from "./fixtures/tauriMock";

test("UI interactive rebase squashes a conflicting commit and rewords another, with Abort offered until completion", async ({ page }) => {
  test.setTimeout(60_000);
  const directory = mkdtempSync(join(tmpdir(), "fjord-rebase-interactive-e2e-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "-b", "develop");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "Fjord E2E"); git("config", "user.email", "e2e@fjord.invalid");
  writeFileSync(join(directory, "conflict.txt"), "base\n"); git("add", "."); git("commit", "-m", "base");
  git("branch", "feature");
  writeFileSync(join(directory, "conflict.txt"), "develop\n"); git("commit", "-am", "develop change");
  git("checkout", "feature");
  writeFileSync(join(directory, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-m", "commit a");
  writeFileSync(join(directory, "conflict.txt"), "feature\n"); git("commit", "-am", "commit b");
  writeFileSync(join(directory, "c.txt"), "c\n"); git("add", "c.txt"); git("commit", "-m", "commit c");
  const tool = join(directory, ".git", "resolve.cjs");
  writeFileSync(tool, 'require("node:fs").writeFileSync(process.argv[2], "resolved\\n");');
  git("config", "merge.tool", "fixture");
  git("config", "mergetool.fixture.cmd", `"${process.execPath.replaceAll("\\", "/")}" "${tool.replaceAll("\\", "/")}" "$MERGED"`);
  git("config", "mergetool.fixture.trustExitCode", "true");
  git("config", "mergetool.keepBackup", "false");
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
      workspaces: [{ id: "ws-100", name: "Rebase", sortOrder: 0, expectedBranch: null }],
      repositories: [{ id: "repo-rebase", workspaceId: "ws-100", name: "rebase-fixture", path: directory, sortOrder: 0 }],
      statuses: [{ repoId: "repo-rebase", status: { branch: "feature", ahead: 0, behind: 0, dirtyCount: 0, hasConflict: false }, lastSyncedAt: null }],
      health: [],
    });
    await page.goto("/");
    await page.getByText("rebase-fixture", { exact: true }).first().click();
    await page.getByRole("list").getByRole("button", { name: "develop", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Interactive rebase feature onto develop…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Interactive rebase: feature onto develop" });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("combobox", { name: "Action for commit b" }).selectOption("squash");
    await dialog.getByRole("textbox", { name: "New message for commit b" }).fill("Squashed a and b");
    await dialog.getByRole("combobox", { name: "Action for commit c" }).selectOption("reword");
    await dialog.getByRole("textbox", { name: "New message for commit c" }).fill("Reworded c");
    await dialog.getByRole("button", { name: "Start rebase", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // The conflict from `commit b`'s squash surfaces exactly like basic
    // rebase's; Abort stays offered next to Continue the whole time.
    await expect(page.getByText(/Rebase.*interactive/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Abort", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open merge tool", exact: true }).first().click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(() => git("status", "--porcelain")).toBe("");
    await expect.poll(() => git("log", "--format=%s", "develop..HEAD")).toBe("Reworded c\nSquashed a and b");
    expect(readFileSync(join(directory, "conflict.txt"), "utf8")).toBe("resolved\n");
    expect(readFileSync(join(directory, "a.txt"), "utf8")).toBe("a\n");
    expect(readFileSync(join(directory, "c.txt"), "utf8")).toBe("c\n");
    expect(calls).toEqual(expect.arrayContaining(["get_rebase_todo", "start_interactive_rebase", "get_repo_operation_state", "open_merge_tool", "continue_operation"]));
  } finally {
    child.stdin.end();
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
