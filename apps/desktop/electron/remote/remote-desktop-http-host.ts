import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline, type Writable } from "node:stream";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, createBrotliCompress } from "node:zlib";
import type { RemoteDesktopBroker } from "./remote-desktop-broker";
import {
  isRemoteDesktopEvent,
  isRemoteDesktopMethod,
  type RemoteDesktopEvent,
} from "./remote-desktop-protocol";
import { RemoteWorkspaceFolderError } from "./remote-workspace-folders";

const HOST = "127.0.0.1";
const MAX_HEADER_BYTES = 16 * 1024;
// Room for a message with images up to the composer's 30 MB total, as base64 JSON.
const MAX_BODY_BYTES = 48 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_SSE_STREAMS = 32;
const MAX_SSE_PER_CLIENT = 4;
const MAX_SSE_BUFFER_BYTES = 24 * 1024 * 1024;
const MAX_SSE_QUEUED_EVENTS = 64;
const MAX_SSE_QUEUED_FRAMES = MAX_SSE_QUEUED_EVENTS + 2;
const SSE_HEARTBEAT_FRAME = ": keep-alive\n\n";
/** Responses under this size go out as they are; compressing them saves nothing worth the work. */
const MIN_COMPRESSED_BYTES = 2048;
const brotliCompressAsync = promisify(brotliCompress);

/**
 * The Mac reaches this host through an SSH tunnel that may run over a relayed Tailscale path, and
 * the app state is about 2 MB of JSON. Clients that send `Accept-Encoding: br` get Brotli: a reply
 * shrinks about 25x, and on the event stream a 16 MB window lets each state reference the previous
 * one, so an update that changes one field costs bytes instead of the whole state again.
 */
function acceptsBrotli(request: IncomingMessage): boolean {
  const header = request.headers["accept-encoding"];
  return (
    typeof header === "string" &&
    header.split(",").some((value) => value.split(";", 1)[0]?.trim().toLowerCase() === "br")
  );
}

export interface RemoteDesktopHostClient {
  readonly id: string;
  readonly token: string;
  readonly workspaceIds: readonly string[];
  readonly folderRootWorkspaceIds?: readonly string[];
  readonly initialWorkspaceId?: string;
  readonly initialSessionId?: string;
}

export interface RemoteDesktopHttpHostConfig {
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly clients: readonly RemoteDesktopHostClient[];
  readonly brokers: ReadonlyMap<string, RemoteDesktopBroker>;
}

export interface RemoteDesktopHttpHost {
  readonly origin: string;
  close(): Promise<void>;
}

interface ClientRecord {
  readonly config: RemoteDesktopHostClient;
  readonly tokenDigest: Buffer;
  readonly broker: RemoteDesktopBroker;
}

interface SseConnection {
  readonly clientId: string;
  /** The HTTP response, or the Brotli encoder in front of it when the client accepts `br`. */
  readonly response: Writable;
  /** Pushes what the encoder holds onto the wire, so each frame arrives as soon as it is written. */
  readonly flush?: () => void;
  readonly heartbeat: ReturnType<typeof setInterval>;
  initializing: boolean;
  readonly queuedEvents: SerializedSseFrame[];
  queuedBytes: number;
  waitingForDrain: boolean;
  highestObservedStateRevision?: number;
  lastSentStateRevision?: number;
  drainListener?: () => void;
}

interface SerializedSseFrame {
  readonly type: RemoteDesktopEvent["type"];
  readonly text: string;
  readonly byteLength: number;
  readonly revision?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0")
  );
}

function validateOrigins(values: readonly string[]): Set<string> {
  if (values.length === 0) throw new Error("Remote desktop origins are required.");
  const origins = new Set<string>();
  for (const origin of values) {
    if (
      typeof origin !== "string" ||
      origin.length > 256 ||
      origin === "*" ||
      /[\r\n]/u.test(origin) ||
      (origin !== "file://" && !/^https?:\/\/127\.0\.0\.1(?::\d+)?$/u.test(origin))
    ) {
      throw new Error("Remote desktop origins must be exact file or loopback origins.");
    }
    origins.add(origin);
  }
  return origins;
}

