import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  openNewThread,
  seedAgentDir,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

// Shift-clicking a second model in the new-chat picker starts the same prompt with both models,
// each chat in its own worktree so their edits never collide.
test("shift-click in the new-chat model picker starts one worktree chat per model", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeGitWorkspace("compare-models-workspace");
  await seedAgentDir(agentDir);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const root = await waitForWorkspaceByPath(window, workspacePath);
    await openNewThread(window);

    const hint = window.locator(".new-thread__hint");
    const modelBadge = hint.locator(".model-selector__badge").first();
    await modelBadge.click();
    await hint.getByRole("button", { name: "GPT-6.1 Sol", exact: true }).click();
    await expect(modelBadge).toHaveAttribute("aria-label", /GPT-6.1 Sol$/i);

    await modelBadge.click();
    await expect(hint.locator(".model-selector__hint")).toContainText("Shift-click");
    const luna = hint.getByRole("button", { name: "GPT-6 Luna", exact: true });
    await luna.click({ modifiers: ["Shift"] });
    // The menu stays open and marks the extra model; the main model is unchanged.
    await expect(luna).toHaveAttribute("data-compared", "");
    await expect(modelBadge).toHaveAttribute("aria-label", /GPT-6.1 Sol$/i);
    await window.keyboard.press("Escape");

    const chips = window.getByTestId("compare-models");
    await expect(chips).toContainText("Also with");
    await expect(chips.getByRole("button")).toHaveCount(1);

    await window.getByTestId("new-thread-composer").fill("Say hello in one word");
    await window.getByRole("button", { name: "Start thread" }).click();

    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          return state.workspaces
            .filter((workspace) => workspace.rootWorkspaceId === root.id)
            .flatMap((workspace) => workspace.sessions.map((session) => session.config?.modelId))
            .filter(Boolean)
            .sort();
        },
        { timeout: 60_000 },
      )
      .toEqual(["gpt-6-luna", "gpt-6.1-sol"]);

    // Both chats live in separate worktrees, and nothing ran in the main checkout.
    const state = await getDesktopState(window);
    const worktrees = state.workspaces.filter(
      (workspace) => workspace.rootWorkspaceId === root.id && workspace.sessions.length > 0,
    );
    expect(worktrees).toHaveLength(2);
    expect(state.workspaces.find((workspace) => workspace.id === root.id)?.sessions).toHaveLength(
      0,
    );
    // The picker resets for the next chat.
    await openNewThread(window);
    await expect(window.getByTestId("compare-models")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
