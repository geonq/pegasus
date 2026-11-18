import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import {
  createSessionViaIpc,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const proofDir = process.env.PI_APP_SIDEBAR_PROOF_DIR;

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("not visible");
  return rect;
}

test("Chats view folds the project folders under a Projects section, shut by default", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-projects-");
  const workspacePath = await makeWorkspace("sidebar-projects");
  const options = { initialWorkspaces: [workspacePath], testMode: "background" } as const;
  const firstRun = await launchDesktop(userDataDir, options);

  try {
    const window = await firstRun.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    for (const title of ["Quiet", "Builds"]) await createSessionViaIpc(window, workspace.id, title);
    await window
      .getByRole("group", { name: "Sidebar view" })
      .getByRole("button", { name: "Chats", exact: true })
      .click();

    const projects = window.getByRole("region", { name: "Projects", exact: true });
    const head = projects.getByRole("button", { name: /Projects/ });
    await expect(head).toHaveAttribute("aria-expanded", "false");
    await expect(window.locator(".workspace-row")).toHaveCount(0);

    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await expect(window.locator(".workspace-row")).toHaveCount(1);
    await expect(window.getByRole("button", { name: /^New chat in / })).toBeAttached();
    await expect(window.getByRole("button", { name: /^Workspace actions for / })).toBeAttached();
    await head.click();
    await expect(window.locator(".workspace-row")).toHaveCount(0);
    await head.focus();
    await window.keyboard.press("Enter");
    await expect(head).toHaveAttribute("aria-expanded", "true");

    // Header geometry matches the Working and Today headers.
    const state = await getDesktopState(window);
    const target = state.workspaces.flatMap((w) => w.sessions).find((s) => s.title === "Builds")!;
    const now = new Date().toISOString();
    const ref = { workspaceId: workspace.id, sessionId: target.id };
    await emitTestSessionEvent(firstRun, {
      type: "sessionUpdated",
      sessionRef: ref,
      timestamp: now,
      runId: "run-Builds",
      snapshot: {
        ref,
        workspace: { workspaceId: workspace.id, path: workspace.path, displayName: workspace.name },
        title: "Builds",
        status: "running",
        updatedAt: now,
        preview: "",
        runningRunId: "run-Builds",
      },
    });
    const working = window.getByRole("region", { name: "Working", exact: true });
    const workingHead = working.getByRole("button", { name: /Working/ });
    await expect(workingHead).toBeVisible();
    const today = window.getByRole("region", { name: "Today", exact: true });
    const [p, w, t] = await Promise.all([
      box(head),
      box(workingHead),
      box(today.locator(".recency-thread-group__head")),
    ]);
    const chevron = async (h: Locator) =>
      (await box(h.locator(".attention-group__chevron"))).x - (await box(h)).x;
    expect(Math.abs(p.height - w.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.height - t.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.x - t.x)).toBeLessThanOrEqual(1);
    expect(Math.abs((await chevron(head)) - (await chevron(workingHead)))).toBeLessThanOrEqual(1);
    const pad = (h: Locator) => h.evaluate((el) => getComputedStyle(el).paddingLeft);
    expect(await pad(head)).toBe(await pad(workingHead));
    expect(await pad(head)).toBe(await pad(today.locator(".recency-thread-group__head")));

    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await window.screenshot({ path: join(proofDir, "projects-expanded.png") });
      await head.click();
      await window.screenshot({ path: join(proofDir, "projects-collapsed.png") });
      await head.click();
    }
  } finally {
    await firstRun.close();
  }

  // Open state survives a relaunch.
  const secondRun = await launchDesktop(userDataDir, options);
  try {
    const window = await secondRun.firstWindow();
    await window
      .getByRole("group", { name: "Sidebar view" })
      .getByRole("button", { name: "Chats", exact: true })
      .click();
    const head = window
      .getByRole("region", { name: "Projects", exact: true })
      .getByRole("button", { name: /Projects/ });
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await head.click();
  } finally {
    await secondRun.close();
  }
  const thirdRun = await launchDesktop(userDataDir, options);
  try {
    const window = await thirdRun.firstWindow();
    await window
      .getByRole("group", { name: "Sidebar view" })
      .getByRole("button", { name: "Chats", exact: true })
      .click();
    await expect(
      window.getByRole("region", { name: "Projects", exact: true }).getByRole("button"),
    ).toHaveAttribute("aria-expanded", "false");
  } finally {
    await thirdRun.close();
  }
});
