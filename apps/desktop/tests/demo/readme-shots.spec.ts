import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createNamedThread,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  openNewThread,
  seedTranscriptMessages,
  waitForWorkspaceByPath,
  type DesktopHarness,
} from "../helpers/electron-app";

// README screenshots from a clean profile: fresh user data, demo folders, demo chats.
// Nothing from the owner's machine (folders, chats, accounts) can appear in them.
// Run: PI_APP_README_SHOTS_DIR=<repo>/docs/media playwright test -c tests/demo/playwright.demo.config.ts readme-shots
const shotDir = process.env.PI_APP_README_SHOTS_DIR?.trim() || join(__dirname, "..", "..", "..", "..", "docs", "media");

const FOLDERS = ["orbit-api", "atlas-web", "pegasus", "ledger"] as const;
const CHATS: ReadonlyArray<{ folder: (typeof FOLDERS)[number]; title: string }> = [
  { folder: "ledger", title: "Reconcile the monthly export" },
  { folder: "atlas-web", title: "Speed up the dashboard first paint" },
  { folder: "pegasus", title: "Sidebar keyboard navigation" },
  { folder: "orbit-api", title: "Add rate limiting to the public API" },
];

test("captures README screenshots from a clean profile", async () => {
  test.setTimeout(300_000);
  await mkdir(shotDir, { recursive: true });
  const folders = await Promise.all(FOLDERS.map((name) => makeGitWorkspace(name)));
  const userDataDir = await makeUserDataDir("pegasus-readme-");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: folders,
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    for (const path of folders) await waitForWorkspaceByPath(window, path);
    await window.evaluate(() => globalThis.window.piApp?.setEnableTransparency(false));
    await resize(harness, 1650, 960);

    for (const chat of CHATS) {
      await createNamedThread(window, chat.title, { workspaceName: chat.folder });
    }
    // The last chat gets a short, realistic exchange for the conversation shot.
    await seedTranscriptMessages(harness, window, {
      count: 2,
      textFactory: (index) =>
        index === 0
          ? "Add rate limiting to the public API. 100 requests a minute per key, and tell clients when they can retry."
          : [
              "Added a token-bucket limiter in front of the public routes.",
              "",
              "```ts",
              "export function rateLimit(store: BucketStore, perMinute = 100): Middleware {",
              "  return async (request, next) => {",
              "    const bucket = await store.take(request.apiKey, perMinute);",
              "    if (bucket.remaining < 0) {",
              '      return tooManyRequests({ "Retry-After": String(bucket.resetSeconds) });',
              "    }",
              "    return next(request);",
              "  };",
              "}",
              "```",
              "",
              "- Limits are per API key, 100 a minute by default.",
              "- Rejected calls get **429** with a `Retry-After` header.",
              "- Tests cover the limit, the reset and two keys sharing a store.",
            ].join("\n"),
    });
    await window.locator(".session-row").first().click();
    await shot(window, "pegasus-chat.png");

    await openNewThread(window);
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();
    await shot(window, "pegasus-new-chat.png");
  } finally {
    await harness.close();
  }
});

async function resize(harness: DesktopHarness, width: number, height: number): Promise<void> {
  await harness.electronApp.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
    { width, height },
  );
}

async function shot(window: Page, name: string): Promise<void> {
  // Let fonts, syntax colours and the sidebar settle before the capture.
  await window.evaluate(() => document.fonts.ready);
  await window.waitForTimeout(600);
  // A clean profile: only demo folders and chats may be on screen, never real ones.
  const text = await window.evaluate(() => document.body.innerText);
  for (const folder of FOLDERS) expect(text).toContain(folder);
  expect(text).not.toMatch(/sprintline|FC27|LifeOS|Seher|DeepLife|rito|geonq|domke/i);
  console.log(`${name} sidebar: ${(await window.locator(".sidebar").innerText()).replace(/\s+/g, " ").slice(0, 400)}`);
  console.log(`${name} main: ${(await window.locator(".main").innerText()).replace(/\s+/g, " ").slice(0, 400)}`);
  await window.screenshot({ path: join(shotDir, name) });
}
