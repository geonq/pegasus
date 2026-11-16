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

test("summaries and durations stay one short line", () => {
  assert.equal(toolsSummary(1, 0, false), "1 step");
  assert.equal(toolsSummary(4, 1, false), "4 steps · 1 failed");
  assert.equal(toolsSummary(4, 1, true), "4 steps · running");
  assert.equal(formatDuration(900), "1s");
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(64_000), "1m 04s");
  assert.equal(formatDuration(3_720_000), "1h 02m");
});
