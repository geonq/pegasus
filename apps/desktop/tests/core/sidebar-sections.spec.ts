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

test("Needs you and Working head the Chats list, and Archive takes a real click at the narrowest sidebar", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-sections-narrow-");
  const workspacePaths = await Promise.all(
    ["narrow-a", "narrow-b", "narrow-c", "narrow-d", "narrow-e", "narrow-f"].map(makeWorkspace),
  );
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: workspacePaths,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspaces = await Promise.all(
      workspacePaths.map((path) => waitForWorkspaceByPath(window, path)),
    );
    await createSessionViaIpc(
      window,
      workspaces[0]!.id,
      "Needs a long title to crowd the row far past the edge",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await createSessionViaIpc(window, workspaces[1]!.id, "Builds");
    await window
      .getByRole("group", { name: "Sidebar view" })
      .getByRole("button", { name: "Chats", exact: true })
      .click();
    await setStatus(
      harness,
      window,
      "Needs a long title to crowd the row far past the edge",
      "failed",
    );
    await setStatus(harness, window, "Builds", "running");

    const needsYou = window.getByRole("region", { name: "Needs you" });
    const working = window.getByRole("region", { name: "Working" });
    await expect(needsYou.locator(".session-row")).toHaveCount(1);
    await expect(working.locator(".session-row")).toHaveCount(1);
    // Both sit above the project folder rows, so many projects never push them off screen.
    const firstFolder = (await window.locator(".workspace-row").first().boundingBox())!;
    expect((await needsYou.boundingBox())!.y).toBeLessThan(firstFolder.y);
    expect((await working.boundingBox())!.y).toBeLessThan(firstFolder.y);

    const handle = window.getByRole("separator", { name: "Sidebar width" });
    const box = (await handle.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + 300);
    await window.mouse.down();
    await window.mouse.move(0, box.y + 300, { steps: 8 });
    await window.mouse.up();
    await expect
      .poll(async () => Math.round((await window.locator("aside.sidebar").boundingBox())!.width))
      .toBeLessThanOrEqual(204);

    if (proofDir) {
      await window.mouse.move(box.x + 400, box.y + 600);
      await expect(needsYou).toHaveCSS("opacity", "1");
      await window.locator(".sidebar").screenshot({ path: join(proofDir, "sidebar-narrow.png") });
    }

    const row = needsYou.locator(".session-row");
    await row.hover();
    await row.getByLabel(/Archive chat/).click();
    await expect(needsYou).toHaveCount(0);
    await expect(window.getByRole("status").filter({ hasText: "Chat archived" })).toBeVisible();
  } finally {
    await harness.close();
  }
});
