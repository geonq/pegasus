import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

// A waiting chat leading the list is covered in tests/unit/command-palette.spec.ts; a real
// extension dialog needs a model, which the core lane has none of.
test("the palette matches a chat by its folder name", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("folder-match-root");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Quiet older thread");
    await createNamedThread(window, "Newest thread");
    const palette = window.getByTestId("command-palette");
    await window.keyboard.press(desktopShortcut("K"));
    await expect(palette).toBeVisible();
    await window.screenshot({ path: shotPath("palette-recents.png") });

    await window.keyboard.type("folder-match");
    const chats = palette.getByRole("group", { name: "Chats" }).getByRole("option");
    await expect(chats).toHaveCount(2);
    await expect(chats.first()).toContainText("folder-match-root");
    await window.screenshot({ path: shotPath("palette-folder-match.png") });
  } finally {
    await harness.close();
  }
});

function shotPath(name: string): string {
  const dir = process.env.PI_SHOT_DIR;
  return dir ? join(dir, name) : test.info().outputPath(name);
}
