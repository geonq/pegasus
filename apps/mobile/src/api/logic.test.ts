// Plain Node tests for the phone's pure logic: node --test --experimental-strip-types
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePairingLink } from "./pairing.ts";
import { SseParser } from "./sse.ts";
import { buildHome, orderChats, relativeTime, waitingLabel } from "./chats.ts";
import { planStatus } from "./usage.ts";

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

test("bug A: only a waiting dialog or an unseen failure needs you, as on the desktop", () => {
  const s = (id: string, extra: Record<string, unknown>) => ({
    id,
    title: id,
    updatedAt: "2026-11-10T10:00:00.000Z",
    preview: "",
    status: "idle" as const,
    hasUnseenUpdate: false,
    ...extra,
  });
  const rows = orderChats([
    {
      id: "w",
      name: "pegasus",
      path: "D:/Pi/pi-gui",
      kind: "primary",
      sessions: [
        s("finished-unseen", { hasUnseenUpdate: true }),
        s("failed-seen", { status: "failed" }),
        s("failed-unseen", { status: "failed", hasUnseenUpdate: true }),
      ],
    },
  ]);
  assert.deepEqual(
    rows.map((row) => [row.session.id, row.section, row.unread]),
    [
      ["failed-unseen", "needs-you", false],
      ["failed-seen", "recent", false],
      ["finished-unseen", "recent", true],
    ],
  );
});

test("home lists Needs you, Working, Pinned, then projects in sidebar order; search is flat", () => {
  const s = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: id,
    updatedAt: "2026-11-10T10:00:00.000Z",
    preview: "",
    status: "idle" as const,
    hasUnseenUpdate: false,
    ...extra,
  });
  const sections = buildHome({
    workspaces: [
      { id: "a", name: "Alpha", path: "/a", kind: "primary", sessions: [s("a1"), s("a-run", { status: "running" })] },
      {
        id: "b",
        name: "Beta",
        path: "/b",
        kind: "primary",
        sessions: [
          s("b-old", { updatedAt: "2026-11-01T10:00:00.000Z", preview: "fix the parser" }),
          s("b-new", { lastInteractedAt: "2026-11-12T10:00:00.000Z" }),
          s("b-pin", { pinnedAt: "2026-11-10T10:00:00.000Z" }),
          s("b-child"),
        ],
      },
      { id: "bt", name: "Beta wt", path: "/bt", kind: "worktree", rootWorkspaceId: "b", sessions: [s("bt1")] },
    ],
    workspaceOrder: ["b", "a"],
    pinnedSessionOrder: ["b:b-pin"],
    sessionExtensionUiBySession: {
      "a:a1": { pendingDialogs: [{ kind: "input", requestId: "r", title: "Name?" }] },
    },
    orchestrationChildren: [
      {
        id: "c",
        title: "child",
        status: "complete",
        latestTranscript: "",
        parentWorkspaceId: "b",
        parentSessionId: "b-new",
        childWorkspaceId: "b",
        childSessionId: "b-child",
        updatedAt: "2026-11-10T10:00:00.000Z",
      },
    ],
  });
  assert.deepEqual(
    sections.map((section) => [section.title, section.rows.map((row) => row.session.id)]),
    [
      ["Needs you", ["a1"]],
      ["Working", ["a-run"]],
      ["Pinned", ["b-pin"]],
      ["Beta", ["b-new", "bt1", "b-old"]],
    ],
  );
  assert.equal(sections[3]?.rows[0]?.childCount, 1);
  const found = buildHome(
    { workspaces: [{ id: "b", name: "Beta", path: "/b", kind: "primary", sessions: [s("x", { preview: "Fix the parser" }), s("y")] }] },
    "parser",
  );
  assert.deepEqual(found.map((section) => [section.title, section.rows.map((row) => row.session.id)]), [["Results", ["x"]]]);
});

test("relative time is short", () => {
  const now = Date.parse("2026-11-23T12:00:00.000Z");
  assert.equal(relativeTime("2026-11-23T11:59:40.000Z", now), "now");
  assert.equal(relativeTime("2026-11-23T11:55:00.000Z", now), "5m");
  assert.equal(relativeTime("2026-11-23T09:00:00.000Z", now), "3h");
  assert.equal(relativeTime("2026-11-20T12:00:00.000Z", now), "3d");
  assert.equal(relativeTime("2026-11-02T12:00:00.000Z", now), "3w");
  assert.equal(relativeTime("bad", now), "");
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
        s("failed", { status: "failed", hasUnseenUpdate: true }),
        s("unseen", { hasUnseenUpdate: true }),
        s("archived", { archivedAt: "2026-11-10T09:00:00.000Z", hasUnseenUpdate: true }),
      ],
    },
  ]);
  assert.deepEqual(
    ordered.map((chat) => [chat.session.id, chat.section]),
    [
      ["failed", "needs-you"],
      ["running", "working"],
      ["unseen", "recent"],
      ["old", "recent"],
    ],
  );
});

test("a pending dialog puts a chat under Needs you, first in the list", () => {
  const s = (id: string) => ({
    id,
    title: id,
    updatedAt: "2026-11-10T10:00:00.000Z",
    preview: "",
    status: "idle" as const,
    hasUnseenUpdate: false,
  });
  const ordered = orderChats(
    [
      {
        id: "w",
        name: "pegasus",
        path: "D:/Pi/pi-gui",
        kind: "local",
        sessions: [s("quiet"), s("waiting")],
      },
    ],
    {
      "w:waiting": {
        pendingDialogs: [
          { kind: "confirm", requestId: "r1", title: "Run tests?", message: "pnpm test" },
        ],
      },
    },
  );
  assert.deepEqual(
    ordered.map((chat) => [chat.session.id, chat.section, chat.pendingDialogs.length]),
    [
      ["waiting", "needs-you", 1],
      ["quiet", "recent", 0],
    ],
  );
  const first = ordered[0];
  if (!first) throw new Error("expected at least one chat");
  assert.equal(waitingLabel(first.pendingDialogs), "Approval needed");
});

test("the waiting line names both kinds and counts the queue", () => {
  assert.equal(waitingLabel([]), null);
  assert.equal(
    waitingLabel([
      { kind: "select", requestId: "a", title: "Pick", options: ["one", "two"] },
      { kind: "input", requestId: "b", title: "Name", placeholder: "name" },
    ]),
    "Input · 2 waiting",
  );
  assert.equal(waitingLabel([{ kind: "editor", requestId: "a", title: "Edit" }]), "Input needed");
  assert.deepEqual(
    planStatus({
      subscription: true,
      planLimits: {
        provider: "Claude · work",
        reportedAt: "2026-11-13T10:00:00.000Z",
        limits: [
          { windowMinutes: 300, usedPercent: 12, resetsAt: "2026-11-13T15:00:00.000Z" },
          { windowMinutes: 10080, usedPercent: 94 },
        ],
      },
    }),
    { provider: "Claude · work", usedPercent: 94 },
  );
  assert.equal(planStatus({ subscription: false }), null);
});
