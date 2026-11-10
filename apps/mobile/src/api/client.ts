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

export type StreamStatus =
  | { readonly state: "connecting" }
  | { readonly state: "live" }
  | { readonly state: "retrying"; readonly inMs: number; readonly reason: string };

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
   * Each (re)connect starts with the current state and transcript, so nothing needs replaying.
   */
  follow(
    onEvent: (event: RemoteEvent) => void,
    onStatus: (status: StreamStatus) => void,
  ): () => void {
    let stopped = false;
    let xhr: XMLHttpRequest | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let recycle = false;

    const connect = () => {
      if (stopped) return;
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
      request.onerror = () => retry(`Cannot reach ${this.pairing.hostName}.`);
      request.onabort = () => {
        if (stopped) return;
        if (broken) retry("Pegasus sent an unreadable update.");
        else connect();
      };
      request.onload = () =>
        retry(
          request.status === 401
            ? "This phone's key was revoked. Pair it again."
            : "The connection closed.",
        );
      request.send();
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      xhr?.abort();
    };
  }
}
