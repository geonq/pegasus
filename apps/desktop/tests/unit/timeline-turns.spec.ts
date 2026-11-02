import { expect, test } from "@playwright/test";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { buildDisplayTimelineItems } from "../../src/features/conversation/timeline-turns";

const base = Date.parse("2026-09-24T12:00:00.000Z");
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();

function message(id: string, role: "user" | "assistant", seconds: number): TranscriptMessage {
  return { kind: "message", id, role, text: id, createdAt: at(seconds) };
}

function tool(id: string, seconds: number): TranscriptMessage {
  return {
    kind: "tool",
    id,
    callId: id,
    toolName: "bash",
    status: "success",
    label: id,
    createdAt: at(seconds),
  };
}

const ids = (transcript: readonly TranscriptMessage[], lastTurnRunning = false) =>
  buildDisplayTimelineItems(transcript, { lastTurnRunning }).map((item) => item.id);

test("the marker sits directly above the turn's final assistant reply", () => {
  const transcript = [
    message("u1", "user", 0),
    message("a1", "assistant", 2),
    tool("t1", 5),
    tool("t2", 9),
    message("a2", "assistant", 12),
    message("u2", "user", 20),
    tool("t3", 23),
    message("a3", "assistant", 30),
  ];
  expect(ids(transcript)).toEqual([
    "u1",
    "a1",
    "t1",
    "t2",
    "turn-marker:u1",
    "a2",
    "u2",
    "t3",
    "turn-marker:u2",
    "a3",
  ]);
  const markers = buildDisplayTimelineItems(transcript).filter(
    (item) => item.kind === "turn-marker",
  );
  expect(markers.map((marker) => marker.durationMs)).toEqual([12_000, 10_000]);
});

test("a turn without an assistant reply gets its marker at the end of the turn", () => {
  expect(ids([message("u1", "user", 0), tool("t1", 4), message("u2", "user", 10)])).toEqual([
    "u1",
    "t1",
    "turn-marker:u1",
    "u2",
  ]);
});

test("the running turn has no marker until it finishes", () => {
  const transcript = [
    message("u1", "user", 0),
    message("a1", "assistant", 5),
    message("u2", "user", 10),
    message("a2", "assistant", 15),
  ];
  expect(ids(transcript, true)).toEqual(["u1", "turn-marker:u1", "a1", "u2", "a2"]);
  expect(ids(transcript, false)).toEqual([
    "u1",
    "turn-marker:u1",
    "a1",
    "u2",
    "turn-marker:u2",
    "a2",
  ]);
});

test("turns shorter than a second get no marker", () => {
  expect(ids([message("u1", "user", 0), message("a1", "assistant", 0.5)])).toEqual(["u1", "a1"]);
});

test("an extension message or card posted after the run neither stretches the marker nor moves it", () => {
  const custom = (id: string, seconds: number): TranscriptMessage => ({
    kind: "custom",
    id,
    customType: "ci-status",
    text: id,
    createdAt: at(seconds),
  });
  const transcript = [
    message("u1", "user", 0),
    message("a1", "assistant", 2),
    custom("steered", 3),
    message("a2", "assistant", 6),
    custom("late-ci-report", 600),
    {
      kind: "card",
      id: "late-ci-card",
      createdAt: at(900),
      card: { title: "CI passed", tone: "success", rows: [], actions: [] },
    },
  ];
  expect(ids(transcript)).toEqual([
    "u1",
    "a1",
    "steered",
    "turn-marker:u1",
    "a2",
    "late-ci-report",
    "late-ci-card",
  ]);
  const marker = buildDisplayTimelineItems(transcript).find((item) => item.kind === "turn-marker");
  expect(marker?.durationMs).toBe(6_000);
});

test("a keyed card updated long after its turn does not stretch that turn's marker", () => {
  const transcript: TranscriptMessage[] = [
    message("u1", "user", 0),
    {
      kind: "card",
      id: "card:ci",
      // The card's latest write, an hour and a half after the turn ended.
      createdAt: at(5_400),
      card: { key: "ci", title: "CI passed", tone: "success", rows: [], actions: [] },
    },
    message("a1", "assistant", 60),
  ];
  const marker = buildDisplayTimelineItems(transcript).find((item) => item.kind === "turn-marker");
  expect(marker?.durationMs).toBe(60_000);
});

