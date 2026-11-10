import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { EXTENSION_PIN_CUSTOM_TYPE } from "@pi-gui/session-driver";

/**
 * Client for the Rust `pegasus-sidecar` (crates/pegasus-core): session index and context reads.
 * Wire format: u32 big-endian length + JSON `{v,id,method,params}` -> `{v,id,result|error}`.
 * The sidecar is an accelerator only. If it is missing, crashes, times out or refuses a file,
 * the caller gets pi's own SessionManager path (logged), so behaviour never depends on it.
 */

const PROTOCOL = 1;
const CALL_TIMEOUT_MS = 30_000;
const RESPAWN_COOLDOWN_MS = 30_000;

interface WireSession {
  readonly path: string;
  readonly id: string;
  readonly cwd: string;
  readonly name: string | null;
  readonly parentSessionPath: string | null;
  readonly createdMs: number | null;
  readonly modifiedMs: number;
  readonly messageCount: number;
  readonly firstMessage: string;
}

interface WireContext {
  readonly total: number;
  readonly entries: readonly SessionEntry[];
  readonly pins: readonly SessionEntry[];
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

class SidecarError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class SidecarClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private header = Buffer.alloc(4);
  private headerFill = 0;
  private body: Buffer | undefined;
  private bodyFill = 0;
  exited = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) =>
      console.warn(`[pegasus-sidecar] ${chunk.toString("utf8").trim()}`),
    );
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => this.fail(new Error(`sidecar exited (${code ?? signal})`)));
    // Never keep the app alive for the sidecar.
    child.unref();
  }

  call<T>(method: string, params: object): Promise<T> {
    if (this.exited) return Promise.reject(new Error("sidecar is not running"));
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ v: PROTOCOL, id, method, params }));
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar ${method} timed out`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: (value) => resolvePromise(value as T), reject, timer });
      this.child.stdin.write(frame, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  close(): void {
    this.exited = true;
    this.child.kill();
  }

  private onData(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const take = Math.min(4 - this.headerFill, chunk.length - offset);
        chunk.copy(this.header, this.headerFill, offset, offset + take);
        this.headerFill += take;
        offset += take;
        if (this.headerFill < 4) return;
        this.body = Buffer.allocUnsafe(this.header.readUInt32BE(0));
        this.bodyFill = 0;
        this.headerFill = 0;
      }
      const take = Math.min(this.body.length - this.bodyFill, chunk.length - offset);
      chunk.copy(this.body, this.bodyFill, offset, offset + take);
      this.bodyFill += take;
      offset += take;
      if (this.bodyFill === this.body.length) {
        const done = this.body;
        this.body = undefined;
        this.onFrame(done);
      }
    }
  }

  private onFrame(frame: Buffer): void {
    const message: unknown = JSON.parse(frame.toString("utf8"));
    if (typeof message !== "object" || message === null) return;
    const { id, result, error } = message as {
      id?: number;
      result?: unknown;
      error?: { code: string; message: string };
    };
    const pending = id === undefined ? undefined : this.pending.get(id);
    if (!pending || id === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(new SidecarError(error.code, error.message));
    else pending.resolve(result);
  }

  private fail(error: Error): void {
    this.exited = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function binaryName(): string {
  return process.platform === "win32" ? "pegasus-sidecar.exe" : "pegasus-sidecar";
}

/** Set by Electron only. */
function resourcesPath(): string | undefined {
  return "resourcesPath" in process && typeof process.resourcesPath === "string"
    ? process.resourcesPath
    : undefined;
}

function resolveBinary(): string | undefined {
  const candidates = [
    process.env.PEGASUS_SIDECAR_PATH,
    // Packaged app: electron-builder extraResources puts it next to app.asar.
    resourcesPath() === undefined ? undefined : join(resourcesPath() ?? "", "bin", binaryName()),
    // Dev checkout: packages/pi-sdk-driver/dist -> repo/crates/target/release.
    join(dirname(fileURLToPath(import.meta.url)), "../../../crates/target/release", binaryName()),
  ];
  return candidates.find((p): p is string => p !== undefined && p !== "" && existsSync(p));
}

let client: SidecarClient | undefined;
let lastFailureAt = 0;
let loggedMissing = false;

function sessionsRoot(): string {
  return join(getAgentDir(), "sessions");
}

function sidecar(): SidecarClient | undefined {
  if (process.env.PEGASUS_SIDECAR === "0") return undefined;
  if (client && !client.exited) return client;
  if (Date.now() - lastFailureAt < RESPAWN_COOLDOWN_MS) return undefined;
  const binary = resolveBinary();
  if (!binary) {
    if (!loggedMissing) {
      loggedMissing = true;
      console.warn(
        "[pegasus-sidecar] binary not found; using pi's SessionManager for session reads",
      );
    }
    return undefined;
  }
  const cache =
    process.env.PEGASUS_SIDECAR_CACHE ?? join(getAgentDir(), "pegasus-index-cache.json");
  const args = ["--sessions-root", sessionsRoot(), "--cache", cache];
  try {
    client = new SidecarClient(spawn(binary, args, { stdio: "pipe", windowsHide: true }));
    return client;
  } catch (error) {
    lastFailureAt = Date.now();
    console.warn("[pegasus-sidecar] spawn failed; falling back", error);
    return undefined;
  }
}

/** Run `viaSidecar`; on any sidecar failure log it and run `viaPi` (pi's own reader). */
async function withFallback<T>(
  what: string,
  viaSidecar: (c: SidecarClient) => Promise<T>,
  viaPi: () => Promise<T>,
): Promise<T> {
  const c = sidecar();
  if (!c) return viaPi();
  try {
    return await viaSidecar(c);
  } catch (error) {
    // A refused file (old schema) is routine; a dead process starts the respawn cooldown.
    if (!(error instanceof SidecarError)) lastFailureAt = Date.now();
    console.warn(`[pegasus-sidecar] ${what} failed, using SessionManager:`, error);
    return viaPi();
  }
}

/** pi's default session directory for a cwd (same encoding as SessionManager.list). */
function defaultSessionDir(cwd: string): string {
  const safe = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(getAgentDir(), "sessions", safe);
}

/** Drop-in for `SessionManager.list(cwd)`. `allMessagesText` is empty (only `firstMessage` is used). */
export function listSessionInfos(cwd: string): Promise<SessionInfo[]> {
  const dir = defaultSessionDir(cwd);
  return withFallback(
    "session list",
    async (c) => {
      if (!existsSync(dir)) return [];
      const { sessions } = await c.call<{ sessions: readonly WireSession[] }>("index.list", {
        dir,
      });
      return sessions.map((s) => ({
        path: s.path,
        id: s.id,
        cwd: s.cwd,
        ...(s.name === null ? {} : { name: s.name }),
        ...(s.parentSessionPath === null ? {} : { parentSessionPath: s.parentSessionPath }),
        created: new Date(s.createdMs ?? Number.NaN),
        modified: new Date(s.modifiedMs),
        messageCount: s.messageCount,
        firstMessage: s.firstMessage,
        allMessagesText: "",
      }));
    },
    () => SessionManager.list(cwd),
  );
}

type TranscriptSource = Pick<SessionManager, "buildContextEntries" | "getBranch">;

/**
 * What `transcriptFromSession` needs from a closed session: the rendered context entries and the
 * pins on the branch. Read natively when the sidecar can; otherwise pi opens (and parses) the file.
 */
export function openTranscriptSource(file: string): Promise<TranscriptSource> {
  return withFallback<TranscriptSource>(
    "transcript read",
    async (c) => {
      const ctx = await c.call<WireContext>("session.context", {
        path: file,
        pinType: EXTENSION_PIN_CUSTOM_TYPE,
      });
      return { buildContextEntries: () => [...ctx.entries], getBranch: () => [...ctx.pins] };
    },
    async () => SessionManager.open(file),
  );
}

/** Rows `start..start+count` of a session's rendered context, as pi wrote them. */
export async function sliceSessionRows(
  file: string,
  start: number,
  count: number,
): Promise<{ total: number; entries: readonly SessionEntry[] }> {
  const c = sidecar();
  if (!c) throw new Error("sidecar unavailable");
  return c.call("session.slice", { path: file, pinType: EXTENSION_PIN_CUSTOM_TYPE, start, count });
}

/** Stop the sidecar (tests, app quit). */
export function closeSidecar(): void {
  client?.close();
  client = undefined;
}
