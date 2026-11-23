import { SseParser } from "./sse";
import type { Pairing, RemoteEvent } from "./types";

/** A failure the person should see, with the host's error code when it sent one. */
export class PegasusError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PegasusError";
  }
}

const MAX_STREAM_CHARS = 32 * 1024 * 1024;
/**
 * The host writes a keep-alive comment after 15 s without events (crates/pegasus-host/src/remote.rs
 * HEARTBEAT). Silence well past that means the link died without an error (Wi-Fi to cellular, the
 * phone slept), so the stream is dropped and opened again.
 */
const SILENCE_LIMIT_MS = 40_000;

export interface EventStream {
  readonly stop: () => void;
  /** Drops the current stream and connects now, skipping any backoff (app came to the front). */
  readonly reconnect: () => void;
}

export type StreamStatus =
  | { readonly state: "connecting" }
  | { readonly state: "live" }
  | { readonly state: "retrying"; readonly inMs: number; readonly reason: string }
  /** The PC refused this phone's key: only pairing again helps, so retrying stops. */
  | { readonly state: "revoked"; readonly reason: string };

/**
 * The desktop's remote API (served by the Pegasus host on the PC):
 * POST /v1/invoke {method, args} and GET /v1/events (server-sent events).
 */
export class PegasusClient {
  constructor(private readonly pairing: Pairing) {}

  async invoke<T>(method: string, ...args: readonly unknown[]): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.pairing.url}/v1/invoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.pairing.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method, args }),
      });
    } catch {
      throw new PegasusError(
        `Cannot reach ${this.pairing.hostName}. Is Tailscale on, on both devices?`,
        "unreachable",
      );
    }
    const body = (await response.json().catch(() => null)) as {
      result?: T;
      error?: { code: string; message: string };
    } | null;
    if (!response.ok || !body || body.error) {
      throw new PegasusError(
        body?.error?.message ?? `Pegasus answered ${response.status}.`,
        body?.error?.code ?? "http_error",
        response.status,
      );
    }
    return body.result as T;
  }

  /**
   * Follows the event stream until `stop()` is called, reconnecting with backoff (1 s up to 30 s).
   * Each (re)connect starts with the current state and transcript (status "live" comes first), so
   * nothing needs replaying.
   */
  follow(
    onEvent: (event: RemoteEvent) => void,
    onStatus: (status: StreamStatus) => void,
  ): EventStream {
    let stopped = false;
    let xhr: XMLHttpRequest | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let recycle = false;
    let lastByteAt = Date.now();
    let restartNow = false;

    const watchdog = setInterval(() => {
      if (stopped || retryTimer || !xhr) return;
      if (Date.now() - lastByteAt > SILENCE_LIMIT_MS) {
        restartNow = false;
        xhr.abort();
      }
    }, 5_000);

    const connect = () => {
      retryTimer = undefined;
      if (stopped) return;
      lastByteAt = Date.now();
      onStatus({ state: "connecting" });
      const parser = new SseParser();
      let seen = 0;
      let broken = false;
      const request = new XMLHttpRequest();
      xhr = request;
      request.open("GET", `${this.pairing.url}/v1/events`);
      request.setRequestHeader("Authorization", `Bearer ${this.pairing.token}`);
      request.setRequestHeader("Accept", "text/event-stream");
      // Uncompressed: a streaming decoder may hold events back until more bytes arrive.
      request.setRequestHeader("Accept-Encoding", "identity");
      request.onprogress = () => {
        if (xhr !== request) return;
        lastByteAt = Date.now();
        const text = request.responseText;
        const chunk = text.slice(seen);
        seen = text.length;
        // responseText keeps the whole stream; start a fresh one (fresh state) before it grows large.
        if (seen > MAX_STREAM_CHARS) recycle = true;
        for (const message of parser.push(chunk)) {
          if (message.event === "ready") {
            attempt = 0;
            onStatus({ state: "live" });
            continue;
          }
          try {
            onEvent(JSON.parse(message.data) as RemoteEvent);
          } catch {
            // A frame that does not parse is a host bug; back off, then reconnect (fresh state).
            broken = true;
            request.abort();
            return;
          }
        }
        if (recycle) request.abort();
      };
      const retry = (reason: string) => {
        if (stopped) return;
        attempt += 1;
        const inMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
        onStatus({ state: "retrying", inMs, reason });
        retryTimer = setTimeout(connect, inMs);
      };
      if (recycle) recycle = false;
      request.onerror = () => {
        if (xhr === request) retry(`Cannot reach ${this.pairing.hostName}.`);
      };
      request.onabort = () => {
        if (stopped || xhr !== request) return;
        if (broken) retry("Pegasus sent an unreadable update.");
        else if (recycle || restartNow) connect();
        else retry(`Lost the connection to ${this.pairing.hostName}.`);
        restartNow = false;
      };
      request.onload = () => {
        if (stopped || xhr !== request) return;
        if (request.status === 401) {
          // Retrying a refused key cannot fix it and would hammer the PC; only pairing does.
          stopped = true;
          onStatus({ state: "revoked", reason: "This phone's key was revoked. Pair it again." });
          return;
        }
        retry("The connection closed.");
      };
      request.send();
    };

    connect();
    return {
      stop: () => {
        stopped = true;
        clearInterval(watchdog);
        if (retryTimer) clearTimeout(retryTimer);
        xhr?.abort();
      },
      reconnect: () => {
        if (stopped) return;
        attempt = 0;
        if (retryTimer) {
          clearTimeout(retryTimer);
          connect();
          return;
        }
        restartNow = true;
        xhr?.abort();
      },
    };
  }
}
