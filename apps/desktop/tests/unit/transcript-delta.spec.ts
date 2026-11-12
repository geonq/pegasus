import { expect, test } from "@playwright/test";
import type { SelectedTranscriptRecord } from "../../contracts/desktop-state";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import {
  applyTranscriptDelta,
  transcriptChange,
  transcriptDelta,
} from "../../electron/remote/remote-state-delta";

const message = (id: string, text: string): TranscriptMessage =>
  ({ kind: "message", id, role: "assistant", text, createdAt: "2026-11-12T00:00:00.000Z" }) as never;
const record = (...items: TranscriptMessage[]): SelectedTranscriptRecord => ({
  workspaceId: "w",
  sessionId: "s",
  transcript: items,
});

/** Applying the delta from A to B must give exactly B, so the renderer shows what main has. */
function roundTrip(before: SelectedTranscriptRecord, after: SelectedTranscriptRecord) {
  const delta = transcriptDelta(before, after, 1);
  return delta ? applyTranscriptDelta(before, delta) : before;
}

test("a streamed token becomes one update patch and rebuilds the same transcript", () => {
  const before = record(message("a", "hi"), message("b", "Hel"));
  const after = record(message("a", "hi"), message("b", "Hello"));
  const delta = transcriptDelta(before, after, 1)!;
  expect(delta.patches).toEqual([{ type: "update", id: "b", item: message("b", "Hello") }]);
  expect(roundTrip(before, after)).toEqual(after);
});

test("appends, removals and an unchanged transcript round-trip exactly", () => {
  const before = record(message("a", "1"), message("b", "2"));
  expect(roundTrip(before, record(message("a", "1"), message("b", "2"), message("c", "3")))).toEqual(
    record(message("a", "1"), message("b", "2"), message("c", "3")),
  );
  expect(roundTrip(before, record(message("b", "2")))).toEqual(record(message("b", "2")));
  expect(transcriptDelta(before, record(message("a", "1"), message("b", "2")), 1)).toBeNull();
});

test("a row inserted mid-transcript or a reorder is sent as the full record", () => {
  const before = record(message("a", "1"), message("c", "3"));
  expect(
    transcriptChange(before, record(message("a", "1"), message("b", "2"), message("c", "3")), 1),
  ).toBe("full");
  expect(transcriptChange(before, record(message("c", "3"), message("a", "1")), 1)).toBe("full");
});

test("a delta never stands alone and keeps the record's other fields", () => {
  const delta = transcriptDelta(record(message("a", "1")), record(message("a", "1"), message("b", "2")), 1)!;
  expect(applyTranscriptDelta(null, delta)).toBeNull();
  const withSchema = { ...record(message("a", "1")), schemaInfo: { version: 3 } } as never;
  expect(applyTranscriptDelta(withSchema, delta)).toMatchObject({ schemaInfo: { version: 3 } });
});

test("a run of streamed edits round-trips at every step", () => {
  let shown = record(message("u", "question"));
  let main = shown;
  for (let step = 1; step <= 40; step += 1) {
    const reply = message("r", "x".repeat(step));
    const next = step % 10 === 0 ? record(...main.transcript, message(`t${step}`, "tool")) : record(...main.transcript.filter((item) => item.id !== "r"), reply);
    const change = transcriptChange(main, next, step);
    if (change === "full") shown = next;
    else if (change !== "none") shown = applyTranscriptDelta(shown, change)!;
    main = next;
    expect(shown).toEqual(main);
  }
});

test("another session never produces a delta", () => {
  expect(
    transcriptDelta(record(message("a", "1")), { ...record(message("a", "1")), sessionId: "t" }, 1),
  ).toBeNull();
});
