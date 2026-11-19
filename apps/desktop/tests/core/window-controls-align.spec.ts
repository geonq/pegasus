import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
} from "../helpers/electron-app";
import { captureProof, HT, rect, windowsHitTest } from "../helpers/ui-chrome";

test.skip(process.platform !== "win32", "Windows caption buttons only");

test("header buttons share the caption buttons' centre line and the side panel lines up under them", async () => {
  test.setTimeout(90_000);
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("window-controls-workspace")],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Window controls thread");

    // The caption strip as Chromium reports it: everything left of the native buttons.
    const strip = await window.evaluate(() => {
      const overlay = (
        navigator as Navigator & {
          windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect };
        }
      ).windowControlsOverlay;
      const area = overlay?.getTitlebarAreaRect();
      return {
        visible: overlay?.visible ?? false,
        height: area?.height ?? 0,
        right: area?.right ?? 0,
        vw: innerWidth,
      };
    });
    expect(strip.visible).toBe(true);
    const captionCentre = strip.height / 2;

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
    ]) {
      expect(Math.abs((await centre(selector)) - captionCentre), selector).toBeLessThanOrEqual(1);
    }

    // Windows still owns the buttons (snap layouts need HTMAXBUTTON) and the empty header drags.
    const header = await rect(window.getByTestId("topbar"));
    const button = await rect(window.getByTestId("toggle-side-panel"));
    const buttonWidth = (strip.vw - strip.right) / 3;
    const codes = await windowsHitTest(harness, [
      { x: strip.vw - buttonWidth * 1.5, y: captionCentre },
      { x: strip.vw - buttonWidth * 0.5, y: captionCentre },
      { x: header.x + 360, y: captionCentre },
      { x: button.x + button.width / 2, y: button.y + button.height / 2 },
    ]);
    expect(codes).toEqual([HT.maxButton, HT.close, HT.caption, HT.client]);
    // Header buttons stay clear of the caption buttons.
    expect(button.x + button.width).toBeLessThanOrEqual(strip.right - 8);
    await captureProof(window, "03-header-centre-line.png");

    // The side panel card starts one gap below the caption strip and keeps the gap to the right edge.
    await selectSidePanel(window, "Review");
    const panel = await rect(window.getByTestId("workbench"));
    expect(Math.round(panel.y)).toBe(Math.round(strip.height + 8));
    expect(Math.round(strip.vw - (panel.x + panel.width))).toBe(8);
    const toggle = await centre('[data-testid="thread-header-menu"]');
    expect(Math.abs(toggle - captionCentre)).toBeLessThanOrEqual(1);
    await captureProof(window, "03-side-panel-under-caption.png");
  } finally {
    await harness.close();
  }
});
