// Plain Node tests for the phone's work log: node --test --experimental-strip-types
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, groupTranscript, toolsSummary } from "./worklog.ts";
import type { TranscriptItem } from "./types.ts";

const tool = (id: string, status: "running" | "success" | "error"): TranscriptItem => ({
  kind: "tool",
  id,
  toolName: "read",
  status,
  label: `Read ${id}`,
  createdAt: "2026-11-13T10:00:00.000Z",
});

test("consecutive tool calls collapse into one row; messages and thinking stay", () => {
  const rows = groupTranscript([
    { kind: "message", id: "u1", role: "user", text: "hi", createdAt: "t" },
    tool("t1", "success"),
    tool("t2", "error"),
    { kind: "thinking", id: "h1", text: "hmm", durationMs: 2000, createdAt: "t" },
    tool("t3", "running"),
    { kind: "activity", id: "a1", label: "Compacting", createdAt: "t" },
    { kind: "message", id: "m1", role: "assistant", text: "done", createdAt: "t" },
  ]);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["message", "tools", "thinking", "tools", "activity", "message"],
  );
  const first = rows[1];
  if (!first || first.kind !== "tools") throw new Error("expected a tool group");
  assert.deepEqual(
    first.tools.map((item) => item.id),
    ["t1", "t2"],
  );
  assert.equal(first.failed, 1);
  assert.equal(first.running, false);
  const second = rows[3];
  if (!second || second.kind !== "tools") throw new Error("expected a tool group");
  assert.equal(second.running, true);
  const thinking = rows[2];
  if (!thinking || thinking.kind !== "thinking") throw new Error("expected thinking");
  assert.equal(thinking.durationMs, 2000);
});

test("a tool run that ends the transcript is still grouped", () => {
  const rows = groupTranscript([tool("t1", "success"), tool("t2", "success")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "tools");
});

test("tool durations run to the next row; a run ending the transcript has none yet", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 13, 10, 0, s)).toISOString();
  const rows = groupTranscript([
    { ...tool("t1", "success"), createdAt: at(0) } as TranscriptItem,
    { ...tool("t2", "success"), createdAt: at(4) } as TranscriptItem,
    { kind: "message", id: "m1", role: "assistant", text: "ok", createdAt: at(10) },
    { ...tool("t3", "success"), createdAt: at(12) } as TranscriptItem,
  ]);
  const first = rows[0];
  if (!first || first.kind !== "tools") throw new Error("expected a tool group");
  assert.deepEqual(first.durations, [4000, 6000]);
  assert.equal(first.durationMs, 10_000);
  const last = rows[2];
  if (!last || last.kind !== "tools") throw new Error("expected a tool group");
  assert.equal(last.durationMs, undefined);
});

test("ask_user and show_ui become their own rows and split tool runs", () => {
  const rows = groupTranscript([
    tool("t1", "success"),
    { ...tool("q1", "running"), toolName: "ask_user" } as TranscriptItem,
    tool("t2", "success"),
  ]);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["tools", "ui", "tools"],
  );
});

test("activity entries (working subagents) survive; junk entries are dropped", () => {
  const rows = groupTranscript([
    {
      kind: "activity",
      id: "a1",
      label: "2 agents working",
      createdAt: "t",
      entries: ["Reviewer", 3, "Planner"],
    } as TranscriptItem,
  ]);
  const row = rows[0];
  if (!row || row.kind !== "activity") throw new Error("expected activity");
  assert.deepEqual(row.entries, ["Reviewer", "Planner"]);
});

test("summaries and durations stay one short line", () => {
  assert.equal(toolsSummary(1, 0, false), "1 step");
  assert.equal(toolsSummary(4, 1, false), "4 steps · 1 failed");
  assert.equal(toolsSummary(4, 1, true), "4 steps · running");
  assert.equal(formatDuration(900), "1s");
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(64_000), "1m 04s");
  assert.equal(formatDuration(3_720_000), "1h 02m");
});