function validateClients(
  configs: readonly RemoteDesktopHostClient[],
  brokers: ReadonlyMap<string, RemoteDesktopBroker>,
): Map<string, ClientRecord> {
  if (configs.length === 0) throw new Error("At least one remote desktop client is required.");
  const clients = new Map<string, ClientRecord>();
  const tokenDigests = new Set<string>();
  for (const config of configs) {
    if (!isIdentifier(config.id) || clients.has(config.id)) {
      throw new Error("Remote desktop client IDs must be unique.");
    }
    if (typeof config.token !== "string" || !/^[A-Za-z0-9._~-]{32,256}$/u.test(config.token)) {
      throw new Error("Remote desktop tokens must be 32 to 256 URL-safe characters.");
    }
    if (
      !Array.isArray(config.workspaceIds) ||
      config.workspaceIds.length === 0 ||
      config.workspaceIds.some((workspaceId) => !isIdentifier(workspaceId)) ||
      new Set(config.workspaceIds).size !== config.workspaceIds.length
    ) {
      throw new Error("Each remote desktop client requires a unique workspace allowlist.");
    }
    if (
      config.folderRootWorkspaceIds !== undefined &&
      (!Array.isArray(config.folderRootWorkspaceIds) ||
        config.folderRootWorkspaceIds.some((workspaceId) => !isIdentifier(workspaceId)) ||
        new Set(config.folderRootWorkspaceIds).size !== config.folderRootWorkspaceIds.length)
    ) {
      throw new Error("Each remote desktop client requires unique folder roots.");
    }
    if (config.initialWorkspaceId && !config.workspaceIds.includes(config.initialWorkspaceId)) {
      throw new Error("The initial workspace must be authorized for that client.");
    }
    if (config.initialSessionId && !config.initialWorkspaceId) {
      throw new Error("An initial session requires an initial workspace.");
    }
    const broker = brokers.get(config.id);
    if (!broker) throw new Error("A passive native view is required for each remote client.");
    const tokenDigest = createHash("sha256").update(config.token, "utf8").digest();
    const fingerprint = tokenDigest.toString("hex");
    if (tokenDigests.has(fingerprint)) throw new Error("Remote desktop tokens must be unique.");
    tokenDigests.add(fingerprint);
    clients.set(config.id, { config, tokenDigest, broker });
  }
  return clients;
}

function authenticate(
  request: IncomingMessage,
  clients: ReadonlyMap<string, ClientRecord>,
): ClientRecord {
  const raw = request.headers.authorization;
  const match = typeof raw === "string" ? /^Bearer ([A-Za-z0-9._~-]{32,256})$/u.exec(raw) : null;
  const digest = createHash("sha256")
    .update(match?.[1] ?? "", "utf8")
    .digest();
  let authenticated: ClientRecord | undefined;
  for (const client of clients.values()) {
    if (timingSafeEqual(digest, client.tokenDigest) && match) authenticated = client;
  }
  if (!authenticated) throw new HttpError(401, "unauthorized", "A valid bearer token is required.");
  return authenticated;
}

function serializeJson(value: unknown): Buffer {
  let body: Buffer;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") throw new Error("not json");
    body = Buffer.from(serialized, "utf8");
  } catch {
    throw new HttpError(
      500,
      "serialization_failed",
      "The remote response could not be serialized.",
    );
  }
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new HttpError(413, "response_too_large", "The remote response exceeds its size limit.");
  }
  return body;
}

function sendJsonBody(
  response: ServerResponse,
  status: number,
  body: Buffer,
  encoding?: "br",
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    ...(encoding ? { "Content-Encoding": encoding, Vary: "Origin, Accept-Encoding" } : {}),
    "Content-Length": String(body.byteLength),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  sendJsonBody(response, status, serializeJson(value));
}

/** Like writeJson, compressed with Brotli for a client that accepts it; off the main thread. */
async function writeJsonEncoded(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
): Promise<void> {
  const body = serializeJson(value);
  if (!acceptsBrotli(request) || body.byteLength < MIN_COMPRESSED_BYTES) {
    sendJsonBody(response, status, body);
    return;
  }
  const encoded = await brotliCompressAsync(body, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
    },
  });
  if (!response.writableEnded && !response.destroyed) sendJsonBody(response, status, encoded, "br");
}

function writeError(response: ServerResponse, error: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  const known = error instanceof HttpError ? error : undefined;
  try {
    writeJson(response, known?.status ?? 500, {
      version: 1,
      error: {
        code: known?.code ?? "operation_failed",
        message: known?.message ?? "The remote native operation failed.",
      },
    });
  } catch {
    response.destroy();
  }
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    request.resume();
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)) {
    request.resume();
    throw new HttpError(413, "body_too_large", "The request body exceeds its size limit.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        request.resume();
        reject(new HttpError(413, "body_too_large", "The request body exceeds its size limit."));
      } else {
        chunks.push(bytes);
      }
    });
    request.once("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new HttpError(400, "invalid_json", "A JSON object is required.");
  }
}

