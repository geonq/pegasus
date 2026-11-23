// node --test --experimental-strip-types src/api/live-state.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialLiveState, reduceLive, type LiveState } from "./live-state.ts";
import { SseParser } from "./sse.ts";
import type { DesktopAppState, RemoteEvent, SessionRecord } from "./types.ts";

const session = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  title: id,
  updatedAt: "2026-11-20T10:00:00.000Z",
  preview: "",
  status: "idle",
  hasUnseenUpdate: false,
  ...extra,
});

const state = (revision: number, sessions: readonly SessionRecord[]): DesktopAppState => ({
  revision,
  workspaces: [{ id: "w", name: "pegasus", path: "D:/Pi/pi-gui", kind: "primary", sessions }],
  selectedWorkspaceId: "w",
  selectedSessionId: "",
});

/** The bytes crates/pegasus-host/src/remote.rs writes: `ready`, then `event: <type>` frames. */
function stream(events: readonly RemoteEvent[]): string {
  return (
    'id: 0\nevent: ready\ndata: {"version":1}\n\n' +
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") +
    ": keep-alive\n\n"
  );
}

/** What PegasusProvider does with a stream: `ready` opens it, each frame is an event. */
function play(live: LiveState, wire: string): LiveState {
  for (const message of new SseParser().push(wire)) {
    live =
      message.event === "ready"
        ? reduceLive(live, { kind: "streamOpened" }).live
        : reduceLive(live, { kind: "event", event: JSON.parse(message.data) as RemoteEvent }).live;
  }
  return live;
}

const ids = (live: LiveState) => live.state?.workspaces[0]?.sessions.map((s) => s.id);

test("bug B: chats made on the PC after Pegasus restarted show up (revisions start over)", () => {
  // Pegasus ran a long time: the phone holds revision 4210.
  let live = play(
    initialLiveState,
    stream([{ type: "stateChanged", state: state(4210, [session("old")]) }]),
  );
  assert.deepEqual(ids(live), ["old"]);
  // Pegasus restarts (app-store.ts publishRevision starts at 1); the phone reconnects and the PC
  // has a new chat. The old provider kept revision 4210 and dropped all of this.
  live = play(
    live,
    stream([
      { type: "stateChanged", state: state(3, [session("new"), session("old")]) },
      { type: "stateChanged", state: state(4, [session("newer"), session("new"), session("old")]) },
    ]),
  );
  assert.deepEqual(ids(live), ["newer", "new", "old"]);
});

test("within one stream a late, older snapshot does not undo a newer one", () => {
  let live = play(
    initialLiveState,
    stream([{ type: "stateChanged", state: state(10, [session("a")]) }]),
  );
  live = reduceLive(live, {
    kind: "event",
    event: { type: "stateChanged", state: state(12, [session("b")]) },
  }).live;
  live = reduceLive(live, {
    kind: "event",
    event: { type: "stateChanged", state: state(11, [session("c")]) },
  }).live;
  assert.deepEqual(ids(live), ["b"]);
  // Renames, archives and status changes are just newer snapshots.
  live = reduceLive(live, {
    kind: "event",
    event: {
      type: "stateChanged",
      state: state(13, [session("b", { title: "Renamed", status: "running" })]),
    },
  }).live;
  assert.equal(live.state?.workspaces[0]?.sessions[0]?.title, "Renamed");
  assert.equal(live.state?.workspaces[0]?.sessions[0]?.status, "running");
});

test("a pulled getState is a baseline; an action's state only when not older", () => {
  let live = play(
    initialLiveState,
    stream([{ type: "stateChanged", state: state(900, [session("a")]) }]),
  );
  live = reduceLive(live, { kind: "actionState", state: state(5, [session("stale")]) }).live;
  assert.deepEqual(ids(live), ["a"]);
  live = reduceLive(live, { kind: "pulledState", state: state(5, [session("pulled")]) }).live;
  assert.deepEqual(ids(live), ["pulled"]);
  live = reduceLive(live, {
    kind: "actionState",
    state: state(6, [session("pinned", { pinnedAt: "x" })]),
  }).live;
  assert.deepEqual(ids(live), ["pinned"]);
});

test("transcript deltas apply in order; a gap asks for the whole transcript", () => {
  const message = (id: string, text: string) => ({
    kind: "message" as const,
    id,
    role: "assistant" as const,
    text,
    createdAt: "2026-11-20T10:00:00.000Z",
  });
  let live = play(
    initialLiveState,
    stream([
      { type: "stateChanged", state: state(1, [session("a")]) },
      {
        type: "selectedTranscriptChanged",
        transcript: { workspaceId: "w", sessionId: "a", transcript: [message("m1", "Hi")] },
      },
      {
        type: "sessionTranscriptDelta",
        delta: {
          version: 1,
          sequence: 1,
          workspaceId: "w",
          sessionId: "a",
          patches: [{ type: "update", id: "m1", item: message("m1", "Hi there") }],
        },
      },
    ]),
  );
  assert.deepEqual(live.transcript?.transcript, [message("m1", "Hi there")]);
  const gap = reduceLive(live, {
    kind: "event",
    event: {
      type: "sessionTranscriptDelta",
      delta: {
        version: 1,
        sequence: 3,
        workspaceId: "w",
        sessionId: "a",
        patches: [{ type: "append", item: message("m2", "lost") }],
      },
    },
  });
  assert.equal(gap.pullTranscript, true);
  assert.deepEqual(gap.live.transcript?.transcript, [message("m1", "Hi there")]);
  assert.equal(gap.live.sequence, 3);
});
