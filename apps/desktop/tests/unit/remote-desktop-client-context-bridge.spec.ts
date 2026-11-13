import { build } from "esbuild";
import type { PiDesktopApi } from "../../contracts/ipc";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

test("remote client API crosses a sandboxed Electron contextBridge", async ({}, testInfo) => {
  const desktopRoot = resolve(__dirname, "../..");
  const fixtureRoot = resolve(__dirname, "../fixtures/remote-client-context-bridge");
  const preloadPath = testInfo.outputPath("remote-client-context-bridge-preload.cjs");
  const userDataPath = testInfo.outputPath("user-data");
  await build({
    entryPoints: [resolve(fixtureRoot, "preload.ts")],
    outfile: preloadPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
  });

  const args = [resolve(fixtureRoot, "main.cjs")];
  if (process.platform === "linux") {
    args.push("--disable-gpu", "--no-sandbox", "--disable-frame-rate-limit");
  }
  const electronApp = await electron.launch({
    args,
    cwd: desktopRoot,
    env: {
      ...process.env,
      PI_REMOTE_CONTEXT_BRIDGE_PRELOAD: preloadPath,
      PI_REMOTE_CONTEXT_BRIDGE_USER_DATA: userDataPath,
    },
  });
  try {
    const page = await electronApp.firstWindow();
    await page.waitForFunction(() => Boolean((window as Window & { piApp?: unknown }).piApp));
    const result = await page.evaluate(async () => {
      const api = (
        window as Window & {
          piApp?: {
            backend?: string;
            ping?: () => Promise<string>;
            getState?: () => Promise<{ themeMode?: string; composerDraft?: string }>;
          };
        }
      ).piApp;
      if (!api?.ping || !api.getState) return null;
      const state = await api.getState();
      return {
        hasOwnBackend: Object.prototype.hasOwnProperty.call(api, "backend"),
        backend: api.backend,
        ping: await api.ping(),
        themeMode: state.themeMode,
        composerDraft: state.composerDraft,
      };
    });
    expect(result).toEqual({
      hasOwnBackend: true,
      backend: "windows",
      ping: "pong",
      themeMode: "light",
      composerDraft: "",
    });
    // Paint every host increment through the sandboxed remote API, without navigation or reload.
    await page.evaluate(() => {
      const remote = window as unknown as {
        piApp: PiDesktopApi;
        startTranscriptStream: () => void;
      };
      const output = document.createElement("output");
      document.body.append(output);
      let updates = 0;
      remote.piApp.onSessionTranscriptDelta((delta) => {
        const patch = delta.patches[0];
        if (patch && patch.type !== "remove" && patch.item.kind === "activity") {
          output.textContent = patch.item.label;
          output.dataset.updates = String(++updates);
        }
      });
      const start = document.createElement("button");
      start.textContent = "Start stream";
      start.onclick = () => remote.startTranscriptStream();
      document.body.append(start);
    });
    await page.getByRole("button", { name: "Start stream" }).click();
    await expect(page.locator("output")).toHaveText("Streaming.....");
    await expect(page.locator("output")).toHaveAttribute("data-updates", "5");
  } finally {
    await electronApp.close();
  }
});
