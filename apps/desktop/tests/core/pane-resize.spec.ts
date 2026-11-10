import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  commitAllInGitRepo,
  createNamedThread,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSidePanel,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

async function width(locator: Locator): Promise<number> {
  return Math.round((await locator.boundingBox())!.width);
}

/** Drags a separator horizontally in `steps` mouse moves and returns the React commits it caused. */
async function drag(window: Page, handle: Locator, dx: number, steps = 60): Promise<number> {
  const box = (await handle.boundingBox())!;
  const y = box.y + Math.min(box.height / 2, 200);
  await window.mouse.move(box.x + box.width / 2, y);
  await window.mouse.down();
  await window.evaluate(() => {
    (window as any).__commits = 0;
    (window as any).__renders = {};
  });
  await window.mouse.move(box.x + box.width / 2 + dx, y, { steps });
  await window.mouse.up();
  const rendered = await window.evaluate(() => (window as any).__renders as Record<string, number>);
  const top = Object.entries(rendered)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => `${name}x${count}`);
  console.log(`renders during drag: ${top.join(" ")}`);
  return window.evaluate(() => (window as any).__commits as number);
}

test("file trees and the side panel drag wider, persist, and do not re-render per pointer move", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const workspacePath = await makeWorkspace("pane-resize");
  await initGitRepo(workspacePath);
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, "src", "app.ts"), "export const a = 1;\n");
  await writeFile(join(workspacePath, "notes.txt"), "first\n");
  await commitAllInGitRepo(workspacePath, "Baseline");
  await writeFile(join(workspacePath, "notes.txt"), "first\nsecond\n");

  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 900);
    });
    const window = await harness.firstWindow();
    // Counting React commits needs the DevTools hook before React loads; reload after installing it.
    await window.addInitScript(() => {
      (window as any).__commits = 0;
      (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        onScheduleFiberRoot() {},
        onCommitFiberRoot: (_id: number, root: any) => {
          (window as any).__commits += 1;
          // Count which components did render work, to attribute commits during a drag.
          const names = ((window as any).__renders ??= {}) as Record<string, number>;
          const walk = (fiber: any) => {
            for (let f = fiber; f; f = f.sibling) {
              if (f.flags & 1 && typeof f.type === "function")
                names[f.type.name || "anon"] = (names[f.type.name || "anon"] ?? 0) + 1;
              if (f.child) walk(f.child);
            }
          };
          walk(root.current);
        },
        onCommitFiberUnmount() {},
        checkDCE() {},
      };
    });
    await window.reload();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Pane resize task", { workspaceName: workspace.name });

    await selectSidePanel(window, "Review");
    const review = window.getByRole("region", { name: "Review", exact: true });
    // At the default panel width the diff keeps its minimum and the tree steps aside.
    await expect(review.getByTestId("review-line-totals")).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("review-default-width.png") });
    const diffColumn = review.locator(".review-panel__viewer");
    expect(await width(diffColumn)).toBeGreaterThanOrEqual(360);
    // Side panel: a 60-step drag commits React once at release, not once per pointer move.
    const panel = window.getByTestId("workbench");
    const panelBefore = await width(panel);
    const panelHandle = window.getByRole("separator", { name: "Side panel width" });
    const idle = await drag(window, panelHandle, 0, 60);
    console.log(`baseline: 60 moves without resizing -> ${idle} React commits`);
    const commits = await drag(window, panelHandle, -300, 60);
    console.log(`side panel drag: 60 moves -> ${commits} React commits`);
    await expect.poll(() => width(panel)).toBe(panelBefore + 300);
    expect(commits).toBeLessThan(100);
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.workbench-width")))
      .toBe(String(panelBefore + 300));

    await window.screenshot({ path: testInfo.outputPath("review-widened.png") });
    // Review: changed-files tree.
    await selectSidePanel(window, "Review");
    const reviewTree = review.getByRole("region", { name: "Changed files", exact: true });
    await expect(reviewTree).toBeVisible();
    const reviewBefore = await width(reviewTree);
    const reviewHandle = reviewTree.getByRole("separator", { name: "Changed files width" });
    await drag(window, reviewHandle, -80);
    await expect.poll(() => width(reviewTree)).toBe(reviewBefore + 80);
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.review-tree-width")))
      .toBe(String(reviewBefore + 80));

    // Files: workspace tree.
    await selectSidePanel(window, "Files");
    const fileTree = window.getByTestId("file-explorer");
    await expect(fileTree).toBeVisible();
    const filesBefore = await width(fileTree);
    const fileHandle = fileTree.getByRole("separator", { name: "File tree width" });
    await drag(window, fileHandle, -80);
    await expect.poll(() => width(fileTree)).toBe(filesBefore + 80);
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.file-tree-width")))
      .toBe(String(filesBefore + 80));

    // Bounds: a huge drag cannot squeeze the editor/diff below its minimum.
    await drag(window, fileHandle, -2000, 10);
    const split = window.getByTestId("file-workbench");
    expect((await width(split)) - (await width(fileTree))).toBeGreaterThanOrEqual(199);
  } finally {
    await harness.close();
  }
});
