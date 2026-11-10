import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// pi reads the agent dir from the environment at import time, so point it at a scratch dir first.
const agentDir = await mkdtemp(join(tmpdir(), "pegasus-host-sessions-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PEGASUS_HOST_IDLE_SECS = "20";
// The package test script disables the host so other suites never start one on the real profile;
// this suite runs on its own scratch agent dir and exercises it.
delete process.env.PEGASUS_HOST;

const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { listSessionInfos, openTranscriptSource, closeHostConnection, stopHost } =
  await import("../dist/host-sessions.js");
const { transcriptFromSession } = await import("../dist/session-supervisor-utils.js");

const cwd = join(agentDir, "work");
const sessionDir = join(
  agentDir,
  "sessions",
  `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`,
);
const file = join(sessionDir, "2026-10-28T09-09-03-836Z_s1.jsonl");
const lines = [
  { type: "session", version: 3, id: "s1", timestamp: "2026-10-28T09:09:03.836Z", cwd },
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-10-28T09:10:00.000Z",
    message: { role: "user", content: "hello", timestamp: 1793178600000 },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-10-28T09:11:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      timestamp: 1793178660000,
    },
  },
];

await mkdir(sessionDir, { recursive: true });
await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

type HostModule = typeof import("../dist/host-sessions.js");

function isHostModule(mod: unknown): mod is HostModule {
  return (
    typeof mod === "object" &&
    mod !== null &&
    "listSessionInfos" in mod &&
    typeof mod.listSessionInfos === "function" &&
    "openTranscriptSource" in mod &&
    typeof mod.openTranscriptSource === "function" &&
    "stopHost" in mod &&
    typeof mod.stopHost === "function"
  );
}

const exe = process.platform === "win32" ? "pegasus-host.exe" : "pegasus-host";
const built = ["release", "debug"].some((p) =>
  existsSync(join(import.meta.dirname, "../../../crates/target", p, exe)),
);

await test("a host binary that dies at start-up falls back to pi's reader", async () => {
  // node exits immediately on these arguments: stands in for a host that crashes at launch.
  process.env.PEGASUS_HOST_PATH = process.execPath;
  const infos = await listSessionInfos(cwd);
  assert.equal(infos.length, 1);
  assert.equal(infos[0]?.firstMessage, "hello");
  const src = await openTranscriptSource(file);
  assert.ok(transcriptFromSession(src).length > 0);
  delete process.env.PEGASUS_HOST_PATH;
  closeHostConnection();
});

await test("PEGASUS_HOST=0 disables it", async () => {
  process.env.PEGASUS_HOST = "0";
  assert.equal((await listSessionInfos(cwd)).length, 1);
  delete process.env.PEGASUS_HOST;
});

await test(
  "host results equal pi's (list and transcript)",
  { skip: !built && "pegasus-host not built" },
  async () => {
    // The first test started the retry cooldown; a fresh module instance has none.
    const loaded: unknown = await import(`../dist/host-sessions.js?fresh=${Date.now()}`);
    assert.ok(isHostModule(loaded), "fresh host-sessions module has the expected exports");
    const fresh = loaded;
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a);
    try {
      const viaRs = await fresh.listSessionInfos(cwd);
      const viaPi = await SessionManager.list(cwd);
      const pick = (s: (typeof viaPi)[number]) => [
        s.id,
        s.cwd,
        s.created.getTime(),
        s.modified.getTime(),
        s.messageCount,
        s.firstMessage,
      ];
      assert.deepEqual(viaRs.map(pick), viaPi.map(pick));
      const a = JSON.stringify(transcriptFromSession(await fresh.openTranscriptSource(file)));
      const b = JSON.stringify(transcriptFromSession(SessionManager.open(file)));
      assert.equal(a, b);
    } finally {
      console.warn = warn;
      await fresh.stopHost();
    }
    assert.deepEqual(warnings, [], "the host must serve these without falling back");
  },
);

await stopHost();
await rm(agentDir, { recursive: true, force: true });
