import { expect, test } from "@playwright/test";
import type { TranscriptMessage } from "../../contracts/desktop-state";
import {
  CHILD_START_STALL_MS,
  childHasRun,
  idleChildStatus,
} from "../../electron/orchestration/app-store-orchestration";

const noTranscript = () => [] as readonly TranscriptMessage[];

test("a finished subagent counts as run after a restart, when its transcript is not loaded yet", () => {
  // What a child record keeps across restarts: evidence read from its own replies and commands.
  expect(
    childHasRun([{ source: "orchestrator-accepted" }, { source: "command" }], noTranscript),
  ).toBe(true);
  expect(childHasRun([{ source: "worker-reported" }], noTranscript)).toBe(true);
});

test("a subagent that never ran stays queued, so it cannot wake its parent early", () => {
  // A fresh child has only the parent's acceptance and observations, and an empty transcript.
  expect(
    childHasRun(
      [{ source: "orchestrator-accepted" }, { source: "orchestrator-observed" }],
      noTranscript,
    ),
  ).toBe(false);
  expect(childHasRun([], noTranscript)).toBe(false);
});

test("a loaded transcript with the child's own reply also counts as run", () => {
  const reply = {
    kind: "message",
    role: "assistant",
    id: "a1",
    text: "ok",
    createdAt: "",
  } as unknown as TranscriptMessage;
  const prompt = {
    kind: "message",
    role: "user",
    id: "u1",
    text: "go",
    createdAt: "",
  } as unknown as TranscriptMessage;
  expect(childHasRun([], () => [prompt, reply])).toBe(true);
  expect(childHasRun([], () => [prompt])).toBe(false);
});

test("an idle child whose runs all failed before replying reads failed, not queued", () => {
  const noTranscript = () => [];
  const runFailed = { source: "blocker" as const, status: "failed" as const };
  expect(idleChildStatus([runFailed], noTranscript)).toBe("failed");
  // The marker saved when it last read failed survives a restart that forgets the failed status.
  expect(idleChildStatus([{ source: "blocker", status: "blocked" }], noTranscript)).toBe("failed");
  expect(
    idleChildStatus([{ source: "orchestrator-observed", status: "failed" }], noTranscript),
  ).toBe("queued");
  expect(idleChildStatus([], noTranscript)).toBe("queued");
  // A child that replied after a failure is complete.
  expect(
    idleChildStatus([runFailed, { source: "worker-reported", status: "reported" }], noTranscript),
  ).toBe("complete");
});

test("a child that never started a run stops counting as working once it has stalled", () => {
  const created = "2026-11-13T10:00:00.000Z";
  const start = Date.parse(created);
  expect(idleChildStatus([], noTranscript, created, start + 60_000)).toBe("queued");
  expect(idleChildStatus([], noTranscript, created, start + CHILD_START_STALL_MS + 1)).toBe(
    "failed",
  );
  // A child that ran is complete however old it is, and an unknown age keeps it queued.
  expect(
    idleChildStatus(
      [{ source: "worker-reported", status: "reported" }],
      noTranscript,
      created,
      start + 86_400_000,
    ),
  ).toBe("complete");
  expect(idleChildStatus([], noTranscript, undefined, start + 86_400_000)).toBe("queued");
});
