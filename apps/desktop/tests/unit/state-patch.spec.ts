import { expect, test } from "@playwright/test";
import {
  createEmptyDesktopAppState,
  type DesktopAppState,
  type SessionRecord,
  type WorkspaceRecord,
} from "../../contracts/desktop-state";
import {
  applyDesktopStatePatch,
  diffDesktopState,
  type DesktopStatePatch,
} from "../../contracts/state-patch";
import { DesktopStateReplica } from "../../contracts/state-replica";

const session = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  title: `Chat ${id}`,
  updatedAt: "2026-11-12T00:00:00.000Z",
  preview: "",
  status: "idle",
  hasUnseenUpdate: false,
  ...extra,
});
const workspace = (id: string, sessions: SessionRecord[]): WorkspaceRecord => ({
  id,
  name: id,
  path: `/w/${id}`,
  lastOpenedAt: "2026-11-12T00:00:00.000Z",
  kind: "primary",
  sessions,
});
const base = (): DesktopAppState => ({
  ...createEmptyDesktopAppState(),
  revision: 1,
  workspaces: [
    workspace("a", [session("a1"), session("a2")]),
    workspace("b", [session("b1")]),
  ],
});
const next = (state: DesktopAppState, change: Partial<DesktopAppState>): DesktopAppState => ({
  ...state,
  ...change,
  revision: state.revision + 1,
});
const withSession = (
  state: DesktopAppState,
  workspaceId: string,
  sessionId: string,
  extra: Partial<SessionRecord>,
): DesktopAppState =>
  next(state, {
    workspaces: state.workspaces.map((entry) =>
      entry.id !== workspaceId
        ? entry
        : {
            ...entry,
            sessions: entry.sessions.map((s) => (s.id === sessionId ? { ...s, ...extra } : s)),
          },
    ),
  });

test("a streamed preview change patches one session and keeps every other object", () => {
  const before = base();
  const after = withSession(before, "a", "a1", { status: "running", preview: "tok" });
  const patch = diffDesktopState(before, after, 1)!;
  expect(patch.set).toEqual({});
  expect(patch.workspaces!.upserts).toHaveLength(1);
  expect(patch.workspaces!.upserts[0]!.sessions.map((s) => s.id)).toEqual(["a1"]);
  expect(patch.workspaces!.upserts[0]!.record).toBeUndefined();
  expect(JSON.stringify(patch).length).toBeLessThan(JSON.stringify(after).length / 2);

  const rebuilt = applyDesktopStatePatch(before, patch);
  expect(rebuilt).toEqual(after);
  // Untouched sessions and workspaces keep their identity: no selector on them fires.
  expect(rebuilt.workspaces[1]).toBe(before.workspaces[1]);
  expect(rebuilt.workspaces[0]!.sessions[1]).toBe(before.workspaces[0]!.sessions[1]);
  expect(rebuilt.workspaces[0]!.sessions[0]).not.toBe(before.workspaces[0]!.sessions[0]);
});

test("running status and preview are never hidden: they are in the patch", () => {
  const before = base();
  const after = withSession(before, "a", "a2", { status: "running", preview: "hello" });
  const patch = diffDesktopState(before, after, 1)!;
  const sent = patch.workspaces!.upserts[0]!.sessions[0]!;
  expect(sent).toMatchObject({ id: "a2", status: "running", preview: "hello" });
});

test("a revision-only change sends nothing", () => {
  const before = base();
  expect(diffDesktopState(before, { ...before, revision: 2 }, 1)).toBeNull();
});

test("record-valued keys patch by entry and deletions are carried", () => {
  const before = next(base(), { lastViewedAtBySession: { a1: "x", a2: "y" } });
  const after = next(before, { lastViewedAtBySession: { a1: "z" } });
  const patch = diffDesktopState(before, after, 1)!;
  expect(patch.maps.lastViewedAtBySession).toEqual({ set: { a1: "z" }, del: ["a2"] });
  expect(applyDesktopStatePatch(before, patch)).toEqual(after);
});

test("added, removed and reordered workspaces and sessions round-trip", () => {
  let state = base();
  const steps: DesktopAppState[] = [];
  state = next(state, { workspaces: [...state.workspaces, workspace("c", [session("c1")])] });
  steps.push(state);
  state = next(state, { workspaces: [state.workspaces[2]!, state.workspaces[0]!, state.workspaces[1]!] });
  steps.push(state);
  state = next(state, {
    workspaces: state.workspaces.map((w) =>
      w.id === "a" ? { ...w, sessions: [w.sessions[1]!, session("a3"), w.sessions[0]!] } : w,
    ),
  });
  steps.push(state);
  state = next(state, { workspaces: state.workspaces.filter((w) => w.id !== "b") });
  steps.push(state);
  state = next(state, {
    workspaces: state.workspaces.map((w) => (w.id === "c" ? { ...w, name: "renamed" } : w)),
  });
  steps.push(state);
  let client = base();
  let previous = base();
  for (const step of steps) {
    const patch = diffDesktopState(previous, step, 1)!;
    client = applyDesktopStatePatch(client, patch);
    expect(client).toEqual(step);
    previous = step;
  }
});

