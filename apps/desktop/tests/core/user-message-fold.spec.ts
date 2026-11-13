import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

const longPrompt = Array.from(
  { length: 40 },
  (_, index) => `Pasted log line ${index + 1}: something happened here`,
).join("\n\n");

test("long user prompts fold to a short preview that opens and closes", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("user-message-fold");
  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let workspaceId = "";
  let sessionId = "";
  try {
    const window = await first.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Fold thread");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
  } finally {
    await first.close();
  }
  await appendMessagesToSessionFile(
    await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId }),
    [
      { role: "user", text: "Short question stays as is." },
      { role: "assistant", text: "Short answer." },
      { role: "user", text: longPrompt },
      { role: "assistant", text: "Read the whole log." },
    ],
  );

  const second = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await second.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const transcript = window.getByTestId("transcript");
    const shortRow = transcript.locator(".timeline-item--user", { hasText: "Short question" });
    const longRow = transcript.locator(".timeline-item--user", { hasText: "Pasted log line 1:" });
    await expect(longRow).toBeVisible();

    // A short prompt has no fold and no toggle.
    await expect(shortRow.getByTestId("user-message-fold-toggle")).toHaveCount(0);
    await expect(shortRow.getByTestId("user-message-fold")).not.toHaveAttribute("data-folded");

    // The long one is clipped to 11rem (176 px) with a toggle under it.
    const fold = longRow.getByTestId("user-message-fold");
    const toggle = longRow.getByTestId("user-message-fold-toggle");
    await expect(fold).toHaveAttribute("data-folded", "");
    await expect(toggle).toHaveText("Show full message");
    expect(Math.round((await fold.boundingBox())!.height)).toBe(176);
    if (process.env.PI_APP_SHOTS_DIR) {
      await longRow.screenshot({ path: join(process.env.PI_APP_SHOTS_DIR, "fold-closed.png") });
    }

    await toggle.click();
    await expect(toggle).toHaveText("Show less");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(fold).not.toHaveAttribute("data-folded");
    expect((await fold.boundingBox())!.height).toBeGreaterThan(352);
    await expect(longRow.getByText("Pasted log line 40:")).toBeVisible();

    await toggle.click();
    await expect(fold).toHaveAttribute("data-folded", "");
  } finally {
    await second.close();
  }
});
