import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  stubNextOpenDialog,
  writeTinyPng,
} from "../helpers/electron-app";

const proofDir = process.env.PI_APP_COMPOSER_PROOF_DIR;

test("parks a draft with its attachment, keeps it across relaunch, restores and deletes", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-stash");
  const tinyPath = join(workspacePath, "tiny.png");
  await writeTinyPng(tinyPath);

  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await first.firstWindow();
    await createNamedThread(window, "Stash target");
    const composer = window.getByTestId("composer");
    const trigger = window.getByTestId("composer-stash-trigger");

    // Empty state, and nothing to park yet.
    await trigger.click();
    const menu = window.getByTestId("composer-stash-menu");
    await expect(menu.getByText("Nothing parked yet.", { exact: false })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Park current draft" })).toBeDisabled();
    await window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await composer.fill("First parked idea");
    await stubNextOpenDialog(first, [tinyPath]);
    await window.getByRole("button", { name: "Attach files" }).click();
    await expect(window.locator(".composer-attachment")).toHaveCount(1);

    await trigger.click();
    await menu.getByRole("button", { name: "Park current draft" }).click();
    await expect(composer).toHaveValue("");
    await expect(window.locator(".composer-attachment")).toHaveCount(0);
    await expect(trigger).toHaveAccessibleName("Parked drafts: 1");

    await composer.fill("Second parked idea");
    await trigger.click();
    await menu.getByRole("button", { name: "Park current draft" }).click();
    await expect(trigger).toHaveAccessibleName("Parked drafts: 2");
    await expect(trigger.locator(".composer-stash__count")).toHaveText("2");
  } finally {
    await first.close();
  }

  const second = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await second.firstWindow();
    const composer = window.getByTestId("composer");
    const trigger = window.getByTestId("composer-stash-trigger");
    await expect(trigger).toHaveAccessibleName("Parked drafts: 2");

    // Restoring adds to what is typed now instead of replacing it.
    await composer.fill("Typed meanwhile");
    await trigger.click();
    const menu = window.getByTestId("composer-stash-menu");
    await expect(menu.getByRole("listitem")).toHaveCount(2);
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await window.screenshot({ path: join(proofDir, "composer-stash-menu.png") });
    }
    await menu.getByRole("button", { name: "Restore parked draft: First parked idea" }).click();
    await expect(composer).toHaveValue("Typed meanwhile\n\nFirst parked idea");
    await expect(window.locator(".composer-attachment")).toHaveCount(1);
    await expect(trigger).toHaveAccessibleName("Parked drafts: 1");

    await trigger.click();
    await menu.getByRole("button", { name: "Delete parked draft" }).click();
    await expect(menu.getByText("Nothing parked yet.", { exact: false })).toBeVisible();
    await expect(trigger).toHaveAccessibleName("Parked drafts");
  } finally {
    await second.close();
  }
});
