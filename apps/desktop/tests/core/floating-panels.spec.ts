import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
} from "../helpers/electron-app";

const proofDir = process.env.PI_APP_FLOATING_PROOF_DIR;

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

async function viewport(window: Page) {
  return window.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }));
}

/** Drags a resize handle by (dx, dy) in small steps, like a hand would. */
async function dragHandle(window: Page, handle: Locator, dx: number, dy: number) {
  const rect = await box(handle);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x + dx, y + dy, { steps: 12 });
  await window.mouse.up();
}

test("the sidebar floats pinned top-left and resizes in width and height, remembered after a restart", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("floating-panels-workspace");
  let size: { width: number; height: number } | undefined;

  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await first.firstWindow();
    await createNamedThread(window, "Floating panels thread");
    const sidebar = window.locator("#primary-sidebar");
    const view = await viewport(window);
    const rect = await box(sidebar);

    // A gap on the left, top and bottom: the card no longer touches the window edges.
    expect(rect.x).toBeGreaterThanOrEqual(4);
    expect(rect.y).toBeGreaterThanOrEqual(4);
    expect(view.height - (rect.y + rect.height)).toBeGreaterThanOrEqual(4);
    // Rounded corners and a border all the way round.
    const style = await sidebar.evaluate((node) => {
      const css = getComputedStyle(node);
      return { radius: Number.parseFloat(css.borderTopLeftRadius), border: css.borderTopWidth };
    });
    expect(style.radius).toBeGreaterThanOrEqual(8);
    expect(style.border).toBe("1px");
    if (proofDir) await window.screenshot({ path: join(proofDir, "01-floating-sidebar.png") });

    // Wider from its right edge.
    await dragHandle(window, window.getByRole("separator", { name: "Sidebar width" }), 60, 0);
    const wider = await box(sidebar);
    expect(wider.width).toBeGreaterThan(rect.width + 40);
    expect(wider.x).toBeCloseTo(rect.x, 0);

    // Shorter from its bottom edge; the top stays pinned.
    await dragHandle(window, window.getByRole("separator", { name: "Sidebar height" }), 0, -150);
    const shorter = await box(sidebar);
    expect(shorter.height).toBeLessThan(rect.height - 100);
    expect(shorter.y).toBeCloseTo(rect.y, 0);
    if (proofDir) await window.screenshot({ path: join(proofDir, "02-sidebar-resized.png") });
    size = { width: Math.round(shorter.width), height: Math.round(shorter.height) };
    // Let the debounced preference write land before quitting.
    await window.waitForTimeout(400);
  } finally {
    await first.close();
  }

  const second = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await second.firstWindow();
    const restored = await box(window.locator("#primary-sidebar"));
    expect(Math.abs(Math.round(restored.width) - size!.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(Math.round(restored.height) - size!.height)).toBeLessThanOrEqual(2);

    // Double-clicking the bottom edge returns it to full height.
    await window.getByRole("separator", { name: "Sidebar height" }).dblclick();
    const view = await viewport(window);
    const full = await box(window.locator("#primary-sidebar"));
    expect(full.height).toBeGreaterThan(view.height - 40);
  } finally {
    await second.close();
  }
});

test("the side panel floats pinned top-right and its bottom edge can be pulled up", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("floating-side-panel-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Floating side panel thread");
    await selectSidePanel(window, "Review");
    const panel = window.getByTestId("workbench");
    await expect(panel).toBeVisible();
    const view = await viewport(window);
    const rect = await box(panel);
    // A gap to the right and bottom window edges, rounded corners.
    expect(view.width - (rect.x + rect.width)).toBeGreaterThanOrEqual(4);
    expect(view.height - (rect.y + rect.height)).toBeGreaterThanOrEqual(4);
    const radius = await panel.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).borderTopRightRadius),
    );
    expect(radius).toBeGreaterThanOrEqual(8);
    if (proofDir) await window.screenshot({ path: join(proofDir, "03-floating-side-panel.png") });

    await dragHandle(window, window.getByRole("separator", { name: "Side panel height" }), 0, -160);
    const shorter = await box(panel);
    expect(shorter.height).toBeLessThan(rect.height - 100);
    expect(shorter.y).toBeCloseTo(rect.y, 0);
    expect(shorter.x + shorter.width).toBeCloseTo(rect.x + rect.width, 0);
    if (proofDir) await window.screenshot({ path: join(proofDir, "04-side-panel-resized.png") });
  } finally {
    await harness.close();
  }
});
