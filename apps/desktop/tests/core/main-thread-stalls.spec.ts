import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

test("logs a blocked main thread, where typing waits", async () => {
  const userDataDir = await makeUserDataDir();
  const h = await launchDesktop(userDataDir, {
    initialWorkspaces: [await makeWorkspace("main-thread-stalls")],
    testMode: "background",
  });
  try {
    await h.firstWindow();
    await h.electronApp.evaluate(() => {
      const until = Date.now() + 600;
      while (Date.now() < until) {
        // Hold the main thread the way a synchronous agent step would.
      }
    });
    const log = join(userDataDir, "logs", "main-thread-stalls.log");
    await expect
      .poll(async () => readFile(log, "utf8").catch(() => ""))
      .toMatch(/main thread blocked (5\d\d|6\d\d|7\d\d) ms\n {4}\d+ ms in /);
  } finally {
    await h.close();
  }
});

test("logs a slow window frame with the script that held it", async () => {
  const userDataDir = await makeUserDataDir();
  const h = await launchDesktop(userDataDir, {
    initialWorkspaces: [await makeWorkspace("renderer-stalls")],
    testMode: "background",
  });
  try {
    const window = await h.firstWindow();
    // The app document must be the one loaded: a timer set before it commits dies with the old one.
    await expect(window.getByTestId("sidebar-usage")).toBeVisible();
    // From a page timer: work Playwright runs directly carries no script attribution.
    // Resolves once the timer has held the window, so the stall surely happened in this document.
    const stall = () =>
      window.evaluate(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              requestAnimationFrame(() => undefined);
              const until = Date.now() + 300;
              while (Date.now() < until) {
                // Hold the window the way a heavy render would.
              }
              resolve();
            }, 0);
          }),
      );
    // A never-shown window draws only when asked, and a long frame is reported once the next one is
    // drawn; a window someone looks at draws continuously.
    const nextFrame = () =>
      window.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const browserSawIt = () =>
      window.evaluate(() =>
        performance.getEntriesByType("long-animation-frame").some((entry) => entry.duration >= 290),
      );
    // Chromium sometimes records no long frame at all for a never-shown window (Windows background
    // mode); that is the browser, not Pegasus. Stall again until the browser has the frame, then the
    // part under test: Pegasus logs it with the script that held it.
    for (let attempt = 0; attempt < 5 && !(await browserSawIt()); attempt += 1) {
      await stall();
      await nextFrame();
    }
    expect(await browserSawIt()).toBe(true);
    const log = join(userDataDir, "logs", "renderer-stalls.log");
    await expect
      .poll(async () => {
        await nextFrame();
        return readFile(log, "utf8").catch(() => "");
      })
      .toMatch(
        /ms \(blocking \d+ ms\) in [\w?-]+\n.*\n {4}(29\d|3\d\d|4\d\d) ms in .* via TimerHandler:setTimeout/,
      );
  } finally {
    await h.close();
  }
});