test("random edits: the replica equals main after every patch", () => {
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let main = base();
  const replica = new DesktopStateReplica();
  replica.push(main);
  let sequence = 0;
  for (let i = 0; i < 300; i += 1) {
    const w = main.workspaces[random(main.workspaces.length)]!;
    const s = w.sessions[random(w.sessions.length)];
    const kind = random(6);
    let after: DesktopAppState;
    if (kind === 0 && s) after = withSession(main, w.id, s.id, { preview: `p${i}`, status: "running" });
    else if (kind === 1 && s) after = withSession(main, w.id, s.id, { status: "idle", hasUnseenUpdate: true });
    else if (kind === 2)
      after = next(main, { lastViewedAtBySession: { ...main.lastViewedAtBySession, [`k${random(5)}`]: `${i}` } });
    else if (kind === 3)
      after = next(main, {
        workspaces: main.workspaces.map((x) =>
          x.id === w.id ? { ...x, sessions: [...x.sessions, session(`n${i}`)] } : x,
        ),
      });
    else if (kind === 4) after = next(main, { composerDraft: `draft ${i}` });
    else after = { ...main, revision: main.revision + 1 };
    const patch = diffDesktopState(main, after, ++sequence);
    main = after;
    if (patch) expect(replica.push(patch)).toBe("applied");
    else sequence -= 1;
    // A client that has only the revision of the last patch is as current as main's content.
    expect({ ...replica.state, revision: 0 }).toEqual({ ...main, revision: 0 });
  }
});

test("a patch that does not fit asks for a full state; patches arriving meanwhile apply after it", () => {
  const s1 = base();
  const s2 = withSession(s1, "a", "a1", { preview: "1" });
  const s3 = withSession(s2, "a", "a1", { preview: "2" });
  const s4 = withSession(s3, "a", "a1", { preview: "3" });
  const p2 = diffDesktopState(s1, s2, 1)!;
  const p3 = diffDesktopState(s2, s3, 2)!;
  const p4 = diffDesktopState(s3, s4, 3)!;
  const replica = new DesktopStateReplica();
  replica.push(s1);
  // p2 is lost; p3 does not fit.
  expect(replica.push(p3)).toBe("resync");
  expect(replica.push(p4)).toBe("applied");
  // The pull returns the state main had when it answered (s3); p4 follows it.
  void p2;
  expect(replica.pulled(s3)).toBe("applied");
  expect(replica.state).toEqual(s4);
});

test("a duplicate or stale patch cannot roll the replica back", () => {
  const s1 = base();
  const s2 = withSession(s1, "a", "a1", { preview: "1" });
  const p2 = diffDesktopState(s1, s2, 1)!;
  const replica = new DesktopStateReplica();
  replica.push(s1);
  replica.push(p2);
  expect(replica.push(p2)).toBe("resync");
  expect(replica.pulled(s2)).toBe("applied");
  expect(replica.state).toEqual(s2);
});

test("an action reply ahead of the stream is kept and the late patch does not undo it", () => {
  const s1 = base();
  const s2 = withSession(s1, "a", "a1", { preview: "1" });
  const s3 = withSession(s2, "b", "b1", { title: "renamed" });
  const p2 = diffDesktopState(s1, s2, 1)!;
  const p3 = diffDesktopState(s2, s3, 2)!;
  const replica = new DesktopStateReplica();
  replica.push(s1);
  replica.adopt(s3);
  expect(replica.push(p2)).toBe("applied");
  expect(replica.push(p3)).toBe("applied");
  expect(replica.state).toEqual(s3);
});

test("a full state restarts the stream", () => {
  const s1 = base();
  const s5 = { ...withSession(s1, "a", "a1", { preview: "x" }), revision: 5 };
  const s6 = { ...withSession(s5, "a", "a1", { preview: "y" }), revision: 6 };
  const replica = new DesktopStateReplica();
  replica.push(s1);
  replica.push(s5);
  const patch: DesktopStatePatch = diffDesktopState(s5, s6, 1)!;
  expect(replica.push(patch)).toBe("applied");
  expect(replica.state).toEqual(s6);
});
