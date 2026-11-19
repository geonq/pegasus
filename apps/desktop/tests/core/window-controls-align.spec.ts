import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
} from "../helpers/electron-app";
import { captureProof, HT, rect, windowsHitTest, windowsStyle, WS } from "../helpers/ui-chrome";

test.skip(process.platform !== "win32", "Windows window controls only");

test("the app draws its own window controls on the header's centre line and they drive the window", async () => {
  test.setTimeout(90_000);
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("window-controls-workspace")],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Window controls thread");
    const view = await window.evaluate(() => ({
      width: innerWidth,
      overlay: (navigator as Navigator & { windowControlsOverlay?: { visible: boolean } })
        .windowControlsOverlay?.visible,
    }));
    // No native caption-button overlay any more, but the window keeps the resize frame and maximize
    // box, which Aero snap by dragging and Win+Z need.
    expect(view.overlay ?? false).toBe(false);
    const style = await windowsStyle(harness);
    expect(style & WS.thickFrame).toBe(WS.thickFrame);
    expect(style & WS.maximizeBox).toBe(WS.maximizeBox);

    const minimize = window.getByTestId("window-minimize");
    const maximize = window.getByTestId("window-maximize");
    const close = window.getByTestId("window-close");
    for (const [button, label] of [
      [minimize, "Minimize"],
      [maximize, "Maximize"],
      [close, "Close"],
    ] as const) {
      await expect(button).toHaveAttribute("aria-label", label);
      expect(await button.getAttribute("title")).toBeNull();
    }

    // 46 px targets as tall as the header, flush with the top-right corner.
    const boxes = [await rect(minimize), await rect(maximize), await rect(close)];
    const header = await rect(window.getByTestId("topbar"));
    for (const box of boxes) {
      expect(Math.round(box.width)).toBe(46);
      expect(Math.round(box.y)).toBe(0);
      expect(Math.round(box.height)).toBe(Math.round(header.height));
    }
    expect(Math.round(boxes[2]!.x + boxes[2]!.width)).toBe(view.width);
    const centreLine = boxes[0]!.y + boxes[0]!.height / 2;

    const centre = async (selector: string) => {
      const box = await rect(window.locator(selector).first());
      return box.y + box.height / 2;
    };
    for (const selector of [
      ".topbar",
      '[data-testid="toggle-side-panel"]',
      '[data-testid="thread-header-menu"]',
      ".chat-header__status",
      ".sidebar-toggle__button",
      '[data-testid="window-maximize"] svg',
    ]) {
      expect(Math.abs((await centre(selector)) - centreLine), selector).toBeLessThanOrEqual(1);
    }
    // Header buttons stay clear of the window controls.
    const toggle = await rect(window.getByTestId("toggle-side-panel"));
    expect(toggle.x + toggle.width).toBeLessThanOrEqual(boxes[0]!.x - 8);

    // Empty header space moves the window; the buttons are ordinary clickable content.
    const codes = await windowsHitTest(harness, [
      { x: header.x + 360, y: centreLine },
      { x: boxes[1]!.x + 23, y: centreLine },
      { x: toggle.x + toggle.width / 2, y: centreLine },
    ]);
    expect(codes).toEqual([HT.caption, HT.client, HT.client]);

    // Close hover is the Windows red with a white glyph; custom tooltip, no native title.
    await close.hover();
    await expect
      .poll(() => close.evaluate((node) => getComputedStyle(node).backgroundColor))
      .toBe("rgb(196, 43, 28)");
    expect(await close.evaluate((node) => getComputedStyle(node).color)).toBe("rgb(255, 255, 255)");
    await expect(window.locator(".window-controls__wrap:hover [role=tooltip]")).toHaveText("Close");
    await captureProof(window, "03-window-controls-close-hover.png");

    // Maximize toggles the real window and swaps to Restore; the event also follows a toggle from main.
    const isMaximized = () =>
      harness.electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isMaximized(),
      );
    expect(await isMaximized()).toBe(false);
    await maximize.click();
    await expect.poll(isMaximized).toBe(true);
    await expect(maximize).toHaveAttribute("aria-label", "Restore");
    await expect(maximize.locator("path")).toHaveCount(1);
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.unmaximize(),
    );
    await expect(maximize).toHaveAttribute("aria-label", "Maximize");
    await expect(maximize.locator("path")).toHaveCount(0);

    // Minimize reaches BrowserWindow.minimize.
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      const original = win.minimize.bind(win);
      (globalThis as { minimizeCalls?: number }).minimizeCalls = 0;
      win.minimize = () => {
        (globalThis as { minimizeCalls?: number }).minimizeCalls! += 1;
        original();
      };
    });
    await minimize.click();
    await expect
      .poll(() =>
        harness.electronApp.evaluate(
          () => (globalThis as { minimizeCalls?: number }).minimizeCalls,
        ),
      )
      .toBe(1);
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.restore(),
    );

    // The side panel card sits one gap below the header and keeps the 8 px right gap.
    await selectSidePanel(window, "Review");
    const panel = await rect(window.getByTestId("workbench"));
    expect(Math.round(panel.y)).toBe(Math.round(header.height + 8));
    expect(Math.round(view.width - (panel.x + panel.width))).toBe(8);
    expect(
      Math.abs((await centre('[data-testid="thread-header-menu"]')) - centreLine),
    ).toBeLessThanOrEqual(1);
    const [aboveCard] = await windowsHitTest(harness, [{ x: panel.x + 40, y: centreLine }]);
    expect(aboveCard).toBe(HT.caption);
    await captureProof(window, "03-side-panel-under-controls.png");
  } finally {
    await harness.close();
  }
});
