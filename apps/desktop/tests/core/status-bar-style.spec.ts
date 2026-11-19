import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";
import { captureProof, rect } from "../helpers/ui-chrome";

test("the status bar sits on the window background inside the cards' gutters, with a quiet meter", async () => {
  test.setTimeout(90_000);
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("status-bar-style-workspace")],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Status bar style thread");
    const bar = window.getByTestId("status-bar");
    await expect(bar.getByTestId("status-bar-host")).toBeVisible({ timeout: 15_000 });

    const css = await bar.evaluate((node) => {
      const cs = getComputedStyle(node);
      const segment = node.querySelector(".status-bar__segment")!;
      return {
        borderTop: cs.borderTopWidth,
        background: cs.backgroundColor,
        paddingRight: cs.paddingRight,
        fontSize: cs.fontSize,
        color: cs.color,
        soft: getComputedStyle(document.documentElement).getPropertyValue("--fg-soft").trim(),
        segmentRadius: getComputedStyle(segment).borderTopLeftRadius,
      };
    });
    // No harsh line and no strip colour of its own.
    expect(css.borderTop).toBe("0px");
    expect(css.background).toBe("rgba(0, 0, 0, 0)");
    expect(css.fontSize).toBe("11px");
    expect(css.paddingRight).toBe("8px");

    // Content runs from the sidebar card's left edge to 8 px short of the window's right edge.
    const view = await window.evaluate(() => innerWidth);
    const sidebar = await rect(window.locator("#primary-sidebar"));
    const segments = bar.locator(".status-bar__segment");
    const first = await rect(segments.first());
    const last = await rect(segments.last());
    expect(Math.round(first.x)).toBe(Math.round(sidebar.x));
    expect(Math.round(view - (last.x + last.width))).toBe(8);
    // The bar is centred in the 8 px band under the cards' bottom gap.
    const barBox = await rect(bar);
    const segmentBox = await rect(segments.first());
    expect(
      Math.abs(segmentBox.y + segmentBox.height / 2 - (barBox.y + barBox.height / 2)),
    ).toBeLessThanOrEqual(1);

    // The meter, when the account reports numbers, is a small rounded pill.
    const meter = bar.locator(".status-bar__meter");
    if ((await meter.count()) > 0) {
      const box = await rect(meter);
      expect([Math.round(box.width), Math.round(box.height)]).toEqual([28, 6]);
    }
    await captureProof(window, "04-status-bar.png");
  } finally {
    await harness.close();
  }
});