function serializeSseEvent(event: RemoteDesktopEvent): SerializedSseFrame | undefined {
  if (!isRemoteDesktopEvent(event)) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(event);
  } catch {
    return undefined;
  }
  if (serialized === undefined) return undefined;
  const text = "event: " + event.type + "\ndata: " + serialized + "\n\n";
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAX_RESPONSE_BYTES) return undefined;
  return {
    type: event.type,
    text,
    byteLength,
    ...(event.type === "stateChanged" ? { revision: event.state.revision } : {}),
  };
}

function isEmptyRequest(request: IncomingMessage): boolean {
  return (
    request.headers["transfer-encoding"] === undefined &&
    (request.headers["content-length"] === undefined || request.headers["content-length"] === "0")
  );
}

/** One authenticated loopback API. All actions are forwarded through the per-device native view. */
export async function startRemoteDesktopHttpHost(
  config: RemoteDesktopHttpHostConfig,
): Promise<RemoteDesktopHttpHost> {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error("The remote desktop port is invalid.");
  }
  const origins = validateOrigins(config.allowedOrigins);
  const clients = validateClients(config.clients, config.brokers);
  const streams = new Set<SseConnection>();
  const unsubscribe = new Map<string, () => void>();
  let server: Server;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let eventSequence = 1;
  function removeStream(stream: SseConnection): void {
    clearInterval(stream.heartbeat);
    if (stream.drainListener) stream.response.removeListener("drain", stream.drainListener);
    stream.drainListener = undefined;
    stream.waitingForDrain = false;
    stream.queuedEvents.length = 0;
    stream.queuedBytes = 0;
    streams.delete(stream);
  }
  function destroyStream(stream: SseConnection): void {
    removeStream(stream);
    if (!stream.response.destroyed) stream.response.destroy();
  }
  function canBufferFrame(stream: SseConnection, byteLength: number): boolean {
    return stream.response.writableLength + stream.queuedBytes + byteLength <= MAX_SSE_BUFFER_BYTES;
  }
  function waitForDrain(stream: SseConnection): void {
    if (stream.waitingForDrain || stream.response.writableEnded || stream.response.destroyed) {
      return;
    }
    stream.waitingForDrain = true;
    const onDrain = () => {
      if (stream.drainListener !== onDrain) return;
      stream.drainListener = undefined;
      stream.waitingForDrain = false;
      flushQueuedEvents(stream);
    };
    stream.drainListener = onDrain;
    stream.response.once("drain", onDrain);
  }
  function writeFrame(stream: SseConnection, frame: SerializedSseFrame): boolean {
    if (stream.response.writableEnded || stream.response.destroyed) {
      removeStream(stream);
      return false;
    }
    if (!canBufferFrame(stream, frame.byteLength)) {
      destroyStream(stream);
      return false;
    }
    try {
      const accepted = stream.response.write(frame.text);
      stream.flush?.();
      if (frame.type === "stateChanged") stream.lastSentStateRevision = frame.revision;
      if (!accepted) waitForDrain(stream);
      return true;
    } catch {
      destroyStream(stream);
      return false;
    }
  }
  function flushQueuedEvents(stream: SseConnection): void {
    if (
      stream.initializing ||
      stream.waitingForDrain ||
      stream.response.writableEnded ||
      stream.response.destroyed
    ) {
      return;
    }
    while (stream.queuedEvents.length > 0) {
      const frame = stream.queuedEvents.shift()!;
      stream.queuedBytes -= frame.byteLength;
      if (
        frame.type === "stateChanged" &&
        stream.lastSentStateRevision !== undefined &&
        frame.revision! <= stream.lastSentStateRevision
      ) {
        continue;
      }
      if (!writeFrame(stream, frame) || stream.waitingForDrain) return;
    }
  }
  function queueFrame(stream: SseConnection, frame: SerializedSseFrame): void {
    const tail = stream.queuedEvents[stream.queuedEvents.length - 1];
    const replaceTail = frame.type === "stateChanged" && tail?.type === "stateChanged";
    const replacedBytes = replaceTail ? tail.byteLength : 0;
    const nextQueuedBytes = stream.queuedBytes - replacedBytes + frame.byteLength;
    const nextQueuedCount = stream.queuedEvents.length + (replaceTail ? 0 : 1);
    if (
      stream.response.writableLength + nextQueuedBytes > MAX_SSE_BUFFER_BYTES ||
      nextQueuedCount > MAX_SSE_QUEUED_FRAMES
    ) {
      destroyStream(stream);
      return;
    }
    if (replaceTail) {
      stream.queuedEvents[stream.queuedEvents.length - 1] = frame;
    } else {
      stream.queuedEvents.push(frame);
    }
    stream.queuedBytes = nextQueuedBytes;
  }
  function enqueueFrame(stream: SseConnection, frame: SerializedSseFrame): void {
    if (stream.response.writableEnded || stream.response.destroyed) {
      removeStream(stream);
      return;
    }
    if (frame.type === "stateChanged") {
      const previousRevision = stream.highestObservedStateRevision;
      if (previousRevision !== undefined && frame.revision! <= previousRevision) return;
      stream.highestObservedStateRevision = frame.revision;
    }
    if (stream.initializing || stream.waitingForDrain || stream.queuedEvents.length > 0) {
      queueFrame(stream, frame);
      return;
    }
    writeFrame(stream, frame);
  }
  function enqueueBootstrapFrames(
    stream: SseConnection,
    frames: readonly SerializedSseFrame[],
  ): void {
    const addedBytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
    if (
      stream.response.writableEnded ||
      stream.response.destroyed ||
      stream.response.writableLength + stream.queuedBytes + addedBytes > MAX_SSE_BUFFER_BYTES ||
      stream.queuedEvents.length + frames.length > MAX_SSE_QUEUED_FRAMES
    ) {
      destroyStream(stream);
      return;
    }
    const initialState = frames.find((frame) => frame.type === "stateChanged");
    if (initialState?.revision !== undefined) {
      stream.highestObservedStateRevision = Math.max(
        stream.highestObservedStateRevision ?? -1,
        initialState.revision,
      );
    }
    stream.initializing = false;
    stream.queuedEvents.unshift(...frames);
    stream.queuedBytes += addedBytes;
    flushQueuedEvents(stream);
  }
  function publish(clientId: string, event: RemoteDesktopEvent): void {
    const recipients = [...streams].filter((stream) => stream.clientId === clientId);
    if (recipients.length === 0) return;
    const frame = serializeSseEvent(event);
    if (!frame) {
      for (const stream of recipients) destroyStream(stream);
      return;
    }
    for (const stream of recipients) enqueueFrame(stream, frame);
  }

  for (const [id, client] of clients) {
    unsubscribe.set(
      id,
      client.broker.subscribe((event) => publish(id, event)),
    );
  }

  const hostOrigin = (port: number) => `http://${HOST}:${port}`;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const actualPort = (server.address() as AddressInfo | null)?.port;
    if (actualPort !== config.port || request.headers.host !== `${HOST}:${config.port}`) {
      writeError(
        response,
        new HttpError(400, "invalid_host", "The loopback Host header is invalid."),
      );
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !origins.has(origin)) {
      writeError(
        response,
        new HttpError(403, "origin_denied", "The request origin is not allowed."),
      );
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");

    let client: ClientRecord;
    try {
      client = authenticate(request, clients);
    } catch (error) {
      request.resume();
      writeError(response, error);
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", hostOrigin(config.port));
    } catch {
      writeError(response, new HttpError(400, "invalid_url", "The request URL is invalid."));
      return;
    }
    if (url.origin !== hostOrigin(config.port) || url.search || url.hash) {
      writeError(response, new HttpError(400, "invalid_url", "The request URL is not allowed."));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/invoke") {
      try {
        const body = await readJsonObject(request);
        if (Object.keys(body).some((key) => key !== "method" && key !== "args")) {
          throw new HttpError(400, "invalid_request", "The request contains an unsupported field.");
        }
        if (!isRemoteDesktopMethod(body.method) || !Array.isArray(body.args)) {
          throw new HttpError(400, "invalid_request", "The remote method request is invalid.");
        }
        const result = await client.broker.invoke(body.method, body.args);
        await writeJsonEncoded(request, response, 200, { version: 1, result });
      } catch (error) {
        if (error instanceof HttpError) {
          writeError(response, error);
        } else if (error instanceof RemoteWorkspaceFolderError) {
          const status =
            error.code === "ROOT_UNAVAILABLE"
              ? 403
              : error.code === "NOT_FOUND"
                ? 404
                : error.code === "CONFLICT"
                  ? 409
                  : error.code === "INVALID_PATH"
                    ? 400
                    : 500;
          writeError(response, new HttpError(status, error.code.toLowerCase(), error.message));
        } else {
          writeError(
            response,
            new HttpError(
              400,
              "operation_failed",
              error instanceof TypeError ? error.message : "The remote native operation failed.",
            ),
          );
        }
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/events") {
      if (!isEmptyRequest(request)) {
        request.resume();
        writeError(
          response,
          new HttpError(400, "unexpected_body", "The event stream has no body."),
        );
        return;
      }
      if (
        !request.headers.accept
          ?.split(",")
          .some((value) => value.trim().startsWith("text/event-stream"))
      ) {
        writeError(
          response,
          new HttpError(406, "event_stream_required", "Accept: text/event-stream is required."),
        );
        return;
      }
      const clientStreams = [...streams].filter(
        (stream) => stream.clientId === client.config.id,
      ).length;
      if (streams.size >= MAX_SSE_STREAMS || clientStreams >= MAX_SSE_PER_CLIENT) {
        writeError(
          response,
          new HttpError(429, "too_many_event_streams", "The event-stream limit was reached."),
        );
        return;
      }
      const brotli = acceptsBrotli(request);
      response.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...(brotli ? { "Content-Encoding": "br", Vary: "Origin, Accept-Encoding" } : {}),
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      });
      // Quality 4 with a 16 MB window: about 35 ms for the first full state, then a few ms and a
      // few dozen bytes for each state that differs only slightly from the one before it.
      const encoder = brotli
        ? createBrotliCompress({
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
              [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
              [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
            },
          })
        : undefined;
      // A closed response ends the encoder too; the response's own close/error events clean up.
      if (encoder) pipeline(encoder, response, () => undefined);
      const sink: Writable = encoder ?? response;
      const flush = encoder ? () => encoder.flush(zlibConstants.BROTLI_OPERATION_FLUSH) : undefined;
      sink.write(`id: ${eventSequence++}\nevent: ready\ndata: {"version":1}\n\n`);
      flush?.();
      const stream: SseConnection = {
        clientId: client.config.id,
        response: sink,
        ...(flush ? { flush } : {}),
        initializing: true,
        queuedEvents: [],
        queuedBytes: 0,
        waitingForDrain: false,
        heartbeat: setInterval(() => {
          if (sink.writableEnded || sink.destroyed) {
            removeStream(stream);
            return;
          }
          if (stream.initializing || stream.waitingForDrain || stream.queuedEvents.length > 0) {
            return;
          }
          if (
            sink.writableLength + Buffer.byteLength(SSE_HEARTBEAT_FRAME, "utf8") >
            MAX_SSE_BUFFER_BYTES
          ) {
            destroyStream(stream);
            return;
          }
          try {
            const accepted = sink.write(SSE_HEARTBEAT_FRAME);
            flush?.();
            if (!accepted) waitForDrain(stream);
          } catch {
            destroyStream(stream);
          }
        }, 15_000),
      };
      stream.heartbeat.unref?.();
      streams.add(stream);
      response.once("close", () => removeStream(stream));
      response.once("error", () => removeStream(stream));
      try {
        const state = await client.broker.invoke("getState", []);
        const transcript = await client.broker.invoke("getSelectedTranscript", []);
        if (closed || sink.writableEnded || sink.destroyed) return;
        const initialFrames: SerializedSseFrame[] = [];
        if (isRecord(state) && Array.isArray(state.workspaces)) {
          const stateFrame = serializeSseEvent({ type: "stateChanged", state: state as never });
          if (!stateFrame) {
            destroyStream(stream);
            return;
          }
          initialFrames.push(stateFrame);
        }
        const transcriptFrame = serializeSseEvent({
          type: "selectedTranscriptChanged",
          transcript: transcript && isRecord(transcript) ? (transcript as never) : null,
        });
        if (!transcriptFrame) {
          destroyStream(stream);
          return;
        }
        initialFrames.push(transcriptFrame);
        enqueueBootstrapFrames(stream, initialFrames);
      } catch {
        destroyStream(stream);
      }
      return;
    }

    request.resume();
    writeError(
      response,
      new HttpError(404, "not_found", "The remote desktop route was not found."),
    );
  };

  server = createServer(
    { maxHeaderSize: MAX_HEADER_BYTES, headersTimeout: 10_000, requestTimeout: 70_000 },
    (request, response) => {
      void handle(request, response).catch((error: unknown) => writeError(response, error));
    },
  );
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(config.port, HOST, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  if ((server.address() as AddressInfo | null)?.address !== HOST) {
    server.close();
    throw new Error("The remote desktop host did not bind to loopback.");
  }

  return {
    origin: hostOrigin(config.port),
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      for (const stop of unsubscribe.values()) stop();
      unsubscribe.clear();
      for (const stream of streams) {
        removeStream(stream);
        stream.response.end();
      }
      streams.clear();
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
      });
      return closePromise;
    },
  };
}
