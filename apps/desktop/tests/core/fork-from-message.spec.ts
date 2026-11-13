import { expect, test } from "@playwright/test";
import { join } from "node:path";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedForkSessionFixture,
  selectSession,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { copiedTexts, stubClipboard } from "../helpers/clipboard";

test("forks a thread from an assistant response into a new sidebar session", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("fork-from-message-workspace");
  await seedAgentDir(agentDir);
  await seedForkSessionFixture(agentDir, workspacePath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Fork fixture session");

    const transcript = window.getByTestId("transcript");
    await expect(transcript).toContainText("Third fork question");

    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    const before = await getDesktopState(window);
    const beforeWorkspace = before.workspaces.find((entry) => entry.id === workspace.id);
    const beforeSessionCount = beforeWorkspace?.sessions.length ?? 0;
    const beforeSelectedSessionId = before.selectedSessionId;

    // Fork after the second assistant response (codex-style); history up to and including it branches off.
    const secondAnswer = transcript.locator(".timeline-item--assistant", {
      hasText: "Second fork answer",
    });
    await secondAnswer.hover();

    // Copy sits beside Fork and copies the reply's markdown; a user prompt has its own copy.
    await stubClipboard(window);
    const copyAnswer = secondAnswer.getByTestId("copy-message");
    await copyAnswer.click();
    await expect(copyAnswer).toHaveAttribute("aria-label", "Copied");
    const question = transcript.locator(".timeline-item--user", { hasText: "Second fork question" });
    const questionHeight = (await question.boundingBox())!.height;
    await question.hover();
    await question.getByTestId("copy-message").click();
    const copied = await copiedTexts(window);
    expect(copied[0]).toContain("Second fork answer");
    expect(copied[1]).toContain("Second fork question");
    // The user copy button sits beside the bubble, so the row did not grow for it.
    expect((await question.boundingBox())!.height).toBe(questionHeight);
    if (process.env.PI_APP_SHOTS_DIR) {
      await window.screenshot({ path: join(process.env.PI_APP_SHOTS_DIR, "copy-message.png") });
    }

    await secondAnswer.hover();
    await secondAnswer.getByTestId("fork-from-message").click();

    const forkModal = window.getByTestId("fork-modal");
    await expect(forkModal).toBeVisible();
    await expect(window.getByTestId("fork-modal-preview")).toContainText("Second fork answer");
    await expect(forkModal.getByLabel("Fork environment")).toHaveValue("local");

    await window.getByTestId("fork-modal-confirm").click();
    await expect(forkModal).toHaveCount(0);

    // A new session is created and selected.
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const ws = state.workspaces.find((entry) => entry.id === workspace.id);
        return ws?.sessions.length ?? 0;
      })
      .toBe(beforeSessionCount + 1);

    const after = await getDesktopState(window);
    expect(after.selectedSessionId).not.toBe(beforeSelectedSessionId);
    expect(after.selectedWorkspaceId).toBe(workspace.id);

    // The composer starts empty so the forked thread continues from the existing history (codex-style).
    await expect(window.getByTestId("composer")).toHaveValue("");

    // The branched transcript keeps the full history up to and including the forked response.
    await expect(transcript).toContainText("First fork answer");
    await expect(transcript).toContainText("Second fork question");
    await expect(transcript).toContainText("Second fork answer");
    // Everything after the fork point is dropped.
    await expect(transcript).not.toContainText("Third fork question");
  } finally {
    await harness.close();
  }
});
