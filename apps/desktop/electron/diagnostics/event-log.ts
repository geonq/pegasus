import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { appendFile, rename } from "node:fs/promises";
import path from "node:path";

/**
 * The app's event log: one JSON object per line in `<userData>/logs/events.ndjson`, the same shape
 * the Rust host writes to `host-events.ndjson`, so `pegasus-events` merges both into one timeline.
 *
 *   {"t":1762941234567,"n":42,"p":1234,"src":"main","k":"run.failed","l":"e","s":"<session>","r":"<run>",...}
 *
 * t = epoch ms, n = line number of this process (a gap means lost lines), p = pid, src = who saw it,
 * k = dotted kind, l = level ("e" error, "w" warning, absent = info), s/r = session and run ids.
 *
 * Cheap by construction: no per-token lines (deltas are counted and reported once per run), lines
 * are batched and appended at most every 250 ms off the main thread, and the file rotates once at
 * 8 MB. No prompt, reply or tool output text is written, only ids, names, sizes, timings and errors.
 *
 * `trace` lines (every IPC call) only go to a ring of the last 300; they are written out when an
 * error is logged, so each error arrives with the actions that led up to it.
 */
export type EventLevel = "e" | "w";
export type EventFields = { readonly l?: EventLevel; readonly s?: string; readonly r?: string } & {
  readonly [key: string]: unknown;
};

const MAX_BYTES = 8 << 20;
const FLUSH_MS = 250;
const FLUSH_BYTES = 64 << 10;
const RING = 300;
const MAX_FIELD_CHARS = 2_000;

let file: string | undefined;
let fileBytes = 0;
let pending: string[] = [];
let pendingBytes = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<void> = Promise.resolve();
let seq = 0;
const ring: string[] = [];

/** Starts writing to `<dir>/events.ndjson`. Lines logged before this are kept and written then. */
export function initEventLog(dir: string): void {
  mkdirSync(dir, { recursive: true });
  file = path.join(dir, "events.ndjson");
  try {
    fileBytes = statSync(file).size;
  } catch {
    fileBytes = 0;
  }
  schedule();
}

export function logEvent(kind: string, fields: EventFields = {}, src = "main"): void {
  if (fields.l === "e" && ring.length > 0) {
    // The actions before an error, in order, marked as context.
    for (const line of ring.splice(0)) push(line);
  }
  push(line(kind, fields, src));
}

/** Kept in memory only; written out ahead of the next error. */
export function traceEvent(kind: string, fields: EventFields = {}, src = "main"): void {
  // No line number: most trace lines are never written, and a gap in `n` must mean real loss.
  ring.push(line(kind, { ...fields, ctx: 1 }, src, false));
  if (ring.length > RING) ring.shift();
}

/** An error as log fields: its message and the top of its stack. */
export function errorFields(error: unknown): { readonly msg: string; readonly stack?: string } {
  if (error instanceof Error) {
    return {
      msg: clip(error.message),
      ...(error.stack ? { stack: clip(error.stack.split("\n").slice(0, 8).join("\n")) } : {}),
    };
  }
  return { msg: clip(String(error)) };
}

/** Writes everything still buffered, synchronously. For quit and crash paths. */
export function flushEventLogSync(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!file || pending.length === 0) return;
  const text = pending.join("");
  pending = [];
  pendingBytes = 0;
  try {
    rotateSyncIfFull(text.length);
    appendFileSync(file, text);
    fileBytes += Buffer.byteLength(text);
  } catch {
    // Logging must never take the app down with it.
  }
}

/** Waits for buffered lines to reach the file (tests, orderly quit). */
export async function flushEventLog(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  writeBuffered();
  await writing;
}

function line(kind: string, fields: EventFields, src: string, numbered = true): string {
  const n = numbered ? { n: ++seq } : {};
  return `${JSON.stringify({ t: Date.now(), ...n, p: process.pid, src, k: kind, ...clipFields(fields) })}\n`;
}

function push(text: string): void {
  pending.push(text);
  pendingBytes += text.length;
  if (pendingBytes >= FLUSH_BYTES) flushSoon(0);
  else schedule();
}

function schedule(): void {
  if (!timer && pending.length > 0) flushSoon(FLUSH_MS);
}

function flushSoon(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    writeBuffered();
  }, delay);
  timer.unref?.();
}

/** Moves the buffer onto the serial write chain (appends never interleave or reorder). */
function writeBuffered(): void {
  if (!file || pending.length === 0) return;
  const text = pending.join("");
  const target = file;
  pending = [];
  pendingBytes = 0;
  writing = writing
    .then(async () => {
      if (fileBytes + text.length > MAX_BYTES) {
        await rename(target, `${target}.1`).catch(() => undefined);
        fileBytes = 0;
      }
      await appendFile(target, text);
      fileBytes += Buffer.byteLength(text);
    })
    .catch(() => undefined);
}

function rotateSyncIfFull(adding: number): void {
  if (!file || fileBytes + adding <= MAX_BYTES) return;
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // Another process holds it; keep appending.
  }
  fileBytes = 0;
}

function clip(text: string): string {
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text;
}

function clipFields(fields: EventFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = typeof value === "string" ? clip(value) : value;
  }
  return out;
}
