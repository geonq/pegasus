import { expect, test } from "@playwright/test";
import type { PiDesktopApi } from "../../contracts/ipc";
import type { SelectedTranscriptRecord } from "../../contracts/desktop-state";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { forwardRemoteTranscript } from "../../electron/remote/remote-transcript-forwarder";
import { createRemoteDesktopClientApi } from "../../electron/remote/remote-desktop-client-preload";
import type { RemoteDesktopEvent } from "../../electron/remote/remote-desktop-protocol";
import {
  applyTranscriptDelta,
  transcriptDelta,
  type SessionTranscriptDelta,
} from "../../electron/remote/remote-state-delta";

const row = (text: string): TranscriptMessage => ({
  kind: "activity",
  id: "a",
  createdAt: "2026-11-13T00:00:00.000Z",
  label: text,
});
const record = (...transcript: TranscriptMessage[]): SelectedTranscriptRecord => ({
  workspaceId: "w",
  sessionId: "s",
  transcript,
});
function fixture() {
  let full: (value: SelectedTranscriptRecord | null) => void = () => undefined;
  let delta: (value: SessionTranscriptDelta) => void = () => undefined;
  let snapshot: SelectedTranscriptRecord | null = null;
  let pulls = 0;
  const api = {
    onSelectedTranscriptChanged: (listener: typeof full) => {
      full = listener;
      return () => {
        full = () => undefined;
      };
    },
    onSessionTranscriptDelta: (listener: typeof delta) => {
      delta = listener;
      return () => {
        delta = () => undefined;
      };
    },
    getSelectedTranscript: async () => {
      pulls++;
      return snapshot;
    },
  };
  const published: (SelectedTranscriptRecord | null)[] = [];
  const close = forwardRemoteTranscript(api, (value) => published.push(value));
  return {
    full: (value: SelectedTranscriptRecord | null) => full(value),
    delta: (value: SessionTranscriptDelta) => delta(value),
    snapshot: (value: SelectedTranscriptRecord | null) => {
      snapshot = value;
    },
    published,
    close,
    pulls: () => pulls,
  };
}

test("remote broker publishes every streamed iteration without a chat switch", () => {
  const f = fixture();
  let current = record();
  f.full(current);
  for (let sequence = 1; sequence <= 10; sequence++) {
    const next = record(row("x".repeat(sequence)));
    f.delta(transcriptDelta(current, next, sequence)!);
    expect(f.published.at(-1)).toEqual(next);
    current = next;
  }
  expect(f.pulls()).toBe(0);
  f.close();
});

test("a missing baseline or sequence gap pulls a snapshot and resumes", async () => {
  const f = fixture();
  const next = record(row("recovered"));
  f.snapshot(next);
  f.delta(transcriptDelta(record(), next, 8)!);
  await expect.poll(() => f.published.at(-1)).toEqual(next);
  const later = record(row("still streaming"));
  f.delta(transcriptDelta(next, later, 9)!);
  expect(f.published.at(-1)).toEqual(later);
  expect(f.pulls()).toBe(1);
  f.close();
});

test("an in-flight recovery cannot overwrite a newly selected chat", async () => {
  const f = fixture();
  f.snapshot(record(row("old")));
  f.delta(transcriptDelta(record(), record(row("old")), 8)!);
  const selected = { ...record(row("new chat")), sessionId: "new" };
  f.full(selected);
  await Promise.resolve();
  expect(f.published).toEqual([selected]);
  f.close();
});

test("Mac exposes remote deltas to the renderer, including gaps for snapshot recovery", () => {
  const listeners = new Set<(event: RemoteDesktopEvent) => void>();
  const api = createRemoteDesktopClientApi(
    {
      onSelectedTranscriptChanged: () => () => undefined,
      onSessionTranscriptDelta: () => () => undefined,
    } as unknown as PiDesktopApi,
    async () => null,
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async () => ({ themeMode: "dark", themePresetId: "default", enableTransparency: false }),
    async () => ({ themeMode: "dark", themePresetId: "default", enableTransparency: false }),
  );
  let shown: SelectedTranscriptRecord | null = null;
  const received: SessionTranscriptDelta[] = [];
  const offFull = api.onSelectedTranscriptChanged((value) => {
    shown = value;
  });
  const offDelta = api.onSessionTranscriptDelta((value) => {
    received.push(value);
    shown = applyTranscriptDelta(shown, value);
  });
  const emit = (event: RemoteDesktopEvent) => {
    for (const listener of listeners) listener(event);
  };
  emit({ type: "selectedTranscriptChanged", transcript: record() });
  const next = record(row("live reply"));
  const delta = transcriptDelta(record(), next, 1)!;
  emit({ type: "sessionTranscriptDelta", delta });
  expect(shown).toEqual(next);
  emit({ type: "sessionTranscriptDelta", delta: { ...delta, sequence: 7 } });
  expect(received.map((value) => value.sequence)).toEqual([1, 7]);
  offFull();
  offDelta();
  expect(listeners.size).toBe(0);
});
