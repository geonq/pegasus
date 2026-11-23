import {
  applyTranscriptDelta,
  type DesktopAppState,
  type RemoteEvent,
  type SelectedTranscript,
} from "./types.ts";

/**
 * The phone's copy of the PC: the last state and the open chat's transcript, kept current from the
 * event stream (apps/mobile/src/api/client.ts) and from what calls return.
 *
 * Revisions only order snapshots within one PC run: the desktop restarts them at 1 when Pegasus
 * restarts (apps/desktop/electron/application/app-store.ts `publishRevision`). So the first state of
 * every new stream, and a state pulled with getState, is a baseline and always taken; only later
 * snapshots are compared, which is what drops one that arrives late.
 */
export interface LiveState {
  readonly state: DesktopAppState | null;
  readonly transcript: SelectedTranscript | null;
  /** The last transcript delta applied; the next must be this + 1. */
  readonly sequence: number;
  /** The next state is a baseline: a stream just opened. */
  readonly fresh: boolean;
}

export const initialLiveState: LiveState = {
  state: null,
  transcript: null,
  sequence: 0,
  fresh: true,
};

export type LiveInput =
  /** A new event stream answered `ready`; the host sends the current state and transcript next. */
  | { readonly kind: "streamOpened" }
  | { readonly kind: "event"; readonly event: RemoteEvent }
  /** getState answered: a baseline. */
  | { readonly kind: "pulledState"; readonly state: DesktopAppState }
  /** A call (pin, archive, start) returned the state after it: kept when it is not older. */
  | { readonly kind: "actionState"; readonly state: DesktopAppState }
  | { readonly kind: "pulledTranscript"; readonly transcript: SelectedTranscript | null };

export interface LiveResult {
  readonly live: LiveState;
  /** A transcript delta did not fit: fetch getSelectedTranscript and feed it back. */
  readonly pullTranscript: boolean;
}

function newer(current: DesktopAppState | null, next: DesktopAppState): boolean {
  return !current || next.revision >= current.revision;
}

export function reduceLive(live: LiveState, input: LiveInput): LiveResult {
  const done = (next: LiveState, pullTranscript = false): LiveResult => ({
    live: next,
    pullTranscript,
  });
  switch (input.kind) {
    case "streamOpened":
      return done({ ...live, fresh: true, sequence: 0 });
    case "pulledState":
      return done({ ...live, state: input.state, fresh: false });
    case "actionState":
      return done(newer(live.state, input.state) ? { ...live, state: input.state } : live);
    case "pulledTranscript":
      return done({ ...live, transcript: input.transcript });
    case "event":
      break;
  }
  const event = input.event;
  switch (event.type) {
    case "stateChanged":
      return done(
        live.fresh || newer(live.state, event.state)
          ? { ...live, state: event.state, fresh: false }
          : live,
      );
    case "selectedTranscriptChanged":
      return done({ ...live, transcript: event.transcript, sequence: 0 });
    case "sessionTranscriptDelta": {
      const delta = event.delta;
      const next =
        delta.sequence === live.sequence + 1 && live.transcript
          ? applyTranscriptDelta(live.transcript, delta)
          : null;
      // A gap, another chat or no base: keep what is shown, fetch the whole transcript, and count
      // from this delta so the ones after it apply on top of the fetched one.
      if (!next) return done({ ...live, sequence: delta.sequence }, true);
      return done({ ...live, transcript: next, sequence: delta.sequence });
    }
    default:
      return done(live);
  }
}
