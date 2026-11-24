// node --test --experimental-strip-types src/api/connection.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { gateStatus, RECONNECT_GRACE_MS, type StreamStatus } from "./stream-status.ts";

/** Fake timers: `advance` runs what is due. */
function clock() {
  let now = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  return {
    timers: {
      set: (run: () => void, ms: number) => {
        due.set(next, { at: now + ms, run });
        return next++;
      },
      clear: (handle: unknown) => void due.delete(handle as number),
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...due]) {
        if (t.at <= now) {
          due.delete(id);
          t.run();
        }
      }
    },
  };
}

const retrying: StreamStatus = {
  state: "retrying",
  inMs: 250,
  reason: "Lost the connection to PC.",
};

test("bug 1: a reconnect that is live again within the grace time shows nothing", () => {
  const c = clock();
  const shown: StreamStatus[] = [];
  const gate = gateStatus((s) => shown.push(s), c.timers);
  gate.push({ state: "connecting" });
  gate.push({ state: "live" });
  // What the phone did every ~27 s: the stream recycled, connecting, live again 10 ms later.
  for (let i = 0; i < 5; i += 1) {
    gate.push({ state: "connecting" });
    c.advance(10);
    gate.push({ state: "live", resumed: true });
    c.advance(27_000);
  }
  // A drop with one quick retry, back within 2 s.
  gate.push(retrying);
  c.advance(250);
  gate.push({ state: "connecting" });
  c.advance(1_500);
  gate.push({ state: "live" });
  c.advance(10_000);
  assert.deepEqual(
    shown.map((s) => s.state),
    ["connecting", "live", "live", "live", "live", "live", "live", "live"],
  );
});

test("a sustained failure shows its latest status after the grace time", () => {
  const c = clock();
  const shown: StreamStatus[] = [];
  const gate = gateStatus((s) => shown.push(s), c.timers);
  gate.push({ state: "live" });
  gate.push(retrying);
  c.advance(250);
  gate.push({ state: "connecting" });
  c.advance(100);
  const later: StreamStatus = { state: "retrying", inMs: 1_000, reason: "Cannot reach PC." };
  gate.push(later);
  c.advance(RECONNECT_GRACE_MS);
  assert.deepEqual(shown.at(-1), later);
  // Once shown, further statuses pass at once until the stream is live again.
  gate.push({ state: "connecting" });
  assert.deepEqual(shown.at(-1), { state: "connecting" });
  gate.push({ state: "live" });
  assert.deepEqual(shown.at(-1), { state: "live" });
});

test("before the first live stream and for a revoked key, statuses pass at once", () => {
  const c = clock();
  const shown: StreamStatus[] = [];
  const gate = gateStatus((s) => shown.push(s), c.timers);
  gate.push(retrying);
  assert.deepEqual(shown, [retrying]);
  gate.push({ state: "live" });
  const revoked: StreamStatus = { state: "revoked", reason: "Pair it again." };
  gate.push(revoked);
  assert.deepEqual(shown.at(-1), revoked);
  gate.stop();
});
