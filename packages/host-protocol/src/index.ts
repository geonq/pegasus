import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  HOST_PROTOCOL,
  type ErrorCode,
  type HelloResult,
  type HostEvent,
  type HostMethods,
} from "./generated.js";

export * from "./generated.js";

/**
 * Client for the Rust `pegasus-host` (crates/pegasus-host). Wire format: u32 big-endian length,
 * then JSON `{v,id,method,params}` -> `{v,id,result|error}`; events `{v,event,data}` arrive unasked.
 * Method names, params and results are typed by the generated `HostMethods` table, so a call that
 * does not match the Rust schema does not compile.
 */

const MAX_FRAME = 256 * 1024 * 1024;

export class HostCallError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly method: string,
  ) {
    super(`${method}: ${code}: ${message}`);
    this.name = "HostCallError";
  }
}

/** Transport failures (host gone, timeout). Distinct from a typed `HostCallError` the host returned. */
export class HostUnavailableError extends Error {
  override name = "HostUnavailableError";
}

/** FNV-1a 64-bit, hex. Same profile -> same endpoint across app versions. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** One endpoint per profile directory: a named pipe on Windows, a 0600 unix socket elsewhere. */
export function hostEndpoint(
  profileDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const key = resolve(profileDir);
  if (platform === "win32") return `\\\\.\\pipe\\pegasus-host-${fnv1a64(key.toLowerCase())}`;
  const inProfile = join(key, "pegasus-host.sock");
  // sun_path is 104 bytes on macOS; long profile paths fall back to a hashed name in tmp.
  return Buffer.byteLength(inProfile) < 100
    ? inProfile
    : join(tmpdir(), `pegasus-host-${fnv1a64(key)}.sock`);
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface HostLaunch {
  readonly binary: string;
  readonly args: readonly string[];
}

export interface AttachOptions {
  readonly endpoint: string;
  /** How to start a host when none is listening. Omit to only attach. */
  readonly launch?: HostLaunch;
  readonly client: string;
  readonly appVersion: string;
  /** Replace a host built for another app version (default true). Dev builds pass false. */
  readonly replaceMismatched?: boolean;
  readonly connectTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly log?: (message: string) => void;
}

export class HostClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private buffer: Buffer = Buffer.alloc(0);
  private closedError: Error | undefined;
  hello: HelloResult | undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly callTimeoutMs: number,
    private readonly log: (message: string) => void,
  ) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new HostUnavailableError("host connection closed")));
    // Never keep the process alive just for the host connection.
    socket.unref();
  }

  get closed(): boolean {
    return this.closedError !== undefined;
  }

  /**
   * Connect to the profile's host, starting it if needed. A host built for another app version is
   * asked to exit (refused while it has active work, then the old one keeps serving) and replaced.
   */
  static async attach(options: AttachOptions): Promise<HostClient> {
    const log = options.log ?? ((message) => console.warn(`[pegasus-host] ${message}`));
    const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    const callTimeoutMs = options.callTimeoutMs ?? 30_000;
    let client = await connectOrLaunch(options, connectTimeoutMs, callTimeoutMs, log);
    let hello = await client.call("hello", {
      client: options.client,
      appVersion: options.appVersion,
    });
    if (
      hello.hostVersion !== options.appVersion &&
      options.launch &&
      options.replaceMismatched !== false
    ) {
      const { accepted, activeWork } = await client.call("shutdown", {
        reason: `replaced by app ${options.appVersion}`,
        force: false,
      });
      if (accepted) {
        log(`replacing host ${hello.hostVersion} with ${options.appVersion}`);
        await client.waitClosed(5_000);
        client = await connectOrLaunch(options, connectTimeoutMs, callTimeoutMs, log);
        hello = await client.call("hello", {
          client: options.client,
          appVersion: options.appVersion,
        });
      } else {
        log(
          `host ${hello.hostVersion} kept: ${activeWork} active work item(s); replacing it later`,
        );
      }
    }
    if (hello.protocol !== HOST_PROTOCOL) {
      client.close();
      throw new HostUnavailableError(
        `host speaks protocol ${hello.protocol}, client ${HOST_PROTOCOL}`,
      );
    }
    client.hello = hello;
    return client;
  }

  call<M extends keyof HostMethods>(
    method: M,
    params: HostMethods[M]["params"],
  ): Promise<HostMethods[M]["result"]> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ v: HOST_PROTOCOL, id, method, params }));
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostUnavailableError(`${method} timed out after ${this.callTimeoutMs} ms`));
      }, this.callTimeoutMs);
      timer.unref();
      this.pending.set(id, {
        method,
        resolve: (value) => resolvePromise(value as HostMethods[M]["result"]),
        reject,
        timer,
      });
      // Keep the loop alive while a call is in flight, like any other pending I/O.
      this.socket.ref();
      this.socket.write(frame, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.fail(new HostUnavailableError("client closed"));
    this.socket.destroy();
  }

  private waitClosed(timeoutMs: number): Promise<void> {
    if (this.closedError) return Promise.resolve();
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        resolvePromise();
      }, timeoutMs);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME) {
        this.fail(new HostUnavailableError(`host sent a ${length}-byte frame`));
        this.socket.destroy();
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      this.onFrame(body);
    }
  }

  private onFrame(body: Buffer): void {
    let message: {
      id?: number;
      result?: unknown;
      error?: { code: ErrorCode; message: string };
      event?: string;
    };
    try {
      message = JSON.parse(body.toString("utf8")) as typeof message;
    } catch (error) {
      this.log(`unreadable frame from host: ${String(error)}`);
      return;
    }
    if (message.event !== undefined) {
      const event = message as unknown as HostEvent;
      for (const listener of this.listeners) listener(event);
      return;
    }
    const pending = message.id === undefined ? undefined : this.pending.get(message.id);
    if (!pending || message.id === undefined) {
      this.log(`response for unknown request ${String(message.id)}`);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (this.pending.size === 0) this.socket.unref();
    if (message.error) {
      pending.reject(new HostCallError(message.error.code, message.error.message, pending.method));
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(error: Error): void {
    this.closedError ??= error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(this.closedError);
      this.pending.delete(id);
    }
  }

  /** @internal */
  static fromSocket(socket: Socket, callTimeoutMs: number, log: (m: string) => void): HostClient {
    return new HostClient(socket, callTimeoutMs, log);
  }
}

function tryConnect(endpoint: string): Promise<Socket | undefined> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => resolvePromise(socket));
    socket.once("error", () => {
      socket.destroy();
      resolvePromise(undefined);
    });
  });
}

async function connectOrLaunch(
  options: AttachOptions,
  connectTimeoutMs: number,
  callTimeoutMs: number,
  log: (message: string) => void,
): Promise<HostClient> {
  let socket = await tryConnect(options.endpoint);
  if (!socket && options.launch) {
    const child = spawn(options.launch.binary, [...options.launch.args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    // Exit code 3 = another launcher's host won the race for the endpoint: keep connecting.
    let died: string | undefined;
    child.on("error", (error) => (died = `spawn failed: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (code !== 3) died = `exited at start-up (${code ?? signal})`;
    });
    child.unref();
    const deadline = Date.now() + connectTimeoutMs;
    while (!socket && died === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
      socket = await tryConnect(options.endpoint);
    }
    if (!socket && died !== undefined) {
      throw new HostUnavailableError(`host ${options.launch.binary} ${died}; see its log`);
    }
  }
  if (!socket) throw new HostUnavailableError(`no host on ${options.endpoint}`);
  return HostClient.fromSocket(socket, callTimeoutMs, log);
}
