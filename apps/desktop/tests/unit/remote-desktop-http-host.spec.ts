import { randomBytes } from "node:crypto";
import http from "node:http";
import { createServer } from "node:net";
import { expect, test } from "@playwright/test";
import type { RemoteDesktopBroker } from "../../electron/remote/remote-desktop-broker";
import { startRemoteDesktopHttpHost } from "../../electron/remote/remote-desktop-http-host";
import { RemoteDesktopHttpClient } from "../../electron/remote/remote-desktop-http-client";
import type { RemoteDesktopEvent } from "../../electron/remote/remote-desktop-protocol";
import { validateRemoteDesktopInvocation } from "../../electron/remote/remote-desktop-policy";
import { answerActiveRuns, type ActiveRun } from "../../electron/usage/active-runs";

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port was allocated.");
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function sendRequest(
  port: number,
  options: {
    readonly pathname: string;
    readonly token?: string;
    readonly origin?: string;
    readonly body?: Buffer;
  },
): Promise<{ readonly status: number; readonly body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Origin: options.origin ?? "file://" };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(options.body.byteLength);
    }
    const request = http.request(
      { hostname: "127.0.0.1", port, path: options.pathname, method: "POST", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

function makeState(revision: number, padding = "") {
  return {
    revision,
    workspaces: [],
    selectedWorkspaceId: "",
    selectedSessionId: "",
    padding,
  };
}

function makeTranscriptEvent(id: string, padding = ""): RemoteDesktopEvent {
  return {
    type: "selectedTranscriptChanged",
    transcript: {
      workspaceId: "workspace",
      sessionId: "session",
      transcript: [{ id, content: padding }],
    },
  } as never;
}

function eventLabel(event: RemoteDesktopEvent): string {
  if (event.type === "stateChanged") return "state:" + event.state.revision;
  const entry = event.transcript?.transcript[0] as { id?: string } | undefined;
  return "transcript:" + (entry?.id ?? "none");
}

function createTestBroker(state: unknown) {
  const calls: string[] = [];
  let listener: ((event: RemoteDesktopEvent) => void) | undefined;
  let unsubscribeCount = 0;
  const broker = {
    subscribe(next: (event: RemoteDesktopEvent) => void) {
      listener = next;
      return () => {
        unsubscribeCount += 1;
        listener = undefined;
      };
    },
    async invoke(method: unknown) {
      calls.push(String(method));
      if (method === "getState") return state;
      if (method === "getSelectedTranscript") {
        return {
          workspaceId: "workspace",
          sessionId: "session",
          transcript: [{ id: "initial" }],
        };
      }
      return null;
    },
  } as unknown as RemoteDesktopBroker;
  return {
    broker,
    calls,
    emit(event: RemoteDesktopEvent) {
      listener?.(event);
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the HTTP stream.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function openPausedEventStream(port: number, token: string) {
  return new Promise<{
    readonly request: http.ClientRequest;
    readonly response: http.IncomingMessage;
  }>((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/events",
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: "Bearer " + token,
          Origin: "file://",
        },
      },
      (response) => {
        response.pause();
        response.on("error", () => undefined);
        resolve({ request, response });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("large initial state and transcript stay on one SSE connection", async () => {
  const port = await freeLoopbackPort();
  const token = randomBytes(32).toString("base64url");
  const fake = createTestBroker(makeState(7, "x".repeat(3_300_000)));
  const host = await startRemoteDesktopHttpHost({
    port,
    allowedOrigins: ["file://"],
    clients: [{ id: "mac-client", token, workspaceIds: ["workspace"] }],
    brokers: new Map([["mac-client", fake.broker]]),
  });
  const client = new RemoteDesktopHttpClient({
    version: 1,
    baseUrl: host.origin,
    origin: "file://",
    token,
  });
  const events: RemoteDesktopEvent[] = [];
  client.subscribe((event) => events.push(event));

  try {
    client.startEvents();
    await waitUntil(
      () =>
        events.some((event) => event.type === "stateChanged") &&
        events.some((event) => event.type === "selectedTranscriptChanged"),
      5_000,
    );
    expect(events.slice(0, 2).map(eventLabel)).toEqual(["state:7", "transcript:initial"]);
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(fake.calls).toEqual(["getState", "getSelectedTranscript"]);
  } finally {
    client.close();
    await host.close();
  }
  expect(fake.unsubscribeCount).toBe(1);
});

test("SSE coalesces queued snapshots around transcript events without reordering", async () => {
  const port = await freeLoopbackPort();
  const token = randomBytes(32).toString("base64url");
  const fake = createTestBroker(makeState(1));
  const host = await startRemoteDesktopHttpHost({
    port,
    allowedOrigins: ["file://"],
    clients: [{ id: "mac-client", token, workspaceIds: ["workspace"] }],
    brokers: new Map([["mac-client", fake.broker]]),
  });
  const client = new RemoteDesktopHttpClient({
    version: 1,
    baseUrl: host.origin,
    origin: "file://",
    token,
  });
  const events: RemoteDesktopEvent[] = [];
  client.subscribe((event) => events.push(event));

  try {
    client.startEvents();
    await waitUntil(() => events.length >= 2, 5_000);
    const start = events.length;
    fake.emit(makeTranscriptEvent("large", "x".repeat(6 * 1024 * 1024)));
    fake.emit({ type: "stateChanged", state: makeState(2) } as never);
    fake.emit({ type: "stateChanged", state: makeState(3) } as never);
    fake.emit(makeTranscriptEvent("between"));
    fake.emit({ type: "stateChanged", state: makeState(4) } as never);
    fake.emit({ type: "stateChanged", state: makeState(5) } as never);
    await waitUntil(() => events.length >= start + 4, 8_000);
    expect(events.slice(start).map(eventLabel)).toEqual([
      "transcript:large",
      "state:3",
      "transcript:between",
      "state:5",
    ]);
    expect(fake.calls).toEqual(["getState", "getSelectedTranscript"]);
  } finally {
    client.close();
    await host.close();
  }
  expect(fake.unsubscribeCount).toBe(1);
});

test("the client hears each time its event stream reconnects to a restarted host", async () => {
  const port = await freeLoopbackPort();
  const token = randomBytes(32).toString("base64url");
  const startHost = () =>
    startRemoteDesktopHttpHost({
      port,
      allowedOrigins: ["file://"],
      clients: [{ id: "mac-client", token, workspaceIds: ["workspace"] }],
      brokers: new Map([["mac-client", createTestBroker(makeState(1)).broker]]),
    });
  let host = await startHost();
  const client = new RemoteDesktopHttpClient({ version: 1, baseUrl: host.origin, origin: "file://", token });
  let ready = 0;
  client.onReady(() => {
    ready += 1;
  });

  try {
    client.startEvents();
    await waitUntil(() => ready === 1, 5_000);
    await host.close();
    host = await startHost();
    await waitUntil(() => ready === 2, 10_000);
  } finally {
    client.close();
    await host.close();
  }
});

test("disconnecting an SSE client frees its per-client stream slot", async () => {
  const port = await freeLoopbackPort();
  const token = randomBytes(32).toString("base64url");
  const fake = createTestBroker(makeState(1));
  const host = await startRemoteDesktopHttpHost({
    port,
    allowedOrigins: ["file://"],
    clients: [{ id: "mac-client", token, workspaceIds: ["workspace"] }],
    brokers: new Map([["mac-client", fake.broker]]),
  });
  const opened: Array<Awaited<ReturnType<typeof openPausedEventStream>>> = [];

  try {
    for (let index = 0; index < 4; index += 1) {
      const stream = await openPausedEventStream(port, token);
      expect(stream.response.statusCode).toBe(200);
      opened.push(stream);
    }
    const rejected = await openPausedEventStream(port, token);
    expect(rejected.response.statusCode).toBe(429);
    rejected.request.destroy();
    rejected.response.destroy();

    let disconnected = false;
    opened[0].response.once("close", () => {
      disconnected = true;
    });
    opened[0].request.destroy();
    await waitUntil(() => disconnected, 2_000);

    let replacement: Awaited<ReturnType<typeof openPausedEventStream>> | undefined;
    const deadline = Date.now() + 2_000;
    while (!replacement && Date.now() < deadline) {
      const candidate = await openPausedEventStream(port, token);
      if (candidate.response.statusCode === 200) replacement = candidate;
      else {
        candidate.request.destroy();
        candidate.response.destroy();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(replacement?.response.statusCode).toBe(200);
    if (replacement) opened.push(replacement);
  } finally {
    for (const stream of opened) {
      stream.request.destroy();
      stream.response.destroy();
    }
    await host.close();
  }
  expect(fake.unsubscribeCount).toBe(1);
});

test("paused SSE clients are disconnected when pending frames exceed the byte cap", async () => {
  const port = await freeLoopbackPort();
  const token = randomBytes(32).toString("base64url");
  const fake = createTestBroker(makeState(1));
  const host = await startRemoteDesktopHttpHost({
    port,
    allowedOrigins: ["file://"],
    clients: [{ id: "mac-client", token, workspaceIds: ["workspace"] }],
    brokers: new Map([["mac-client", fake.broker]]),
  });
  const { request, response } = await openPausedEventStream(port, token);
  let streamClosed = false;
  response.once("close", () => {
    streamClosed = true;
  });

  try {
    await waitUntil(() => fake.calls.length === 2, 2_000);
    const padding = "x".repeat(7 * 1024 * 1024);
    for (let index = 0; index < 8; index += 1) {
      fake.emit(makeTranscriptEvent("slow-" + index, padding));
    }
    await waitUntil(() => streamClosed, 2_000);
    expect(response.statusCode).toBe(200);
  } finally {
    request.destroy();
    await host.close();
  }
  expect(fake.unsubscribeCount).toBe(1);
});

test("loopback host enforces origin, bearer token, and JSON body cap before broker calls", async () => {
  const port = await freeLoopbackPort();
  const token = randomBytes(32).toString("base64url");
  const state = { workspaces: [], selectedWorkspaceId: "", selectedSessionId: "" };
  let calls = 0;
  const broker = {
    subscribe: () => () => undefined,
    invoke: async () => {
      calls += 1;
      return state;
    },
  } as unknown as RemoteDesktopBroker;
  const host = await startRemoteDesktopHttpHost({
    port,
    allowedOrigins: ["file://"],
    clients: [{ id: "mac-client", token, workspaceIds: ["workspace"] }],
    brokers: new Map([["mac-client", broker]]),
  });

  try {
    const deniedOrigin = await sendRequest(port, {
      pathname: "/v1/invoke",
      token,
      origin: "https://example.invalid",
      body: Buffer.from('{"method":"getState","args":[]}'),
    });
    expect(deniedOrigin.status).toBe(403);

    const deniedToken = await sendRequest(port, {
      pathname: "/v1/invoke",
      token: randomBytes(32).toString("base64url"),
      body: Buffer.from('{"method":"getState","args":[]}'),
    });
    expect(deniedToken.status).toBe(401);

    const tooLarge = await sendRequest(port, {
      pathname: "/v1/invoke",
      token,
      body: Buffer.alloc(48 * 1024 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(413);

    const accepted = await sendRequest(port, {
      pathname: "/v1/invoke",
      token,
      body: Buffer.from('{"method":"getState","args":[]}'),
    });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body.toString("utf8"))).toEqual({ version: 1, result: state });
    expect(calls).toBe(1);
  } finally {
    await host.close();
  }
});

test("loopback host validates and dispatches active-view protocol requests", async () => {
  const port = await freeLoopbackPort();
  const token = randomBytes(32).toString("base64url");
  const state = {
    workspaces: [],
    selectedWorkspaceId: "",
    selectedSessionId: "",
    activeView: "skills",
    revision: 1,
  };
  const calls: Array<{ method: unknown; args: unknown }> = [];
  const broker = {
    subscribe: () => () => undefined,
    invoke: async (method: unknown, args: unknown) => {
      calls.push({ method, args });
      return state;
    },
  } as unknown as RemoteDesktopBroker;
  const host = await startRemoteDesktopHttpHost({
    port,
    allowedOrigins: ["file://"],
    clients: [{ id: "mac-client", token, workspaceIds: ["workspace"] }],
    brokers: new Map([["mac-client", broker]]),
  });

  try {
    const accepted = await sendRequest(port, {
      pathname: "/v1/invoke",
      token,
      body: Buffer.from(JSON.stringify({ method: "setActiveView", args: ["skills"] })),
    });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body.toString("utf8"))).toEqual({ version: 1, result: state });
    expect(calls).toEqual([{ method: "setActiveView", args: ["skills"] }]);

    const rejected = await sendRequest(port, {
      pathname: "/v1/invoke",
      token,
      body: Buffer.from(JSON.stringify({ method: "setProviderSecret", args: [] })),
    });
    expect(rejected.status).toBe(400);
    expect(calls).toHaveLength(1);
  } finally {
    await host.close();
  }
});

test("getActiveRuns answers the seher-server client only, through the host and broker policy", async () => {
  const port = await freeLoopbackPort();
  const seherToken = randomBytes(32).toString("base64url");
  const macToken = randomBytes(32).toString("base64url");
  const runs: readonly ActiveRun[] = [
    {
      threadId: "t-1",
      provider: "claude-code-account-2",
      accountLabel: "Claude 2",
      model: "claude-opus-5-5",
      workspaceName: "Seher",
      status: "tool",
      startedAt: "2026-11-02T10:00:00.000Z",
      lastEventAt: "2026-11-02T10:05:00.000Z",
    },
  ];
  // The broker's own order: validate the envelope, then answer host methods in main.
  const brokerFor = (clientId: string) =>
    ({
      subscribe: () => () => undefined,
      invoke: async (method: unknown, args: unknown) => {
        const invocation = validateRemoteDesktopInvocation(method, args, new Set(["workspace"]));
        if (invocation.method !== "getActiveRuns") throw new Error("unexpected");
        return answerActiveRuns(clientId, () => runs);
      },
    }) as unknown as RemoteDesktopBroker;
  const host = await startRemoteDesktopHttpHost({
    port,
    allowedOrigins: ["file://"],
    clients: [
      { id: "seher-server", token: seherToken, workspaceIds: ["workspace"] },
      { id: "mac-client", token: macToken, workspaceIds: ["workspace"] },
    ],
    brokers: new Map([
      ["seher-server", brokerFor("seher-server")],
      ["mac-client", brokerFor("mac-client")],
    ]),
  });
  const body = Buffer.from(JSON.stringify({ method: "getActiveRuns", args: [] }));

  try {
    const accepted = await sendRequest(port, { pathname: "/v1/invoke", token: seherToken, body });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body.toString("utf8"))).toEqual({ version: 1, result: runs });

    const otherDevice = await sendRequest(port, { pathname: "/v1/invoke", token: macToken, body });
    expect(otherDevice.status).toBe(400);
    expect(otherDevice.body.toString("utf8")).not.toContain("Seher");

    const withArgs = await sendRequest(port, {
      pathname: "/v1/invoke",
      token: seherToken,
      body: Buffer.from(JSON.stringify({ method: "getActiveRuns", args: ["all"] })),
    });
    expect(withArgs.status).toBe(400);
  } finally {
    await host.close();
  }
});

test("clients that accept Brotli get compressed replies and a stream whose small updates stay small", async () => {
  const { createBrotliDecompress } = await import("node:zlib");
  const port = await freeLoopbackPort();
  const token = randomBytes(32).toString("base64url");
  // About 1 MB of model-list-like JSON, the shape that makes the real state 2 MB.
  const padding = Array.from(
    { length: 40_000 },
    (_, index) => `model-${index}-${(index * 7919) % 997}`,
  ).join(",");
  const fake = createTestBroker(makeState(1, padding));
  const host = await startRemoteDesktopHttpHost({
    port,
    allowedOrigins: ["file://"],
    clients: [{ id: "mac-client", token, workspaceIds: ["workspace"] }],
    brokers: new Map([["mac-client", fake.broker]]),
  });
  const client = new RemoteDesktopHttpClient({
    version: 1,
    baseUrl: host.origin,
    origin: "file://",
    token,
  });
  const events: RemoteDesktopEvent[] = [];
  client.subscribe((event) => events.push(event));
  let raw: http.ClientRequest | undefined;
  try {
    // The real client asks for Brotli and decodes it.
    expect(await client.invoke("getState", [])).toEqual(makeState(1, padding));

    // On the wire the reply is compressed and far smaller.
    const reply = await new Promise<{ encoding?: string; bytes: number }>((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ method: "getState", args: [] }));
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/v1/invoke",
          method: "POST",
          headers: {
            Origin: "file://",
            Authorization: `Bearer ${token}`,
            "Accept-Encoding": "gzip, br",
            "Content-Type": "application/json",
            "Content-Length": String(body.byteLength),
          },
        },
        (response) => {
          let bytes = 0;
          response.on("data", (chunk: Buffer) => (bytes += chunk.byteLength));
          response.once("end", () =>
            resolve({ encoding: response.headers["content-encoding"], bytes }),
          );
        },
      );
      request.once("error", reject);
      request.end(body);
    });
    expect(reply.encoding).toBe("br");
    expect(reply.bytes).toBeLessThan(padding.length / 5);

    // Event stream: the first state costs its compressed size, a near-identical one almost nothing.
    let wireBytes = 0;
    let decoded = "";
    raw = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/v1/events",
      method: "GET",
      headers: {
        Origin: "file://",
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
        "Accept-Encoding": "br",
      },
    });
    raw.on("response", (response) => {
      expect(response.headers["content-encoding"]).toBe("br");
      response.on("data", (chunk: Buffer) => (wireBytes += chunk.byteLength));
      response
        .pipe(createBrotliDecompress())
        .on("data", (chunk: Buffer) => (decoded += chunk.toString("utf8")));
    });
    raw.end();
    await waitUntil(() => decoded.includes('"revision":1'), 5_000);
    await waitUntil(() => decoded.includes("selectedTranscriptChanged"), 5_000);
    const afterBootstrap = wireBytes;
    fake.emit({
      type: "stateChanged",
      state: { ...makeState(2, padding), activeView: "usage" },
    } as never);
    await waitUntil(() => decoded.includes('"revision":2'), 5_000);
    expect(wireBytes - afterBootstrap).toBeLessThan(2_000);

    // The real client's stream decodes the same frames.
    client.startEvents();
    // A new stream starts from the broker's current state, which this fake keeps at revision 1.
    await waitUntil(() => events.some((event) => eventLabel(event) === "state:1"), 5_000);
    fake.emit({ type: "stateChanged", state: makeState(3, padding) } as never);
    await waitUntil(() => events.some((event) => eventLabel(event) === "state:3"), 5_000);
  } finally {
    raw?.destroy();
    client.close();
    await host.close();
  }
});

test("a client that does not ask for Brotli still gets plain JSON", async () => {
  const port = await freeLoopbackPort();
  const token = randomBytes(32).toString("base64url");
  const fake = createTestBroker(makeState(4, "y".repeat(50_000)));
  const host = await startRemoteDesktopHttpHost({
    port,
    allowedOrigins: ["file://"],
    clients: [{ id: "mac-client", token, workspaceIds: ["workspace"] }],
    brokers: new Map([["mac-client", fake.broker]]),
  });
  try {
    const plain = await sendRequest(port, {
      pathname: "/v1/invoke",
      token,
      body: Buffer.from(JSON.stringify({ method: "getState", args: [] })),
    });
    expect(plain.status).toBe(200);
    expect(JSON.parse(plain.body.toString("utf8")).result.revision).toBe(4);
  } finally {
    await host.close();
  }
});
