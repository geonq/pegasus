// Drives the real debug pegasus-host through the TS client: launch-on-demand, typed calls, typed
// errors, version replacement and shutdown. Build first: cargo build -p pegasus-host (crates/).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HostCallError, HostClient, hostEndpoint } from "../dist/index.js";

const exe = process.platform === "win32" ? "pegasus-host.exe" : "pegasus-host";
const binary = fileURLToPath(new URL(`../../../crates/target/debug/${exe}`, import.meta.url));

function launchFor(profile) {
  return {
    binary,
    args: [
      "--endpoint",
      hostEndpoint(profile),
      "--sessions-root",
      join(profile, "sessions"),
      "--log-dir",
      join(profile, "logs"),
      "--idle-exit-secs",
      "30",
    ],
  };
}

test("endpoint is stable per profile and differs between profiles", () => {
  assert.equal(hostEndpoint("C:\\A\\B", "win32"), hostEndpoint("c:\\a\\b", "win32"));
  assert.notEqual(hostEndpoint("C:\\A", "win32"), hostEndpoint("C:\\B", "win32"));
  assert.match(hostEndpoint("C:\\A", "win32"), /^\\\\\.\\pipe\\pegasus-host-[0-9a-f]{16}$/);
});

test(
  "launches, answers typed calls, replaces an old version, shuts down",
  { skip: !existsSync(binary) && "host not built" },
  async () => {
    const profile = mkdtempSync(join(tmpdir(), "pegasus-host-client-"));
    const launch = launchFor(profile);
    const endpoint = hostEndpoint(profile);

    // Debug host reports CARGO_PKG_VERSION 0.1.0; a client at that version attaches without replacing.
    const a = await HostClient.attach({ endpoint, launch, client: "test", appVersion: "0.1.0" });
    const firstPid = a.hello.pid;
    assert.equal((await a.call("index.list", {})).sessions.length, 0);
    await assert.rejects(
      a.call("session.context", { path: join(profile, "nope.jsonl"), pinType: "p" }),
      (e) => e instanceof HostCallError && e.code === "bad_path",
    );

    // A second client sees the same host.
    const b = await HostClient.attach({ endpoint, launch, client: "test2", appVersion: "0.1.0" });
    assert.equal(b.hello.pid, firstPid);
    assert.equal((await b.call("status", {})).clients, 2);
    a.close();
    b.close();

    // A client of another version asks the idle host to exit and starts its own.
    const c = await HostClient.attach({ endpoint, launch, client: "test3", appVersion: "9.9.9" });
    assert.notEqual(c.hello.pid, firstPid);
    const events = [];
    c.onEvent((e) => events.push(e.event));
    assert.deepEqual(await c.call("shutdown", { reason: "test done", force: true }), {
      accepted: true,
      activeWork: 0,
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(events, ["shuttingDown"]);
    assert.equal(c.closed, true);
  },
);