test("the live working pill renders after the latest row", () => {
  const transcript: TranscriptMessage[] = [
    message("u1", "user", 0),
    { kind: "activity", id: "working", label: "Thinking…", tone: "working", createdAt: at(1) },
    tool("t1", 3),
    tool("t2", 5),
  ];
  expect(ids(transcript, true)).toEqual(["u1", "t1", "t2", "working"]);
});

test("a finished turn shows its subagents still working", () => {
  const transcript = [message("u1", "user", 0), message("a1", "assistant", 4)];
  const items = buildDisplayTimelineItems(transcript, {
    subagentsWorking: ["Planner", "Implementer"],
  });
  const last = items.at(-1);
  expect(last).toMatchObject({ kind: "activity", label: "2 subagents working", tone: "working" });
  // Names are listed one per line under the pill, not joined into it.
  expect(last).toMatchObject({ entries: ["Planner", "Implementer"] });
  expect(last).not.toHaveProperty("detail");
  expect(buildDisplayTimelineItems(transcript, { subagentsWorking: [] }).at(-1)?.id).toBe("a1");
});

test("thinking reads Thought for Ns once the next row starts, and stays open while it streams", () => {
  const thinking = (id: string, seconds: number, durationMs?: number): TranscriptMessage => ({
    kind: "thinking",
    id,
    text: id,
    createdAt: at(seconds),
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
  const working: TranscriptMessage = {
    kind: "activity",
    id: "working",
    label: "Thinking…",
    tone: "working",
    createdAt: at(1),
  };
  const view = (transcript: readonly TranscriptMessage[], running: boolean) =>
    buildDisplayTimelineItems(transcript, { lastTurnRunning: running }).flatMap((item) =>
      item.kind === "thinking" ? [[item.id, item.durationMs, item.open === true]] : [],
    );
  const transcript = [
    message("u1", "user", 0),
    thinking("live", 2),
    tool("t1", 21),
    // Saved rows share their reply's timestamp, so only a duration from history counts.
    thinking("saved", 25, 8_000),
    thinking("same-time", 30),
    message("a1", "assistant", 30),
    thinking("streaming", 31),
    working,
  ];
  expect(view(transcript, true)).toEqual([
    ["live", 19_000, false],
    ["saved", 8_000, false],
    ["same-time", undefined, false],
    ["streaming", undefined, true],
  ]);
  expect(view(transcript, false).at(-1)).toEqual(["streaming", undefined, false]);
});

test("finished reads and searches in a row fold into one Explored row; others stay in sight", () => {
  const call = (
    id: string,
    toolName: string,
    input: unknown,
    status: "running" | "success" | "error" = "success",
  ): TranscriptMessage => ({
    kind: "tool",
    id,
    callId: id,
    toolName,
    status,
    label: id,
    input,
    createdAt: at(1),
  });
  const view = (transcript: readonly TranscriptMessage[]) =>
    buildDisplayTimelineItems(transcript, { lastTurnRunning: true }).map((item) =>
      item.kind === "tool-group" ? `${item.label} [${item.tools.map((t) => t.id)}]` : item.id,
    );
  expect(
    view([
      message("u1", "user", 0),
      call("r1", "project_read", { path: "a.ts" }),
      call("r2", "project_ls", { path: "src" }),
      call("g1", "grep", { pattern: "x" }),
      call("s1", "project_shell", { command: "ls" }),
      call("r3", "read", { path: "b.ts" }),
      call("img", "project_read", { path: "shot.png" }),
      call("r4", "read", { path: "c.ts" }),
      call("r5", "read", { path: "d.ts" }, "error"),
      call("r6", "read", { path: "e.ts" }),
      call("r7", "read", { path: "f.ts" }, "running"),
    ]),
  ).toEqual([
    "u1",
    "Explored 2 files, 1 search [r1,r2,g1]",
    "s1",
    "r3",
    "img",
    "r4",
    "r5",
    "r6",
    "r7",
  ]);
});
