import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const proofDir = process.env.PI_APP_COMPOSER_PROOF_DIR;

// A real OS folder drag cannot be synthesized (DataTransfer entries need a native drag), so this
// drives the IPC the drop handler calls; the host's files.describe does the checking.
test("attaches a dropped folder as a path reference, checked by the host", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-folder-drop");
  const folderPath = join(workspacePath, "design-notes");
  await mkdir(folderPath, { recursive: true });
  const filePath = join(workspacePath, "readme.txt");
  await writeFile(filePath, "not a folder");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Folder drop");
    const attach = (paths: string[]) =>
      window.evaluate(async (folderPaths) => {
        await globalThis.window.piApp?.attachComposerFolders(folderPaths);
      }, paths);

    await attach([folderPath]);
    const chip = window.locator(".composer-attachment--file");
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText("design-notes");
    const state = await getDesktopState(window);
    expect(state.composerAttachments).toEqual([
      expect.objectContaining({
        kind: "file",
        name: "design-notes",
        mimeType: "inode/directory",
        fsPath: folderPath,
      }),
    ]);
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await window.screenshot({ path: join(proofDir, "composer-folder-drop.png") });
    }

    // A file or a missing path is refused whole, named above the composer, and nothing is added.
    const banner = window.getByTestId("composer-error-banner");
    await attach([filePath]);
    await expect(banner).toHaveText("readme.txt is not a folder.");
    await attach([folderPath, join(workspacePath, "gone")]);
    await expect(banner).toHaveText("gone could not be read, so it was not attached.");
    await expect(chip).toHaveCount(1);
  } finally {
    await harness.close();
  }
});
