import http, { type ClientRequest, type IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createBrotliDecompress } from "node:zlib";
import type { RemoteDesktopClientFileConfig } from "./remote-desktop-config";
import { assertRemoteJsonSize } from "./remote-desktop-policy";
import {
  isRemoteDesktopEvent,
  isRemoteDesktopMethod,
  type RemoteDesktopEvent,
} from "./remote-desktop-protocol";

// Room for a message with images up to the composer's 30 MB total, as base64 JSON.
const MAX_REQUEST_BYTES = 48 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 65_000;
const RECONNECT_DELAY_MS = 2_000;

export class RemoteDesktopHttpClient {
  private readonly listeners = new Set<(event: RemoteDesktopEvent) => void>();
  private readonly readyListeners = new Set<() => void>();
  private eventRequest: ClientRequest | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private connecting = false;

  constructor(private readonly config: RemoteDesktopClientFileConfig) {}

  subscribe(listener: (event: RemoteDesktopEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs each time the event stream (re)connects, for example after the Windows host restarted. */
  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  async invoke(method: unknown, args: unknown): Promise<unknown> {
    if (!isRemoteDesktopMethod(method) || !Array.isArray(args)) {
      throw new TypeError("Remote desktop method is not available.");
    }
    const body = { method, args };
    assertRemoteJsonSize(body, MAX_REQUEST_BYTES, "Remote desktop request");
    const response = await this.request("POST", "/v1/invoke", JSON.stringify(body));
    if (!isRecord(response) || response.version !== 1 || !("result" in response)) {
      throw new Error("The Windows desktop returned an invalid response.");
    }
    return response.result;
  }

  startEvents(): void {
    if (this.closed || this.connecting || this.eventRequest) return;
    this.connecting = true;
    const request = http.request(this.eventOptions(), (response) => {
      this.connecting = false;
      if (
        response.statusCode !== 200 ||
        !response.headers["content-type"]?.startsWith("text/event-stream")
      ) {
        response.resume();
        this.scheduleReconnect();
        return;
      }
      this.eventRequest = request;
      const body = decodedBody(response);
      const text = new StringDecoder("utf8");
      let buffer = "";
      let eventName = "";
      const data: string[] = [];
      const processLine = (line: string) => {
        if (!line) {
          if (eventName && data.length) this.receiveEvent(eventName, data.join("\n"));
          eventName = "";
          data.length = 0;
          return;
        }
        if (line.startsWith(":")) return;
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
        if (field === "event") eventName = value;
        else if (field === "data") data.push(value);
      };
      body.on("data", (chunk: Buffer | string) => {
        if (this.closed) return;
        // A character split across two chunks stays whole: the decoder holds its first bytes.
        buffer += Buffer.isBuffer(chunk) ? text.write(chunk) : chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
          request.destroy();
          return;
        }
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          processLine(buffer.slice(0, newline).replace(/\r$/u, ""));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      });
      body.once("end", () => this.scheduleReconnect());
      body.once("error", () => {
        request.destroy();
        this.scheduleReconnect();
      });
    });
    this.eventRequest = request;
    request.on("error", () => this.scheduleReconnect());
    request.once("close", () => {
      if (!this.closed && this.eventRequest === request) this.scheduleReconnect();
    });
    request.end();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.eventRequest?.destroy();
    this.eventRequest = undefined;
    this.listeners.clear();
    this.readyListeners.clear();
  }

  private request(method: "GET" | "POST", pathname: string, body?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      const request = http.request(
        {
          ...this.baseOptions(pathname),
          method,
          headers: {
            ...this.authHeaders(),
            "Accept-Encoding": "br",
            ...(body === undefined
              ? { Accept: "application/json" }
              : {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                  "Content-Length": String(Buffer.byteLength(body, "utf8")),
                }),
          },
        },
        (response) => this.readJsonResponse(response, (value) => finish(undefined, value), finish),
      );
      timeout = setTimeout(
        () => request.destroy(new Error("The Windows backend timed out.")),
        REQUEST_TIMEOUT_MS,
      );
      request.on("error", (error) => finish(error));
      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  private readJsonResponse(
    response: IncomingMessage,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
  ): void {
    const chunks: Buffer[] = [];
    let size = 0;
    const body = decodedBody(response);
    body.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      // Counted after decompression, so a small compressed reply cannot unpack past the limit.
      if (size > MAX_RESPONSE_BYTES) {
        body.destroy(new Error("The Windows response exceeds its size limit."));
        response.destroy();
      } else {
        chunks.push(bytes);
      }
    });
    body.once("end", () => {
      const raw = Buffer.concat(chunks, size).toString("utf8");
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        reject(new Error("The Windows backend returned invalid JSON."));
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(responseError(value)));
        return;
      }
      resolve(value);
    });
    body.once("error", reject);
    if (body !== response) response.once("error", reject);
  }

  private eventOptions() {
    return {
      ...this.baseOptions("/v1/events"),
      method: "GET" as const,
      headers: { ...this.authHeaders(), Accept: "text/event-stream", "Accept-Encoding": "br" },
    };
  }

  private baseOptions(pathname: string) {
    return {
      hostname: "127.0.0.1",
      port: new URL(this.config.baseUrl).port,
      path: pathname,
      agent: false as const,
    };
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Origin: this.config.origin,
    };
  }

  private receiveEvent(name: string, raw: string): void {
    if (name === "ready") {
      for (const listener of this.readyListeners) {
        try {
          listener();
        } catch {
          // A failing listener must not break the event stream.
        }
      }
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRemoteDesktopEvent(value) || value.type !== name) return;
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch {
        // Event consumers are isolated from transport reconnection.
      }
    }
  }

  private scheduleReconnect(): void {
    this.eventRequest = undefined;
    this.connecting = false;
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.startEvents();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }
}

/** The response body as sent, decompressed when the host answered with Brotli. */
function decodedBody(response: IncomingMessage): Readable {
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
  if (!encoding || encoding === "identity") return response;
  if (encoding !== "br") {
    response.destroy(new Error("The Windows backend used an unsupported encoding."));
    return response;
  }
  const decoder = createBrotliDecompress();
  response.on("error", (error) => decoder.destroy(error));
  return response.pipe(decoder);
}

function responseError(value: unknown): string {
  if (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.message === "string" &&
    value.error.message.length <= 512
  ) {
    return value.error.message;
  }
  return "The Windows backend rejected the request.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
