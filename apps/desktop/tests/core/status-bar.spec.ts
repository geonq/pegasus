import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const proofDir = process.env.PI_APP_STATUS_BAR_PROOF_DIR;

test("the status bar shows the model's plan usage and the host, and opens Usage", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("status-bar-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Status bar thread");
    const bar = window.getByTestId("status-bar");
    await expect(bar).toBeVisible();

    // The Rust host answers the status call.
    await expect(bar.getByTestId("status-bar-host")).toHaveText("Host connected", {
      timeout: 15_000,
    });

    // Full width along the bottom edge, below the floating sidebar card.
    const view = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const barBox = (await bar.boundingBox())!;
    const sidebarBox = (await window.locator("#primary-sidebar").boundingBox())!;
    expect(barBox.x).toBeLessThanOrEqual(1);
    expect(Math.round(barBox.width)).toBeGreaterThanOrEqual(view.width - 1);
    expect(Math.round(barBox.y + barBox.height)).toBe(view.height);
    expect(sidebarBox.y + sidebarBox.height).toBeLessThanOrEqual(barBox.y - 4);

    const usage = bar.getByTestId("status-bar-usage");
    await expect(usage).toBeVisible();
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await window.screenshot({ path: join(proofDir, "status-bar.png") });
    }
    await usage.click();
    await expect(window.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  } finally {
    await harness.close();
  }
});
