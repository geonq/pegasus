import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createNamedThread,
  jumpTimelineToBottom,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
  writeProjectExtension,
} from "../helpers/electron-app";
import { captureProof, rect, spreadContrast } from "../helpers/ui-chrome";

// Reports "full" like the Pi permissions extension does, so the composer shows its permission chip.
const permissionExtension = String.raw`
export default function permissionExtension(pi) {
  pi.registerCommand("permissions", { description: "Set permissions", handler: async () => {} });
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("pi-permission", "full"));
}
`;

/** Computed blur of a floating surface and every ancestor that would stop it at a backdrop root. */
async function acrylicOf(surface: Locator) {
  return surface.evaluate((node) => {
    const roots: string[] = [];
    for (let el = node.parentElement; el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (
        cs.backdropFilter !== "none" ||
        cs.filter !== "none" ||
        Number(cs.opacity) < 1 ||
        cs.maskImage !== "none" ||
        cs.clipPath !== "none" ||
        cs.mixBlendMode !== "normal" ||
        /opacity|filter|mask/.test(cs.willChange)
      )
        roots.push(String(el.className || el.tagName));
    }
    return { backdrop: getComputedStyle(node).backdropFilter, roots };
  });
}

async function expectAcrylic(surface: Locator) {
  const acrylic = await acrylicOf(surface);
  expect(acrylic.backdrop).toMatch(/blur\(32px\) saturate\(1\.8\)/);
  expect(acrylic.roots).toEqual([]);
}

async function setTheme(window: Page, mode: "dark" | "light") {
  await window.evaluate((next) => globalThis.window.piApp?.setThemeMode(next), mode);
  await window.waitForTimeout(300);
}

test("popovers, the permission menu and the sidebar toggle tooltip sit where they belong", async () => {
  test.setTimeout(120_000);
  const workspace = await makeWorkspace("popover-workspace");
  await writeProjectExtension(workspace, "permission-extension.ts", permissionExtension);
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Popover thread");
    await seedTranscriptMessages(harness, window, {
      count: 24,
      textFactory: (i) =>
        `Row ${i}: the quick brown fox jumps over the lazy dog while the transcript keeps going with more readable words across the whole column width.`,
    });
    await jumpTimelineToBottom(window);

    for (const mode of ["dark", "light"] as const) {
      await setTheme(window, mode);

      // Sidebar toggle tooltip: beside the button, vertically centred on it, never over the rows below.
      await window.mouse.move(400, 400);
      const toggle = window.getByTestId("sidebar-toggle");
      await toggle.hover();
      const tooltip = window.locator(".sidebar-toggle__tooltip");
      await expect(tooltip).toHaveCSS("opacity", "1");
      await captureProof(window, `sidebar-toggle-tooltip-${mode}.png`);
      await expectAcrylic(tooltip);
      const button = await rect(toggle);
      const tip = await rect(tooltip);
      expect(tip.x).toBeGreaterThanOrEqual(button.x + button.width + 4);
      expect(Math.abs(tip.y + tip.height / 2 - (button.y + button.height / 2))).toBeLessThanOrEqual(1);

      // Model picker over the transcript.
      await window.mouse.move(400, 400);
      await window.locator(".model-selector__badge").first().click();
      const dropdown = window.locator(".model-selector__dropdown").first();
      await expect(dropdown).toBeVisible();
      await captureProof(window, `model-picker-${mode}.png`);
      await expectAcrylic(dropdown);
      // With the rows hidden, only what shows through the acrylic is left: a smear, not text.
      const box = await rect(dropdown);
      await dropdown.evaluate((node) => {
        for (const child of Array.from(node.children))
          (child as HTMLElement).style.visibility = "hidden";
      });
      const through = spreadContrast(
        await window.screenshot({ clip: { x: box.x + 8, y: box.y + 8, width: box.width - 16, height: box.height - 16 } }),
      );
      console.log(`[proof] ${mode} model picker see-through contrast ${through.toFixed(2)}`);
      expect(through).toBeLessThan(1.5);
      await window.keyboard.press("Escape");

      // Permission menu: every label whole, its description below it.
      const chip = window.getByRole("button", { name: /^Permissions:/ });
      await chip.click();
      const menu = window.locator(".model-selector", { has: chip }).locator(".model-selector__dropdown");
      await expect(menu).toBeVisible();
      await captureProof(window, `permission-menu-${mode}.png`);
      await expectAcrylic(menu);
      const rows = menu.locator(".model-selector__item");
      await expect(rows).toHaveCount(4);
      for (const row of await rows.all()) {
        const label = await rect(row.locator(".model-selector__item-label"));
        const meta = await rect(row.locator(".model-selector__item-meta"));
        expect(meta.y).toBeGreaterThanOrEqual(label.y + label.height - 1);
        const clipped = await row
          .locator(".model-selector__item-label")
          .evaluate((node) => node.scrollWidth > node.clientWidth);
        expect(clipped).toBe(false);
      }
      await expect(menu.getByText("Full access", { exact: true })).toBeVisible();
      await window.keyboard.press("Escape");
    }
  } finally {
    await harness.close();
  }
});
