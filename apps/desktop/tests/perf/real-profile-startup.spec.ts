/**
 * Startup timeline on a private copy of a real profile. Diagnostic, not a CI test: skipped unless
 * PEGASUS_PROFILE_COPY points at a folder holding agent/ and pi-gui/ copied from the live profile.
 * Never point it at the live profile: the run writes to it.
 *   PEGASUS_PROFILE_COPY=D:/pf/real-profile
 *   PEGASUS_PROFILE_WORKSPACES="D:/Pi;D:/Pi/projects/Homepage"   (optional, ; separated)
 *   PEGASUS_PROFILE_REMOTE_CONFIG=<host.json copy>               (optional: include Mac/remote setup)
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop } from "../helpers/electron-app";

const profile = process.env.PEGASUS_PROFILE_COPY;

test("startup timeline on a real profile copy", async () => {
  test.skip(!profile, "set PEGASUS_PROFILE_COPY to a copied profile");
  test.setTimeout(600_000);
  const lines: string[] = [];
  const started = Date.now();
  const stamp = (text: string) => lines.push(`${String(Date.now() - started).padStart(7)} ms  ${text}`);
  const h = await launchDesktop(join(profile!, "pi-gui"), {
    agentDir: join(profile!, "agent"),
    initialWorkspaces: (process.env.PEGASUS_PROFILE_WORKSPACES ?? "").split(";").filter(Boolean),
    testMode: "background",
    envOverrides: {
      PI_APP_STARTUP_TRACE: "1",
      ...(process.env.PEGASUS_PROFILE_REMOTE_CONFIG
        ? { PI_REMOTE_DESKTOP_HOST_CONFIG: process.env.PEGASUS_PROFILE_REMOTE_CONFIG }
        : {}),
    },
  });
  const capture = (chunk: unknown) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.includes("[startup]")) stamp(line.trim());
  };
  h.electronApp.process().stdout?.on("data", capture);
  h.electronApp.process().stderr?.on("data", capture);
  try {
    const page = await h.firstWindow();
    stamp("first window");
    await expect(page.locator(".session-row__select").first()).toBeVisible({ timeout: 540_000 });
    stamp("first sidebar row visible");
    // Main-thread blocks over 50 ms while background work (subagent sessions, runtimes) settles.
    await h.electronApp.evaluate(() => {
      const g = globalThis as unknown as { __blocks: number[] };
      g.__blocks = [];
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        if (now - last - 5 > 50) g.__blocks.push(Math.round(now - last - 5));
        last = now;
        setTimeout(tick, 5);
      };
      setTimeout(tick, 5);
    });
    // A fixed window, so work that starts late (runtimes, catalogs, subagent sessions) is counted.
    await page.waitForTimeout(Number(process.env.PEGASUS_PROFILE_SETTLE_MS ?? 15_000));
    const blocks = await h.electronApp.evaluate(
      () => (globalThis as unknown as { __blocks: number[] }).__blocks,
    );
    stamp(
      `settled: ${blocks.length} main blocks >50ms, max ${Math.max(0, ...blocks)} ms, sum ${blocks.reduce((s, n) => s + n, 0)} ms`,
    );
  } finally {
    stamp("done");
    const out = test.info().outputPath("startup-timeline.txt");
    await writeFile(out, lines.join("\n"));
    console.log(lines.join("\n"));
    await h.close();
  }
});
