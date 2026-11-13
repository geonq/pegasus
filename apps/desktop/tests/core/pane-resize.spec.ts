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

/** The slice of a React fiber the commit counter reads. */
interface Fiber {
  readonly sibling: Fiber | null;
  readonly child: Fiber | null;
  readonly flags: number;
  readonly type: unknown;
}

declare global {
  // Probe state kept on the page global by the DevTools hook installed below.
  var __commits: number | undefined;
  var __renders: Record<string, number> | undefined;
  var __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown;
}

let lastDragP95 = 0;

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
    globalThis.__commits = 0;
    globalThis.__renders = {};
    const gaps: number[] = [];
    (globalThis as { __gaps?: number[] }).__gaps = gaps;
    let last = performance.now();
    const tick = (now: number) => {
      gaps.push(now - last);
      last = now;
      if ((globalThis as { __gaps?: number[] }).__gaps === gaps) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await window.mouse.move(box.x + box.width / 2 + dx, y, { steps });
  await window.mouse.up();
  const gaps = await window.evaluate(() => {
    const all = (globalThis as { __gaps?: number[] }).__gaps ?? [];
    (globalThis as { __gaps?: number[] }).__gaps = undefined;
    return all.slice(1).sort((a, b) => a - b);
  });
  const p95 = gaps[Math.floor(gaps.length * 0.95)] ?? 0;
  console.log(`frames during drag: ${gaps.length}, p95 gap ${p95.toFixed(1)} ms, max ${(gaps.at(-1) ?? 0).toFixed(1)} ms`);
  lastDragP95 = p95;
  const rendered = await window.evaluate(() => globalThis.__renders ?? {});
  const top = Object.entries(rendered)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([name, count]) => `${name}x${count}`);
  console.log(`renders during drag: ${top.join(" ")}`);
  return window.evaluate(() => globalThis.__commits ?? 0);
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
      globalThis.__commits = 0;
      globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        onScheduleFiberRoot() {},
        onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
          globalThis.__commits = (globalThis.__commits ?? 0) + 1;
          // Count which components did render work, to attribute commits during a drag.
          const names = (globalThis.__renders ??= {});
          const walk = (fiber: Fiber | null) => {
            for (let f = fiber; f; f = f.sibling) {
              if (f.flags & 1 && typeof f.type === "function") {
                const name = f.type.name || "anon";
                names[name] = (names[name] ?? 0) + 1;
              }
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
    const panelP95 = lastDragP95;
    await expect.poll(() => width(panel)).toBe(panelBefore + 300);
    // The chat reflows with the panel edge on every frame, the same work a left-sidebar drag does;
    // what must hold is that the drag stays smooth, not that nothing renders.
    const sidebarHandle = window.getByRole("separator", { name: "Sidebar width" });
    const sidebarCommits = await drag(window, sidebarHandle, 60, 60);
    console.log(`left sidebar drag: 60 moves -> ${sidebarCommits} React commits`);
    await drag(window, sidebarHandle, -60, 60);
    expect(commits).toBeLessThan(4 * 60);
    expect(panelP95).toBeLessThan(50);
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-gui.workbench-width")))
      .toBe(String(panelBefore + 300));

    // Mid-drag the chat column follows the panel edge, like it follows the left sidebar: it is never
    // laid out under the panel, in either direction.
    const canvas = window.locator(".canvas--thread");
    const handleBox = (await panelHandle.boundingBox())!;
    const y = handleBox.y + Math.min(handleBox.height / 2, 200);
    await window.mouse.move(handleBox.x + handleBox.width / 2, y);
    await window.mouse.down();
    for (const dx of [-120, 160]) {
      await window.mouse.move(handleBox.x + handleBox.width / 2 + dx, y, { steps: 10 });
      await expect
        .poll(async () => {
          const chat = (await canvas.boundingBox())!;
          const side = (await panel.boundingBox())!;
          return Math.round(chat.x + chat.width - side.x);
        })
        .toBeLessThanOrEqual(0);
    }
    await window.mouse.move(handleBox.x + handleBox.width / 2, y, { steps: 10 });
    await window.mouse.up();
    await expect.poll(() => width(panel)).toBe(panelBefore + 300);

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
