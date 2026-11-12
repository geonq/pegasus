// The packaged host runs from a per-version copy; staging must be cheap when nothing changed and must
// report a host still running from an outdated copy, so a same-version install replaces it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runnableCopy } from "../dist/shared.js";

const name = process.platform === "win32" ? "pegasus-host.exe" : "pegasus-host";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pegasus-stage-"));
  const bundled = join(dir, name);
  // Any runnable executable works as a stand-in host binary.
  copyFileSync(process.execPath, bundled);
  const agentDir = join(dir, "agent");
  return { bundled, agentDir, target: join(agentDir, "host-bin", "9.9.9", name) };
}

test("stages once, then reuses the copy without rewriting it", async () => {
  process.env.PEGASUS_APP_VERSION = "9.9.9";
  const { bundled, agentDir, target } = setup();
  const first = await runnableCopy(bundled, agentDir);
  assert.deepEqual(first, { path: target, stale: false });
  const stagedAt = statSync(target).mtimeMs;
  assert.match(readFileSync(`${target}.source`, "utf8"), /^\d+:\d+$/);
  const second = await runnableCopy(bundled, agentDir);
  assert.deepEqual(second, { path: target, stale: false });
  assert.equal(statSync(target).mtimeMs, stagedAt);
});

test("a changed bundled binary is restaged when no host runs from the copy", async () => {
  process.env.PEGASUS_APP_VERSION = "9.9.9";
  const { bundled, agentDir, target } = setup();
  await runnableCopy(bundled, agentDir);
  const later = new Date(Date.now() + 60_000);
  utimesSync(bundled, later, later);
  const result = await runnableCopy(bundled, agentDir);
  assert.deepEqual(result, { path: target, stale: false });
  assert.equal(
    readFileSync(`${target}.source`, "utf8"),
    `${statSync(bundled).size}:${Math.round(statSync(bundled).mtimeMs)}`,
  );
});

test(
  "a host still running from an outdated copy is reported stale",
  { skip: process.platform !== "win32" && "only Windows locks a running executable" },
  async () => {
    process.env.PEGASUS_APP_VERSION = "9.9.9";
    const { bundled, agentDir, target } = setup();
    await runnableCopy(bundled, agentDir);
    const running = spawn(target, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const later = new Date(Date.now() + 60_000);
      utimesSync(bundled, later, later);
      const result = await runnableCopy(bundled, agentDir);
      assert.deepEqual(result, { path: bundled, stale: true });
    } finally {
      running.kill();
    }
  },
);
