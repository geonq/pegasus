// node --test --experimental-strip-types src/api/phone-ux.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { photoName } from "../features/chat/photo-name.ts";
import { homeItems } from "../features/home/home-items.ts";
import { menuActions, menuItemById, type MenuSection } from "../ui/menu-model.ts";
import { buildHome } from "./chats.ts";
import { initialLiveState, reduceLive } from "./live-state.ts";
import { TranscriptCache, transcriptFor } from "./transcript-cache.ts";
import type { DesktopAppState, SelectedTranscript, SessionRecord } from "./types.ts";

const session = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  title: id,
  updatedAt: "2026-11-20T10:00:00.000Z",
  preview: "",
  status: "idle",
  hasUnseenUpdate: false,
  ...extra,
});

const transcript = (sessionId: string, text = "hi"): SelectedTranscript => ({
  workspaceId: "w",
  sessionId,
  transcript: [{ kind: "message", id: `${sessionId}-1`, role: "user", text } as never],
});

test("a reopened chat draws its cached transcript, marked stale, until the live one is its own", () => {
  const cache = new TranscriptCache();
  cache.remember(transcript("a", "old"));
  const other = transcript("b");
  const cached = transcriptFor(other, cache, "w", "a");
  assert.equal(cached.stale, true);
  assert.equal(cached.transcript?.sessionId, "a");
  const live = transcript("a", "new");
  assert.deepEqual(transcriptFor(live, cache, "w", "a"), { transcript: live, stale: false });
  assert.deepEqual(transcriptFor(null, cache, "w", "never"), { transcript: null, stale: false });
});

test("the transcript cache keeps the most recently seen chats only", () => {
  const cache = new TranscriptCache(2);
  cache.remember(transcript("a"));
  cache.remember(transcript("b"));
  cache.remember(transcript("a", "again")); // a is now the newest
  cache.remember(transcript("c"));
  assert.equal(cache.get("w", "b"), undefined);
  assert.equal(cache.get("w", "a")?.transcript.length, 1);
  assert.ok(cache.get("w", "c"));
  cache.remember(null);
  cache.clear();
  assert.equal(cache.get("w", "c"), undefined);
});

const stateWith = (
  revision: number,
  workspaces: DesktopAppState["workspaces"],
): DesktopAppState => ({
  revision,
  workspaces,
  selectedWorkspaceId: "w",
  selectedSessionId: "",
});

test("a project created on the PC after pairing shows up from the next live state, even empty", () => {
  let live = reduceLive(initialLiveState, { kind: "streamOpened" }).live;
  const first = stateWith(1, [
    { id: "w", name: "pegasus", path: "/w", kind: "primary", sessions: [session("s")] },
  ]);
  live = reduceLive(live, { kind: "event", event: { type: "stateChanged", state: first } }).live;
  const second = stateWith(2, [
    ...first.workspaces,
    { id: "n", name: "new-project", path: "/n", kind: "primary", sessions: [] },
  ]);
  live = reduceLive(live, { kind: "event", event: { type: "stateChanged", state: second } }).live;
  assert.ok(live.state);
  const items = homeItems(buildHome(live.state));
  assert.deepEqual(
    items.map((item) => [item.kind, item.key]),
    [
      ["header", "h:project:w"],
      ["chat", "project:w/w/s"],
      ["header", "h:project:n"],
      ["placeholder", "p:n"],
    ],
  );
  const header = items.find((item) => item.key === "h:project:n");
  assert.equal(header?.kind === "header" ? header.workspaceId : undefined, "n");
});

test("status sections carry an icon and a count; project rows do not name their project", () => {
  const items = homeItems(
    buildHome(
      stateWith(1, [
        {
          id: "w",
          name: "pegasus",
          path: "/w",
          kind: "primary",
          sessions: [session("run", { status: "running" }), session("idle")],
        },
      ]),
    ),
  );
  const working = items[0];
  assert.equal(working?.kind, "header");
  if (working?.kind === "header") {
    assert.equal(working.icon, "circle.dotted");
    assert.equal(working.count, 1);
  }
  // The project's chats are listed, so it gets no "no chats yet" placeholder.
  assert.equal(
    items.some((item) => item.kind === "placeholder"),
    false,
  );
  const rows = items.filter((item) => item.kind === "chat");
  assert.deepEqual(
    rows.map((row) => (row.kind === "chat" ? [row.row.session.id, row.showProject] : null)),
    [
      ["run", true],
      ["idle", false],
    ],
  );
  // A search with no hits has no sections at all, so the empty state can say so.
  assert.deepEqual(homeItems(buildHome(stateWith(1, []), "nothing")), []);
});

test("menus: one untitled section stays flat, several become inline groups; disabled items do not fire", () => {
  let fired = "";
  const sections: MenuSection[] = [
    {
      items: [
        { id: "pin", label: "Pin", icon: "pin", onPress: () => (fired = "pin") },
        { id: "off", label: "Off", disabled: true, onPress: () => (fired = "off") },
      ],
    },
    {
      title: "Danger",
      items: [{ id: "archive", label: "Archive", destructive: true, onPress: () => undefined }],
    },
    { items: [] },
  ];
  const tree = menuActions(sections);
  assert.equal(tree.length, 2);
  assert.equal(tree[0]?.displayInline, true);
  assert.deepEqual(tree[1]?.subactions?.[0]?.attributes, { destructive: true });
  assert.deepEqual(
    menuActions([sections[0] as MenuSection]).map((action) => action.id),
    ["pin", "off"],
  );
  menuItemById(sections, "pin")?.onPress();
  assert.equal(fired, "pin");
  assert.equal(menuItemById(sections, "off"), undefined);
  assert.equal(menuItemById(sections, "missing"), undefined);
  const picker = menuActions([
    { items: [{ id: "a", label: "A", selected: true, onPress: () => undefined }] },
  ]);
  assert.equal(picker[0]?.state, "on");
});

test("photo names keep the library name as .jpg, else the time, numbered within one pick", () => {
  const at = new Date(2026, 10, 24, 9, 5).getTime();
  assert.equal(photoName("IMG_0042.HEIC", at), "IMG_0042.jpg");
  assert.equal(photoName("  ", at), "Photo 09:05.jpg");
  assert.equal(photoName(null, at, 2), "Photo 09:05 (3).jpg");
  assert.equal(photoName("archive.tar.gz", at), "archive.tar.jpg");
});
