import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

const proofDir = process.env.PI_APP_UI_SMALL_PROOF_DIR;

async function capture(window: Page, name: string): Promise<void> {
  if (!proofDir) return;
  await mkdir(proofDir, { recursive: true });
  await window.screenshot({ path: join(proofDir, name) });
}

test("hovering a chat row for ~400 ms shows a card that hides on leave and right-click", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("thread-hover-card-workspace");
  const title = "Hover card target with a fairly long title that the sidebar row truncates";
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let target: { workspaceId: string; sessionId: string } | undefined;
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, title);
    const state = await getDesktopState(window);
    target = { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
    await createNamedThread(window, "Other thread");
  } finally {
    await firstRun.close();
  }
  await appendMessagesToSessionFile(await sessionFilePathFromCatalog(userDataDir, target!), [
    { role: "user", text: "Please summarise." },
    { role: "assistant", text: "The last message preview text for the hover card." },
  ]);

  const harness = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await harness.firstWindow();
    const row = window.locator(".session-row", { hasText: title }).first();
    const card = window.getByTestId("thread-hover-card");
    await expect(row).toBeVisible();

    await window.mouse.move(0, 0);
    await row.hover();
    // Not at once: the card waits for the pointer to rest.
    await window.waitForTimeout(150);
    await expect(card).toHaveCount(0);
    await expect(card).toBeVisible({ timeout: 3_000 });
    await expect(card).toContainText(title);
    await expect(card.locator("[data-field=project]")).not.toHaveText("");
    await expect(card.locator("[data-field=status]")).toHaveText(/Working|Needs you|Done/);
    await expect(card.locator("[data-field=activity]")).not.toHaveText("");
    // A chat loaded from disk previews its first message (previewFromSessionInfo).
    await expect(card.locator("[data-field=preview]")).toHaveText("Please summarise.");

    const viewport = await window.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    }));
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    await capture(window, "01-thread-hover-card.png");

    // Leaving hides it.
    await window.mouse.move(viewport.width - 20, viewport.height / 2);
    await expect(card).toHaveCount(0);

    // Right-click hides it and opens the menu instead.
    await row.hover();
    await expect(card).toBeVisible({ timeout: 3_000 });
    await row.click({ button: "right" });
    await expect(card).toHaveCount(0);
    await expect(window.locator(".floating-menu").getByRole("menu")).toBeVisible();
    await window.keyboard.press("Escape");

    // The card stays inside the window for a row at the very bottom edge.
    await window.mouse.move(viewport.width - 20, viewport.height / 2);
    const rows = window.locator(".session-row");
    const last = rows.last();
    await last.scrollIntoViewIfNeeded();
    await last.hover();
    await expect(card).toBeVisible({ timeout: 3_000 });
    const lastBox = await card.boundingBox();
    expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(viewport.height);
  } finally {
    await harness.close();
  }
});
