import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  jumpTimelineToBottom,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
} from "../helpers/electron-app";
import { captureProof, HT, rect, spreadContrast, windowsHitTest } from "../helpers/ui-chrome";

const GLASS = /blur\(12px\) saturate\(1\.8\)/;

/** The surface's own fill and blur, and every ancestor that would cut its blur off. */
async function glassOf(surface: Locator) {
  return surface.evaluate((node) => {
    const roots: string[] = [];
    for (let el = node.parentElement; el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (
        cs.backdropFilter !== "none" ||
        cs.filter !== "none" ||
        Number(cs.opacity) < 1 ||
        cs.maskImage !== "none" ||
        /opacity|filter|mask/.test(cs.willChange)
      )
        roots.push(el.className || el.tagName);
    }
    const cs = getComputedStyle(node);
    return { backdrop: cs.backdropFilter, background: cs.backgroundColor, roots };
  });
}

async function expectGlass(surface: Locator) {
  await expect(surface).toBeVisible();
  const glass = await glassOf(surface);
  expect(glass.backdrop).toMatch(GLASS);
  // About 78% of the surface colour: translucent, not solid and not see-through.
  const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(glass.background)?.[1] ?? 1);
  expect(alpha).toBeGreaterThanOrEqual(0.72);
  expect(alpha).toBeLessThanOrEqual(0.8);
  expect(glass.roots).toEqual([]);
}

async function seedLongTranscript(
  harness: Parameters<typeof seedTranscriptMessages>[0],
  window: Page,
) {
  await seedTranscriptMessages(harness, window, {
    count: 24,
    textFactory: (i) =>
      `Row ${i}: the quick brown fox jumps over the lazy dog while the transcript keeps going with more readable words across the whole column width.`,
  });
  await jumpTimelineToBottom(window);
}

test("every floating surface is frosted glass whose blur reaches the content behind it", async () => {
  test.setTimeout(120_000);
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("floating-glass-workspace")],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Glass target thread");
    await createNamedThread(window, "Glass thread");
    await seedLongTranscript(harness, window);

    // Slash menu over the transcript, its rows hidden so only what shows through is measured.
    const composer = window.getByTestId("composer");
    await composer.fill("/");
    const slash = window.getByTestId("slash-menu");
    await expectGlass(slash);
    await captureProof(window, "01-glass-slash-menu.png");
    const box = await rect(slash);
    const clip = { x: box.x + 16, y: box.y + 16, width: box.width - 32, height: box.height - 32 };
    await slash.evaluate((node) => {
      for (const child of Array.from(node.children))
        (child as HTMLElement).style.visibility = "hidden";
    });
    const throughGlass = spreadContrast(await window.screenshot({ clip }));
    await slash.evaluate((node) => ((node as HTMLElement).style.visibility = "hidden"));
    const bare = spreadContrast(await window.screenshot({ clip }));
    // Text behind reads at 15:1 uncovered; under the glass it is a smear below 1.5:1.
    expect(bare).toBeGreaterThan(4.5);
    expect(throughGlass).toBeLessThan(1.5);
    await composer.fill("");

    // Model menu and the header tooltip.
    await window.locator(".model-selector__badge").first().click();
    await expectGlass(window.locator(".model-selector__dropdown").first());
    await window.keyboard.press("Escape");
    await window.locator(".topbar__tooltip-wrap").hover();
    await expectGlass(window.locator(".topbar__tooltip"));
    await captureProof(window, "01-glass-header-tooltip.png");

    // Chat hover card and the row's context menu, both portalled to the body.
    const row = window.locator(".session-row", { hasText: "Glass target thread" }).first();
    await window.mouse.move(0, 0);
    await row.hover();
    const card = window.getByTestId("thread-hover-card");
    await expectGlass(card);
    await captureProof(window, "01-glass-hover-card.png");
    await row.click({ button: "right" });
    await expectGlass(window.locator(".floating-menu").getByRole("menu"));
    await window.keyboard.press("Escape");

    // Command palette.
    await window.keyboard.press(desktopShortcut("K"));
    await expectGlass(window.getByTestId("command-palette"));
    await window.keyboard.press("Escape");

    // Surfaces that need a long setup carry the same class rule; check each one's computed style.
    const others = await window.evaluate(() =>
      [
        "context-meter__card",
        "undo-toast",
        "attention-toast",
        "timeline-jump",
        "thread-switcher__panel",
        "tree-modal",
        "extension-dialog",
        "scheduled-editor",
        "annotation-editor",
        "annotation-chip__list",
        "chart-tooltip-panel",
      ].map((name) => {
        const probe = document.createElement("div");
        probe.className = name;
        document.body.append(probe);
        const backdrop = getComputedStyle(probe).backdropFilter;
        probe.remove();
        return `${name}: ${backdrop}`;
      }),
    );
    for (const line of others) expect(line).toMatch(GLASS);

    // The glass never sits on the window's drag strips: Windows still moves the window there.
    if (process.platform === "win32") {
      const top = await rect(window.locator(".sidebar__top"));
      const header = await rect(window.getByTestId("topbar"));
      const codes = await windowsHitTest(harness, [
        { x: top.x + top.width / 2, y: top.y + 12 },
        { x: header.x + 360, y: header.y + header.height / 2 },
      ]);
      expect(codes).toEqual([HT.caption, HT.caption]);
    }
  } finally {
    await harness.close();
  }
});
