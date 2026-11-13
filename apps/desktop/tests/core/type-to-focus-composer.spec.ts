import { expect, test } from "@playwright/test";
import {
  createSessionViaIpc,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
  selectSession,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("typing or pasting on the transcript goes to the composer", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("type-to-focus");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createSessionViaIpc(window, workspacePath, "typing");
    await selectSession(window, "typing");
    await seedTranscriptMessages(harness, window, { count: 3 });

    const composer = window.getByTestId("composer");
    const pane = window.getByTestId("timeline-pane");
    await pane.focus();
    await expect(pane).toBeFocused();

    // A printable key on the transcript moves focus to the composer and is typed there.
    await window.keyboard.type("Hello");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Hello");

    // A text paste on the transcript lands at the end of the draft.
    await pane.focus();
    await window.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", " pasted");
      document
        .querySelector("[data-testid='timeline-pane']")!
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    });
    await expect(composer).toHaveValue("Hello pasted");

    // Space and arrows keep scrolling the transcript instead of typing.
    await pane.focus();
    await window.keyboard.press("Space");
    await window.keyboard.press("ArrowUp");
    await expect(pane).toBeFocused();
    await expect(composer).toHaveValue("Hello pasted");

    // Keys typed in another field stay there.
    await window.keyboard.press(process.platform === "darwin" ? "Meta+F" : "Control+F");
    const search = window.getByTestId("thread-search-bar").locator("input");
    await expect(search).toBeFocused();
    await window.keyboard.type("row");
    await expect(search).toHaveValue("row");
    await expect(composer).toHaveValue("Hello pasted");
  } finally {
    await harness.close();
  }
});
