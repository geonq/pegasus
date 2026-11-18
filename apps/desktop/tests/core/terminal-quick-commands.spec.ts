import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const proofDir = process.env.PI_APP_QUICK_COMMANDS_PROOF_DIR;

test("saves quick commands per project in the host and runs one in the terminal", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("quick-commands-root");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Quick commands thread");
    await selectSidePanel(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    const strip = window.getByTestId("terminal-quick-commands");
    await expect(strip).toContainText("No quick commands for this project yet");

    await strip.getByRole("button", { name: "Add quick command" }).click();
    await strip.getByLabel("Name", { exact: true }).fill("Say hi");
    await strip.getByLabel("Command", { exact: true }).fill("echo QUICK_CMD_RAN");
    await strip.getByRole("button", { name: "Add", exact: true }).click();
    await expect(strip.getByTestId("quick-command")).toHaveText(["Say hi"]);

    // Edit renames it and changes the command.
    await strip.getByRole("button", { name: "Edit", exact: true }).click();
    await strip.getByLabel("Name", { exact: true }).fill("Greet");
    await strip.getByLabel("Command", { exact: true }).fill("echo QUICK_CMD_EDITED");
    await strip.getByRole("button", { name: "Save", exact: true }).click();
    await expect(strip.getByTestId("quick-command")).toHaveText(["Greet"]);

    // The host stores it in the agent dir, keyed by the project folder.
    const saved = JSON.parse(
      await readFile(join(userDataDir, "agent", "pegasus-quick-commands.json"), "utf8"),
    ) as { projects: Record<string, { name: string; command: string }[]> };
    expect(Object.values(saved.projects)).toEqual([
      [expect.objectContaining({ name: "Greet", command: "echo QUICK_CMD_EDITED" })],
    ]);

    // One click: the host types it into the shell and presses Enter.
    await strip.getByTestId("quick-command").click();
    await expect(terminal.locator(".xterm-rows")).toContainText("QUICK_CMD_EDITED", {
      timeout: 15_000,
    });
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await window.screenshot({ path: join(proofDir, "terminal-quick-commands.png") });
    }

    await strip.getByRole("button", { name: "Delete Greet" }).click();
    await expect(strip.getByTestId("quick-command")).toHaveCount(0);
    await expect(strip).toContainText("No quick commands for this project yet");
  } finally {
    await harness.close();
  }
});
