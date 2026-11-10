// Plain Node tests for the phone's pure logic: node --test --experimental-strip-types
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePairingLink } from "./pairing.ts";
import { SseParser } from "./sse.ts";
import { orderChats } from "./chats.ts";

const token = "a".repeat(43);

test("pairing links from Settings › Phone are read, others refused", () => {
  const link = `pegasus://pair?v=1&url=${encodeURIComponent("http://100.88.47.111:47219")}&token=${token}&name=GEONQSERVER`;
  assert.deepEqual(parsePairingLink(link), {
    url: "http://100.88.47.111:47219",
    token,
    hostName: "GEONQSERVER",
  });
  assert.throws(() => parsePairingLink("https://example.com"), /not a Pegasus pairing code/u);
  assert.throws(() => parsePairingLink(link.replace("v=1", "v=2")), /newer Pegasus/u);
  assert.throws(() => parsePairingLink(link.replace(token, "short")), /valid key/u);
  assert.throws(
    () => parsePairingLink("pegasus://pair?v=1&url=ftp%3A%2F%2Fx&token=" + token),
    /valid address/u,
  );
});

test("SSE frames split across chunks, comments and CRLF are parsed", () => {
  const p = new SseParser();
  assert.deepEqual(p.push('id: 1\nevent: ready\ndata: {"version":1}\n'), []);
  assert.deepEqual(p.push('\n: keep-alive\n\nevent: stateChanged\r\ndata: {"a":'), [
    { event: "ready", data: '{"version":1}', id: "1" },
  ]);
  assert.deepEqual(p.push("1}\r\n\r\n"), [{ event: "stateChanged", data: '{"a":1}' }]);
});

test("chats needing you come first, then running, then the newest", () => {
  const s = (id: string, extra: Record<string, unknown>) => ({
    id,
    title: id,
    updatedAt: "2026-11-10T10:00:00.000Z",
    preview: "",
    status: "idle" as const,
    hasUnseenUpdate: false,
    ...extra,
  });
  const ordered = orderChats([
    {
      id: "w",
      name: "pegasus",
      path: "D:/Pi/pi-gui",
      kind: "local",
      sessions: [
        s("old", { updatedAt: "2026-11-09T10:00:00.000Z" }),
        s("running", { status: "running" }),
        s("failed", { status: "failed" }),
        s("unseen", { hasUnseenUpdate: true }),
        s("archived", { archivedAt: "2026-11-10T09:00:00.000Z", hasUnseenUpdate: true }),
      ],
    },
  ]);
  assert.deepEqual(
    ordered.map((chat) => [chat.session.id, chat.section]),
    [
      ["failed", "needs-you"],
      ["unseen", "needs-you"],
      ["running", "working"],
      ["old", "recent"],
    ],
  );
});
