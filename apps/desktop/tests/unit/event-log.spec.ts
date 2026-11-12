import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  flushEventLog,
  initEventLog,
  logEvent,
  traceEvent,
} from "../../electron/diagnostics/event-log";
import { SessionEventRecorder } from "../../electron/diagnostics/session-events";

// The log is one module-level sink per process, so the tests share one folder and read new lines.
let dir: string;
let seen = 0;
async function newLines(): Promise<Record<string, unknown>[]> {
  await flushEventLog();
  const text = await readFile(join(dir, "events.ndjson"), "utf8").catch(() => "");
  const lines = text.split("\n").filter(Boolean);
  const fresh = lines.slice(seen);
  seen = lines.length;
  return fresh.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "event-log-"));
  initEventLog(dir);
});

test("lines carry time, a per-process number, the pid, source and kind", async () => {
  logEvent("app.start", { version: "1.2.3" });
  logEvent("x.second");
  const [first, second] = await newLines();
  expect(first).toMatchObject({ k: "app.start", src: "main", p: process.pid, version: "1.2.3" });
  expect(typeof first?.t).toBe("number");
  expect(Number(second?.n)).toBe(Number(first?.n) + 1);
});

test("trace lines stay in memory until an error, then precede it as context", async () => {
  traceEvent("ipc", { ch: "selectSession", ms: 3 });
  traceEvent("ipc", { ch: "submitComposer", ms: 9 });
  expect(await newLines()).toEqual([]);
  logEvent("ipc.error", { l: "e", ch: "submitComposer", msg: "boom" });
  const lines = await newLines();
  expect(lines.map((line) => line.k)).toEqual(["ipc", "ipc", "ipc.error"]);
  expect(lines[0]).toMatchObject({ ctx: 1, ch: "selectSession" });
  expect(lines[2]).toMatchObject({ l: "e", msg: "boom" });
  // The ring is spent: the next error has no stale context.
  logEvent("ipc.error", { l: "e", ch: "other" });
  expect((await newLines()).map((line) => line.k)).toEqual(["ipc.error"]);
});

test("long fields are clipped and undefined fields dropped", async () => {
  logEvent("big", { msg: "x".repeat(5_000), gone: undefined });
  const [line] = await newLines();
  expect(String(line?.msg).length).toBeLessThan(2_100);
  expect(line).not.toHaveProperty("gone");
});

test("a run is a few lines: start, each tool, end with totals; tokens are only counted", async () => {
  const recorder = new SessionEventRecorder();
  const sessionRef: SessionRef = { workspaceId: "w", sessionId: "session-1" };
  const base = { sessionRef, timestamp: new Date().toISOString(), runId: "run-1" };
  const snapshot = (status: "running" | "idle") => ({
    ref: sessionRef,
    workspace: { workspaceId: "w", path: "/w", displayName: "w" },
    title: "t",
    status,
    updatedAt: new Date().toISOString(),
    runningRunId: "run-1",
    config: { provider: "anthropic", modelId: "claude-opus-5-5" },
  });
  const events: SessionDriverEvent[] = [
    { ...base, type: "sessionUpdated", snapshot: snapshot("running") },
    ...Array.from({ length: 200 }, (): SessionDriverEvent => ({ ...base, type: "assistantDelta", text: "tok " })),
    { ...base, type: "toolStarted", toolName: "bash", callId: "c1" },
    { ...base, type: "toolFinished", callId: "c1", success: false },
    { ...base, type: "runFailed", error: { message: "provider overloaded", code: "529" } },
  ] as SessionDriverEvent[];
  for (const event of events) recorder.record(event);
  const lines = await newLines();
  // 200 deltas write nothing; tool.start is a trace line, written only as context of the failure.
  expect(lines.map((line) => line.k)).toEqual(["run.start", "tool.end", "tool.start", "run.failed"]);
  expect(lines[2]).toMatchObject({ ctx: 1, tool: "bash" });
  const failed = lines.find((line) => line.k === "run.failed");
  expect(failed).toMatchObject({
    l: "e",
    s: "session-1",
    r: "run-1",
    deltas: 200,
    chars: 800,
    tools: 1,
    toolErrors: 1,
    msg: "provider overloaded",
    code: "529",
  });
  expect(lines.find((line) => line.k === "run.start")).toMatchObject({ model: "claude-opus-5-5" });
  expect(lines.find((line) => line.k === "tool.end")).toMatchObject({ tool: "bash", ok: false, l: "w" });
});
