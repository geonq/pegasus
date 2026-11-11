// Regression: frames split across many socket chunks must reassemble in linear time and in order.
// A multi-megabyte frame used to be re-concatenated on every chunk, freezing the Electron main thread.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HostClient } from "../dist/index.js";

function frame(body) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function harness() {
  const client = Object.create(HostClient.prototype);
  const seen = [];
  client.socket = { destroy() {}, unref() {} };
  client.buffer = Buffer.alloc(0);
  client.bufferEnd = 0;
  client.listeners = new Set([(event) => seen.push(event)]);
  client.pending = new Map();
  client.log = () => {};
  client.fail = () => {};
  return { client, seen };
}

test("frames split at arbitrary byte boundaries reassemble in order", () => {
  const { client, seen } = harness();
  const events = [];
  for (let i = 0; i < 50; i += 1) {
    events.push({ event: "tick", n: i, payload: "x".repeat(i * 997) });
  }
  const wire = Buffer.concat(events.map((e) => frame(Buffer.from(JSON.stringify(e)))));
  for (let offset = 0; offset < wire.length; offset += 7) {
    client.onData(wire.subarray(offset, Math.min(offset + 7, wire.length)));
  }
  assert.deepEqual(seen, events);
});

test("a large frame delivered in 64 KiB chunks completes and is not quadratic", () => {
  const { client, seen } = harness();
  const big = { event: "snapshot", data: "y".repeat(8 * 1024 * 1024) };
  const wire = frame(Buffer.from(JSON.stringify(big)));
  const started = performance.now();
  for (let offset = 0; offset < wire.length; offset += 64 * 1024) {
    client.onData(wire.subarray(offset, Math.min(offset + 64 * 1024, wire.length)));
  }
  const elapsedMs = performance.now() - started;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data.length, big.data.length);
  // Quadratic reassembly of 8 MiB in 64 KiB chunks copied ~1 GiB; linear copying finishes in well under a second.
  assert.ok(elapsedMs < 1000, `reassembly took ${elapsedMs.toFixed(0)} ms`);
});
