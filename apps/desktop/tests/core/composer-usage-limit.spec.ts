import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { AccountLimits } from "../../contracts/usage";
import { desktopIpc } from "../../contracts/ipc";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const proofDir = process.env.PI_APP_COMPOSER_PROOF_DIR;

test("warns above the composer when the selected model's account is running low", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-usage-limit");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    // The test agent's default model is openai; serve it as 85 % used before any reader polls.
    const limits: readonly AccountLimits[] = [
      {
        id: "openai",
        name: "ChatGPT · Test",
        windows: [
          { label: "5-hour", usedPercent: 40 },
          { label: "Weekly", usedPercent: 85 },
        ],
        asOf: Date.now(),
      },
    ];
    await harness.electronApp.evaluate(
      ({ ipcMain }, { channel, value }) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => value);
      },
      { channel: desktopIpc.getAccountLimits, value: limits },
    );
    await window.reload();
    await createNamedThread(window, "Usage limit target");

    const notice = window.getByTestId("composer-usage-limit");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("data-state", "low");
    await expect(notice).toContainText("ChatGPT · Test is running low");
    await expect(notice).toContainText("85% of the Weekly window used");
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await window.screenshot({ path: join(proofDir, "composer-usage-limit.png") });
    }

    // Below 80 % on every window: no notice.
    await harness.electronApp.evaluate(
      ({ ipcMain }, { channel, value }) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => value);
      },
      {
        channel: desktopIpc.getAccountLimits,
        value: [{ ...limits[0]!, windows: [{ label: "Weekly", usedPercent: 50 }] }],
      },
    );
    await window.reload();
    await expect(window.getByTestId("composer")).toBeVisible();
    await expect(window.getByTestId("composer-usage-limit")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
