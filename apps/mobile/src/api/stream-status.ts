/**
 * What the event stream reports. `live.resumed`: the stream picked up after the client's last event
 * (Last-Event-ID), so no new baseline state follows and the phone keeps what it has.
 */
export type StreamStatus =
  | { readonly state: "connecting" }
  | { readonly state: "live"; readonly resumed?: boolean }
  | { readonly state: "retrying"; readonly inMs: number; readonly reason: string }
  /** The PC refused this phone's key: only pairing again helps, so retrying stops. */
  | { readonly state: "revoked"; readonly reason: string };

/** A reconnect that is live again within this long is never shown. */
export const RECONNECT_GRACE_MS = 3_000;

interface Timers {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Holds back "connecting" and "retrying" after the stream was live, for RECONNECT_GRACE_MS: a
 * reconnect that succeeds in that time shows nothing; a sustained failure shows its latest status.
 * Before the first live stream, and for a revoked key, statuses pass at once.
 */
export function gateStatus(
  emit: (status: StreamStatus) => void,
  timers: Timers = realTimers,
): { readonly push: (status: StreamStatus) => void; readonly stop: () => void } {
  let shownLive = false;
  let held: StreamStatus | undefined;
  let timer: unknown;
  const cancel = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
    held = undefined;
  };
  return {
    push: (status) => {
      if (status.state === "live" || status.state === "revoked") {
        cancel();
        shownLive = status.state === "live";
        emit(status);
        return;
      }
      if (!shownLive) {
        emit(status);
        return;
      }
      held = status;
      timer ??= timers.set(() => {
        timer = undefined;
        shownLive = false;
        const latest = held;
        held = undefined;
        if (latest) emit(latest);
      }, RECONNECT_GRACE_MS);
    },
    stop: cancel,
  };
}
