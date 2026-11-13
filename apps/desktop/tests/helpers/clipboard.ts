import type { Page } from "@playwright/test";

/** Records copies in the page instead of the OS clipboard, which the owner may be using. */
export async function stubClipboard(window: Page): Promise<void> {
  await window.evaluate(() => {
    const copied: string[] = [];
    (globalThis as { __copied?: string[] }).__copied = copied;
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text: string) => {
        copied.push(text);
      },
    });
  });
}

export function copiedTexts(window: Page): Promise<string[]> {
  return window.evaluate(() => (globalThis as { __copied?: string[] }).__copied ?? []);
}
