import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  chooseThreadGrouping,
  createSessionViaIpc,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const proofDir = process.env.PI_APP_SIDEBAR_PROOF_DIR;

test("Chats lists no folders; Folders folds each folder open and shut from its row", async () => {
  test.setTimeout(150_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-folders-");
  const alphaPath = await makeWorkspace("folders-alpha");
  const betaPath = await makeWorkspace("folders-beta");
  const options = { initialWorkspaces: [alphaPath, betaPath], testMode: "background" } as const;
  const firstRun = await launchDesktop(userDataDir, options);
  let alphaId = "";

  try {
    const window = await firstRun.firstWindow();
    const alpha = await waitForWorkspaceByPath(window, alphaPath);
    await waitForWorkspaceByPath(window, betaPath);
    alphaId = alpha.id;
    await createSessionViaIpc(window, alphaPath, "Alpha one");
    await createSessionViaIpc(window, alphaPath, "Alpha two");
    await createSessionViaIpc(window, betaPath, "Beta one");
    await createSessionViaIpc(window, betaPath, "Beta two");

    const shot = async (name: string) => {
      if (!proofDir) return;
      await mkdir(proofDir, { recursive: true });
      await window.screenshot({ path: join(proofDir, name) });
    };

    // Chats: no folder rows.
    await chooseThreadGrouping(window, "time");
    await expect(window.locator(".workspace-row")).toHaveCount(0);
    await shot("chats-view.png");

    // Tab switch: the new list carries the swap direction and a 180-220 ms transition.
    const folderTab = window
      .getByRole("group", { name: "Sidebar view" })
      .getByRole("button", { name: "Folders", exact: true });
    await folderTab.click();
    const incoming = window.locator(".workspace-list[data-swap]");
    await expect(incoming).toHaveAttribute("data-swap", "to-folders");
    const duration = await incoming.evaluate((el) => getComputedStyle(el).transitionDuration);
    const ms = Number.parseFloat(duration) * 1000;
    expect(ms).toBeGreaterThanOrEqual(180);
    expect(ms).toBeLessThanOrEqual(220);
    await shot("tab-swap-midframe.png");
    await expect(window.locator(".workspace-list")).toHaveCount(1);

    // Folders: rows start open (nothing is collapsed yet); click, Enter and Space toggle.
    const group = (id: string) =>
      window.locator(`.workspace-group[data-workspace-id=${JSON.stringify(id)}]`);
    const row = group(alphaId).locator(".workspace-row__select");
    await expect(window.locator(".workspace-row")).toHaveCount(2);
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(group(alphaId).locator(".session-row__title")).toHaveText([
      "Alpha two",
      "Alpha one",
    ]);
    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(group(alphaId).locator(".session-row")).toHaveCount(0);
    await row.click();
    await expect(group(alphaId).locator(".session-row")).toHaveCount(2);
    await row.focus();
    await window.keyboard.press("Enter");
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await window.keyboard.press("Space");
    await expect(row).toHaveAttribute("aria-expanded", "true");

    // + starts a chat and never toggles the folder; ... opens its menu and never toggles either.
    const before = (await getDesktopState(window)).collapsedWorkspaceIds;
    await group(alphaId)
      .getByRole("button", { name: /^Workspace actions for / })
      .click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await window.keyboard.press("Escape");
    expect((await getDesktopState(window)).collapsedWorkspaceIds).toEqual(before);
    await group(alphaId)
      .getByRole("button", { name: /^New chat in / })
      .click();
    await expect(row).toHaveAttribute("aria-expanded", "true");

    // Leave Alpha shut for the relaunch check.
    await row.click();
    await expect
      .poll(async () => (await getDesktopState(window)).collapsedWorkspaceIds)
      .toEqual([alphaId]);
    await row.click();
    await shot("folders-view-one-expanded.png");
    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect
      .poll(async () => (await getDesktopState(window)).collapsedWorkspaceIds)
      .toEqual([alphaId]);
  } finally {
    await firstRun.close();
  }

  const secondRun = await launchDesktop(userDataDir, options);
  try {
    const window = await secondRun.firstWindow();
    await chooseThreadGrouping(window, "workspace");
    const group = window.locator(`.workspace-group[data-workspace-id=${JSON.stringify(alphaId)}]`);
    await expect(group.locator(".workspace-row__select")).toHaveAttribute("aria-expanded", "false");
    await expect(group.locator(".session-row")).toHaveCount(0);
    await group.locator(".workspace-row__select").click();
    await expect(group.locator(".session-row").first()).toBeVisible();
  } finally {
    await secondRun.close();
  }
});

test("reduced motion swaps tabs with a plain crossfade", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-folders-motion-");
  const workspacePath = await makeWorkspace("folders-motion");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createSessionViaIpc(window, workspacePath, "Motion chat");
    await window.emulateMedia({ reducedMotion: "reduce" });
    await chooseThreadGrouping(window, "time");
    await window
      .getByRole("group", { name: "Sidebar view" })
      .getByRole("button", { name: "Folders", exact: true })
      .click();
    const incoming = window.locator(".workspace-list[data-swap]");
    await expect(incoming).toHaveAttribute("data-swap", "to-folders");
    const style = await incoming.evaluate((el) => {
      const computed = getComputedStyle(el);
      return { transform: computed.transform, duration: computed.transitionDuration };
    });
    expect(style.transform).toBe("none");
    expect(Number.parseFloat(style.duration) * 1000).toBeLessThanOrEqual(120);
    const leaving = window.locator(".workspace-list[data-swap-leaving]");
    if (await leaving.count()) {
      expect(await leaving.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
    }
  } finally {
    await harness.close();
  }
});
