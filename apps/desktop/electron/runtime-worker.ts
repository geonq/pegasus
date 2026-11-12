//! Runtime worker entry point. It is deliberately a plain Node process: Electron main only
//! forwards typed frames and never imports the agent runtime on its UI lifecycle.
import { stdin, stdout } from "node:process";

const VERSION = 1;
let buffer = Buffer.alloc(0);

function write(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  stdout.write(frame);
}

function dispatch(body: Buffer): void {
  let message: unknown;
  try {
    message = JSON.parse(body.toString("utf8")) as unknown;
  } catch (error) {
    console.error(`[runtime-worker] invalid frame: ${String(error)}`);
    return;
  }
  if (typeof message !== "object" || message === null) return;
  const type = "type" in message && typeof message.type === "string" ? message.type : "";
  if (type === "hello") {
    write({ v: VERSION, type: "ready", pid: process.pid });
  } else if (type === "ping") {
    write({ v: VERSION, type: "pong" });
  } else if (type === "shutdown") {
    process.exit(0);
  } else {
    console.error(`[runtime-worker] unknown message type: ${type || "<missing>"}`);
  }
}

stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (length > 32 * 1024 * 1024) {
      console.error(`[runtime-worker] frame too large: ${length}`);
      process.exit(1);
    }
    if (buffer.length < 4 + length) return;
    dispatch(buffer.subarray(4, 4 + length));
    buffer = buffer.subarray(4 + length);
  }
});

console.error(`[runtime-worker] started pid=${process.pid}`);
