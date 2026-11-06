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
    await window.evaluate(() => {
      setTimeout(() => {
        const until = Date.now() + 300;
        while (Date.now() < until) {
          // Hold the window the way a heavy render would.
        }
      }, 0);
    });
    const log = join(userDataDir, "logs", "renderer-stalls.log");
    await expect
      .poll(async () => readFile(log, "utf8").catch(() => ""))
      .toMatch(
        /ms \(blocking \d+ ms\) in [\w?-]+\n.*\n {4}(29\d|3\d\d|4\d\d) ms in .* via TimerHandler:setTimeout/,
      );
  } finally {
    await h.close();
  }
});
