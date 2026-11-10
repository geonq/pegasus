import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  commitAllInGitRepo,
  createNamedThread,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSidePanel,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);
const SHOTS = process.env.PI_REVIEW_SHOTS ?? "";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function shot(target: Locator | Page, name: string) {
  if (SHOTS) await target.screenshot({ path: join(SHOTS, name) });
}

async function openReview(workspacePath: string) {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  const window = await harness.firstWindow();
  const workspace = await waitForWorkspaceByPath(window, workspacePath);
  await createNamedThread(window, "Review task", { workspaceName: workspace.name });
  await selectSidePanel(window, "Review");
  const panel = window.getByRole("region", { name: "Review", exact: true });
  await expect(panel).toBeVisible();
  return { harness, window, panel };
}

const BASE = Array.from({ length: 12 }, (_, i) => `const value${i + 1} = ${i + 1};`).join("\n");

test("line comments: click a line, extend with the keyboard, send them as one prompt", async () => {
  const workspacePath = await makeWorkspace("review-line-comments");
  await initGitRepo(workspacePath);
  await writeFile(join(workspacePath, "calc.ts"), `${BASE}\n`);
  await commitAllInGitRepo(workspacePath, "Baseline");
  const changed = BASE.replace("value5 = 5", "value5 = 50").replace("value6 = 6", "value6 = 60");
  await writeFile(join(workspacePath, "calc.ts"), `${changed}\nexport const total = value5 + value6;\n`);
  const { harness, window, panel } = await openReview(workspacePath);
  try {
    const diff = panel.locator(".diff-inline--annotatable");
    await expect(diff).toBeVisible();

    // Mouse: the gutter button on an added line opens the comment box.
    await panel.getByRole("button", { name: "Comment on line 5", exact: true }).click();
    const box = panel.getByRole("textbox", { name: /Comment on calc\.ts:5/ });
    await expect(box).toBeFocused();
    await box.fill("Why 50 and not a named constant?");
    await shot(panel, "diffcomments-1-composer.png");
    await panel.getByRole("button", { name: "Add comment", exact: true }).click();
    await expect(panel.getByTestId("diff-comment")).toHaveCount(1);

    // Keyboard: focus a line, Shift+Down extends, C opens the box, Ctrl+Enter adds.
    const row = diff.locator('[data-row]:has-text("value6 = 60")').last();
    await row.focus();
    await window.keyboard.press("Shift+ArrowDown");
    await window.keyboard.press("c");
    const second = panel.getByRole("textbox", { name: /Comment on calc\.ts:6-/ });
    await expect(second).toBeFocused();
    await second.fill("Export these two together.");
    await window.keyboard.press("Control+Enter");
    await expect(panel.getByTestId("diff-comment")).toHaveCount(2);

    // Escape cancels without leaving a comment.
    await row.focus();
    await window.keyboard.press("c");
    await window.keyboard.press("Escape");
    await expect(panel.getByTestId("diff-comment")).toHaveCount(2);
    await expect(row).toBeFocused();

    // Comments survive refreshing the comparison.
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(panel.getByTestId("diff-comment")).toHaveCount(2);
    await shot(panel, "diffcomments-2-comments.png");

    const bar = panel.getByTestId("review-comments-bar");
    await expect(bar).toContainText("2 comments");
    // The owner's half-typed message must survive sending the comments.
    const composer = window.getByTestId("composer");
    await composer.fill("half-typed draft stays");
    await bar.getByRole("button", { name: "Send 2 comments to agent" }).click();
    await expect(bar).toHaveCount(0, { timeout: 15_000 });
    await expect(composer).toHaveValue("half-typed draft stays");
    // The prompt reaches the chat as one message with references and quoted code.
    const message = window.locator(".message--user, [data-role='user']").last();
    await expect(window.getByText("Review comments on the current changes (2 comments)")).toBeVisible({
      timeout: 15_000,
    });
    await expect(window.getByText("calc.ts:5", { exact: false }).first()).toBeVisible();
    void message;
    await shot(window, "diffcomments-3-sent.png");
  } finally {
    await harness.close();
  }
});

test("git actions: stage all, commit with an editable draft, push, then the PR step", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-git-ui-"));
  const remote = join(root, "remote.git");
  await git(root, "init", "--bare", "-b", "main", remote);
  const workspacePath = await makeWorkspace("review-git-actions");
  await initGitRepo(workspacePath);
  await writeFile(join(workspacePath, "notes.md"), "# Notes\n");
  await commitAllInGitRepo(workspacePath, "Baseline");
  await git(workspacePath, "remote", "add", "origin", remote);
  await git(workspacePath, "push", "-u", "origin", "main");
  await git(workspacePath, "remote", "set-head", "origin", "main");
  await git(workspacePath, "checkout", "-b", "feature/notes");
  await writeFile(join(workspacePath, "notes.md"), "# Notes\n\nA new paragraph.\n");
  await writeFile(join(workspacePath, "todo.md"), "- ship\n");
  const { harness, window, panel } = await openReview(workspacePath);
  try {
    const button = panel.getByTestId("review-git-button");
    await expect(button).toHaveText("Stage all");
    await shot(panel, "gitactions-1-stage.png");
    await button.click();
    await expect(button).toHaveText("Commit");
    expect(await git(workspacePath, "diff", "--cached", "--name-only")).toContain("notes.md");

    await button.click();
    const dialog = panel.getByRole("dialog", { name: "Commit message" });
    const title = dialog.getByRole("textbox", { name: "Commit message" });
    // With no model signed in the draft falls back to a plain summary, still editable.
    await expect(title).not.toHaveValue("", { timeout: 20_000 });
    await shot(panel, "gitactions-2-commit.png");
    await title.fill("Add notes paragraph and todo list");
    await dialog.getByRole("button", { name: "Commit", exact: true }).click();
    await expect(button).toHaveText("Push");
    expect(await git(workspacePath, "log", "-1", "--format=%s")).toBe(
      "Add notes paragraph and todo list",
    );

    await button.click();
    await expect(button).toHaveText(/Create PR|Open PR page/, { timeout: 20_000 });
    expect(await git(remote, "branch", "--list", "feature/notes")).toContain("feature/notes");
    expect(await git(workspacePath, "status", "--short", "--branch")).toContain(
      "origin/feature/notes",
    );

    // The remote is a local folder, so the PR step explains that instead of failing silently.
    await button.click();
    const prDialog = panel.getByRole("dialog", { name: "Pull request" });
    await expect(prDialog.getByRole("textbox", { name: "Pull request title" })).not.toHaveValue("", {
      timeout: 20_000,
    });
    await shot(panel, "gitactions-3-pr.png");
    await prDialog.getByRole("button", { name: /Create PR|Open PR page/ }).click();
    await expect(prDialog.getByRole("alert")).toContainText("GitHub");
    await shot(panel, "gitactions-4-error.png");
    await window.keyboard.press("Escape");
    await expect(prDialog).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
