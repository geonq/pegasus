import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// pi reads the agent dir from the environment at import time, so point it at a scratch dir first.
const agentDir = await mkdtemp(join(tmpdir(), "pegasus-sidecar-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PEGASUS_SIDECAR_CACHE = join(agentDir, "index-cache.json");

const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { listSessionInfos, openTranscriptSource, closeSidecar } =
  await import("../dist/sidecar-client.js");
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

test.before(async () => {
  await mkdir(sessionDir, { recursive: true });
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
});
test.after(async () => {
  closeSidecar();
  await rm(agentDir, { recursive: true, force: true });
});

const dev =
  existsSync(join(import.meta.dirname, "../../../crates/target/release/pegasus-sidecar.exe")) ||
  existsSync(join(import.meta.dirname, "../../../crates/target/release/pegasus-sidecar"));

test("a crashing sidecar binary falls back to pi's reader", async () => {
  // node itself exits immediately on these arguments: stands in for a sidecar that dies at start-up.
  process.env.PEGASUS_SIDECAR_PATH = process.execPath;
  const infos = await listSessionInfos(cwd);
  assert.equal(infos.length, 1);
  assert.equal(infos[0]?.firstMessage, "hello");
  const src = await openTranscriptSource(file);
  assert.ok(transcriptFromSession(src).length > 0);
  delete process.env.PEGASUS_SIDECAR_PATH;
  closeSidecar();
});

test("PEGASUS_SIDECAR=0 disables it", async () => {
  process.env.PEGASUS_SIDECAR = "0";
  assert.equal((await listSessionInfos(cwd)).length, 1);
  delete process.env.PEGASUS_SIDECAR;
});

test(
  "sidecar results equal pi's (list and transcript)",
  { skip: !dev && "sidecar binary not built" },
  async () => {
    // The previous test started the respawn cooldown; wait it out by loading a fresh module instance.
    const fresh = await import(`../dist/sidecar-client.js?fresh=${Date.now()}`);
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a);
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
    console.warn = warn;
    assert.deepEqual(warnings, [], "the sidecar must serve these without falling back");
    fresh.closeSidecar();
  },
);
