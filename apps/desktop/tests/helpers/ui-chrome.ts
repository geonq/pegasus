import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { DesktopHarness } from "./electron-app";

const proofDir = process.env.PI_APP_UI_CHROME_PROOF_DIR;

/** Saves a proof screenshot when PI_APP_UI_CHROME_PROOF_DIR is set. */
export async function captureProof(window: Page, filename: string): Promise<void> {
  if (!proofDir) return;
  await mkdir(proofDir, { recursive: true });
  await window.screenshot({ path: join(proofDir, filename) });
}

export async function rect(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return box;
}

const { PNG } = createRequire(__filename)("playwright-core/lib/utilsBundle") as {
  PNG: { sync: { read(buffer: Buffer): { data: Buffer } } };
};

/**
 * WCAG contrast between the 1st and 99th luminance percentile of a screenshot: about 1 for a flat
 * area, well above 3 where text shows through.
 */
export function spreadContrast(png: Buffer): number {
  const { data } = PNG.sync.read(png);
  const lum: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    lum.push(0.2126 * r! + 0.7152 * g! + 0.0722 * b!);
  }
  lum.sort((a, b) => a - b);
  const lo = lum[Math.floor(lum.length * 0.01)]!;
  const hi = lum[Math.floor(lum.length * 0.99)]!;
  return (hi + 0.05) / (lo + 0.05);
}

/** Win32 WM_NCHITTEST results: what Windows does with a click at each client point. */
export const HT = { client: 1, caption: 2, maxButton: 9, close: 20 } as const;

/** Win32 window style bits that Aero snap (dragging to an edge) and Win+Z rely on. */
export const WS = { thickFrame: 0x40000, maximizeBox: 0x10000 } as const;

/** GetWindowLong(GWL_STYLE) of the app's first window. */
export async function windowsStyle(harness: DesktopHarness): Promise<number> {
  const [style] = await runWin32(harness, () => ["[H]::GetWindowLong($h, -16)"]);
  return style!;
}

export async function windowsHitTest(
  harness: DesktopHarness,
  points: readonly { readonly x: number; readonly y: number }[],
): Promise<number[]> {
  return runWin32(harness, (info) =>
    points.map(({ x, y }) => {
      const sx = Math.round((info.bounds.x + x) * info.scale);
      const sy = Math.round((info.bounds.y + y) * info.scale);
      return `[H]::SendMessage($h, 0x84, [IntPtr]::Zero, [IntPtr]::new((${sy} -shl 16) -bor (${sx} -band 0xffff))).ToInt64()`;
    }),
  );
}

async function runWin32(
  harness: DesktopHarness,
  calls: (info: { bounds: { x: number; y: number }; scale: number }) => string[],
): Promise<number[]> {
  const info = await harness.electronApp.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const handle = win.getNativeWindowHandle();
    const bounds = win.getContentBounds();
    return {
      hwnd: (handle.length === 8
        ? handle.readBigUInt64LE()
        : BigInt(handle.readUInt32LE())
      ).toString(),
      bounds,
      scale: screen.getDisplayMatching(bounds).scaleFactor,
    };
  });
  const script = [
    'Add-Type -TypeDefinition @"',
    "using System; using System.Runtime.InteropServices;",
    'public static class H { [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l); [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i); }',
    '"@',
    `$h = [IntPtr]::new([Int64]${info.hwnd})`,
    ...calls(info),
  ].join("\n");
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      encoding: "utf8",
    },
  );
  return out.trim().split(/\s+/).map(Number);
}
