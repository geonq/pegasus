import type { PiDesktopApi } from "../../contracts/ipc";
import type { SelectedTranscriptRecord } from "../../contracts/desktop-state";
import { applyTranscriptDelta } from "./remote-state-delta";

/** Rebuild main's incremental transcript before the broker encodes its own remote deltas. */
export function forwardRemoteTranscript(
  api: Pick<
    PiDesktopApi,
    "onSelectedTranscriptChanged" | "onSessionTranscriptDelta" | "getSelectedTranscript"
  >,
  publish: (record: SelectedTranscriptRecord | null) => void,
): () => void {
  let record: SelectedTranscriptRecord | null = null;
  let sequence = 0;
  let generation = 0;
  let active = true;
  const offFull = api.onSelectedTranscriptChanged((next) => {
    generation += 1;
    sequence = 0;
    record = next;
    publish(next);
  });
  const offDelta = api.onSessionTranscriptDelta((delta) => {
    const next = delta.sequence === sequence + 1 ? applyTranscriptDelta(record, delta) : null;
    sequence = delta.sequence;
    const attempt = ++generation;
    if (next) {
      record = next;
      publish(next);
    } else {
      // A missed baseline or delta must recover without making the user switch chats.
      void api
        .getSelectedTranscript()
        .then((snapshot) => {
          if (!active || attempt !== generation) return;
          record = snapshot;
          publish(snapshot);
        })
        .catch((error: unknown) => console.error("[remote-broker] transcript pull failed", error));
    }
  });
  return () => {
    active = false;
    offFull();
    offDelta();
  };
}
