import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createSessionViaIpc,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
  type DesktopHarness,
} from "../helpers/electron-app";

const proofDir = process.env.PI_APP_SIDEBAR_PROOF_DIR;

async function setStatus(
  harness: DesktopHarness,
  window: Page,
  title: string,
  status: "running" | "failed" | "idle",
) {
  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) =>
    entry.sessions.some((session) => session.title === title),
  )!;
  const session = workspace.sessions.find((entry) => entry.title === title)!;
  const ref = { workspaceId: workspace.id, sessionId: session.id };
  const now = new Date().toISOString();
  await emitTestSessionEvent(harness, {
    type: "sessionUpdated",
    sessionRef: ref,
    timestamp: now,
    runId: `run-${title}`,
    snapshot: {
      ref,
      workspace: { workspaceId: workspace.id, path: workspace.path, displayName: workspace.name },
      title,
      status,
      updatedAt: now,
      preview: "",
      ...(status === "running" ? { runningRunId: `run-${title}` } : {}),
    },
  });
}

test("Chats view lifts failed and running chats into Needs you and Working, and archive offers Undo", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-sections-");
  const workspacePath = await makeWorkspace("sidebar-sections");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    for (const title of ["Quiet", "Builds", "Breaks"]) {
      await createSessionViaIpc(window, workspace.id, title);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await window
      .getByRole("group", { name: "Sidebar view" })
      .getByRole("button", { name: "Chats", exact: true })
      .click();

    await expect(window.getByRole("region", { name: "Needs you" })).toHaveCount(0);
    await expect(window.getByRole("region", { name: "Working" })).toHaveCount(0);

    await setStatus(harness, window, "Builds", "running");
    await setStatus(harness, window, "Breaks", "failed");
    const needsYou = window.getByRole("region", { name: "Needs you" });
    const working = window.getByRole("region", { name: "Working" });
    await expect(needsYou.locator(".session-row")).toHaveCount(1);
    await expect(needsYou).toContainText("Breaks");
    await expect(working.locator(".session-row")).toHaveCount(1);
    await expect(working).toContainText("Builds");
    await expect(window.getByRole("region", { name: "Today" })).not.toContainText("Breaks");
    await expect(window.getByRole("region", { name: "Today" })).toContainText("Quiet");
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await window.locator(".sidebar").screenshot({ path: join(proofDir, "sidebar-sections.png") });
    }

    const fold = working.getByRole("button", { name: /Working/ });
    await fold.click();
    await expect(working.locator(".session-row")).toHaveCount(0);
    await fold.click();
    await expect(working.locator(".session-row")).toHaveCount(1);

    // Archive the failed chat and take it back.
    await needsYou.locator(".session-row").hover();
    await needsYou.getByLabel(/Archive chat Breaks/).click();
    await expect(needsYou).toHaveCount(0);
    const toast = window.getByRole("status").filter({ hasText: "Chat archived" });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(toast).toHaveCount(0);
    await expect(window.locator(".session-row", { hasText: "Breaks" })).toHaveCount(1);

    // Without Undo the toast leaves by itself after five seconds.
    const row = window.locator(".session-row", { hasText: "Breaks" });
    await row.hover();
    await row.getByLabel(/Archive chat Breaks/).click();
    await expect(toast).toBeVisible();
    await expect(toast).toHaveCount(0, { timeout: 8_000 });
  } finally {
    await harness.close();
  }
});
