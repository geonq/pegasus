import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
} from "../helpers/electron-app";
import { captureProof, rect } from "../helpers/ui-chrome";

test("window, chat column and both floating cards form one system with 8 px gaps", async () => {
  test.setTimeout(90_000);
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("chat-column-join-workspace")],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Join thread");
    await selectSidePanel(window, "Review");
    const sidebar = window.locator("#primary-sidebar");
    const panel = window.getByTestId("workbench");
    await expect(panel).toBeVisible();

    const css = await window.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      return {
        shell: style(".shell").backgroundColor,
        main: style(".main").backgroundColor,
        canvas: style(".canvas--thread").backgroundColor,
        composer: style(".composer").backgroundColor,
        topbarRule: style(".topbar").borderBottomColor,
        sidebarFill: style("#primary-sidebar").backgroundColor,
        panelFill: style(".side-panel").backgroundColor,
        sidebarRadius: style("#primary-sidebar").borderTopRightRadius,
        panelRadius: style(".side-panel").borderTopLeftRadius,
        sidebarShadow: style("#primary-sidebar").boxShadow,
        panelShadow: style(".side-panel").boxShadow,
      };
    });
    // The chat column paints nothing of its own: the window's background shows through it.
    expect(css.shell).not.toBe("rgba(0, 0, 0, 0)");
    for (const layer of [css.main, css.canvas, css.composer]) {
      expect(["rgba(0, 0, 0, 0)", css.shell]).toContain(layer);
    }
    expect(css.topbarRule).toBe("rgba(0, 0, 0, 0)");
    // The two cards are the same kind of object.
    expect(css.panelFill).toBe(css.sidebarFill);
    expect(css.panelFill).not.toBe(css.shell);
    expect(css.panelRadius).toBe(css.sidebarRadius);
    expect(css.panelShadow).toBe(css.sidebarShadow);

    const view = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const left = await rect(sidebar);
    const right = await rect(panel);
    const chat = await rect(window.locator(".canvas--thread"));
    const bar = await rect(window.getByTestId("status-bar"));
    const gaps = {
      sidebarLeft: left.x,
      sidebarTop: left.y,
      sidebarToChat: chat.x - (left.x + left.width),
      chatToPanel: right.x - (chat.x + chat.width),
      panelRight: view.width - (right.x + right.width),
      sidebarBottom: bar.y - (left.y + left.height),
      panelBottom: bar.y - (right.y + right.height),
    };
    for (const [name, gap] of Object.entries(gaps)) {
      expect(Math.round(gap), name).toBe(8);
    }
    await captureProof(window, "02-chat-column-join.png");
  } finally {
    await harness.close();
  }
});
