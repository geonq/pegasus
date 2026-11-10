import { expect, test } from "@playwright/test";
import {
  createEmptyDesktopAppState,
  type DesktopAppState,
  type SessionRecord,
  type WorkspaceRecord,
  type WorktreeRecord,
} from "../../contracts/desktop-state";
import {
  buildThreadSidebarModel,
  foldThreadSidebarModel,
  recencyHistoryExpansionKey,
  sessionThreadKey,
  threadHistoryPreview,
  visibleThreadShortcutOrder,
  visibleWorkspaceGroups,
  workspaceHistoryExpansionKey,
} from "../../src/features/threads/thread-groups";

const now = new Date(2026, 8, 21, 15, 0, 0);
const nowMs = now.getTime();

function isoDaysAgo(days: number, hour = 12): string {
  return new Date(2026, 8, 21 - days, hour, 0, 0).toISOString();
}

function session(
  id: string,
  title: string,
  extra: Partial<SessionRecord> & { readonly updatedAt: string },
): SessionRecord {
  return {
    id,
    title,
    preview: "",
    status: "idle",
    hasUnseenUpdate: false,
    ...extra,
  };
}

function workspace(
  id: string,
  name: string,
  sessions: readonly SessionRecord[],
  extra: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    id,
    name,
    path: `/tmp/${name}`,
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    kind: "primary",
    sessions,
    ...extra,
  };
}

function state(
  workspaces: readonly WorkspaceRecord[],
  extra: Partial<DesktopAppState> = {},
): DesktopAppState {
  return {
    ...createEmptyDesktopAppState(),
    workspaces,
    workspaceOrder: workspaces.filter((entry) => entry.kind === "primary").map((entry) => entry.id),
    ...extra,
  };
}

test("omits empty date buckets and mixed-folder threads share one recency list", () => {
  const model = buildThreadSidebarModel(
    state([
      workspace("alpha", "Alpha", [
        session("today", "Today thread", { updatedAt: isoDaysAgo(0) }),
        session("older", "Older thread", { updatedAt: isoDaysAgo(40) }),
      ]),
      workspace("beta", "Beta", [session("week", "Week thread", { updatedAt: isoDaysAgo(2) })]),
    ]),
    nowMs,
  );

  expect(model.folders.map((folder) => folder.name)).toEqual(["Alpha", "Beta"]);
  expect(model.recencySections.map((section) => section.bucket)).toEqual([
    "today",
    "last-7-days",
    "older",
  ]);
  expect(
    model.recencySections.find((section) => section.bucket === "last-30-days"),
  ).toBeUndefined();
  expect(model.recencySections[0]?.threads.map((thread) => thread.session.title)).toEqual([
    "Today thread",
  ]);
  expect(model.recencySections[1]?.threads[0]?.contextLabel).toBe("Beta");
  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual([
    "Today thread",
    "Week thread",
    "Older thread",
  ]);
});

test("keeps pins out of date buckets even when the pin is the latest send", () => {
  const pinned = session("pin", "Pinned recent", {
    updatedAt: isoDaysAgo(8),
    lastInteractedAt: isoDaysAgo(0, 16),
    pinnedAt: isoDaysAgo(1),
  });
  const today = session("today", "Unpinned today", {
    updatedAt: isoDaysAgo(0, 10),
    lastInteractedAt: isoDaysAgo(0, 10),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [pinned, today])]),
    nowMs,
  );

  expect(model.pinnedThreads.map((thread) => thread.session.title)).toEqual(["Pinned recent"]);
  expect(model.recencySections.map((section) => section.bucket)).toEqual(["today"]);
  expect(model.recencySections[0]?.threads.map((thread) => thread.session.title)).toEqual([
    "Unpinned today",
  ]);
  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual([
    "Pinned recent",
    "Unpinned today",
  ]);
  expect(sessionThreadKey(model.recencyOrder[0]!)).toBe("alpha:pin");
});

test("puts a newer unpinned send ahead of an older pin in recencyOrder", () => {
  const pinned = session("pin", "Older pin", {
    updatedAt: isoDaysAgo(8),
    lastInteractedAt: isoDaysAgo(2),
    pinnedAt: isoDaysAgo(1),
  });
  const sent = session("send", "Newer send", {
    updatedAt: isoDaysAgo(0, 16),
    lastInteractedAt: isoDaysAgo(0, 16),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [pinned, sent])]),
    nowMs,
  );

  expect(model.pinnedThreads.map((thread) => thread.session.title)).toEqual(["Older pin"]);
  expect(model.recencySections[0]?.threads.map((thread) => thread.session.title)).toEqual([
    "Newer send",
  ]);
  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual([
    "Newer send",
    "Older pin",
  ]);
});

test("excludes archived threads from recencyOrder and date buckets", () => {
  const model = buildThreadSidebarModel(
    state([
      workspace("alpha", "Alpha", [
        session("live", "Live", { updatedAt: isoDaysAgo(0) }),
        session("archived", "Archived", {
          updatedAt: isoDaysAgo(0, 18),
          archivedAt: isoDaysAgo(0, 18),
        }),
      ]),
    ]),
    nowMs,
  );

  expect(model.archivedThreads.map((thread) => thread.session.title)).toEqual(["Archived"]);
  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual(["Live"]);
  expect(model.recencySections[0]?.threads.map((thread) => thread.session.title)).toEqual(["Live"]);
});

test("Chats hides empty and archived-only folders while Folders keeps every folder", () => {
  const model = buildThreadSidebarModel(
    state([
      workspace("active", "Active", [session("live", "Live", { updatedAt: isoDaysAgo(0) })]),
      workspace("archived", "Archived only", [
        session("old", "Old", {
          updatedAt: isoDaysAgo(2),
          archivedAt: isoDaysAgo(1),
        }),
      ]),
      workspace("empty", "Empty", []),
    ]),
    nowMs,
  );

  expect(visibleWorkspaceGroups(model, "time").map((group) => group.workspace.id)).toEqual([
    "active",
  ]);
  expect(visibleWorkspaceGroups(model, "workspace").map((group) => group.workspace.id)).toEqual([
    "active",
    "archived",
    "empty",
  ]);
  expect(model.archivedThreads.map((thread) => thread.session.id)).toEqual(["old"]);
});

test("does not let a newer lastViewedAt steal recency from lastInteractedAt", () => {
  const staleOpen = session("stale", "Stale open", {
    updatedAt: isoDaysAgo(3),
    lastInteractedAt: isoDaysAgo(3),
    lastViewedAt: isoDaysAgo(0, 18),
  });
  const recentSend = session("send", "Recent send", {
    updatedAt: isoDaysAgo(0, 8),
    lastInteractedAt: isoDaysAgo(0, 8),
    lastViewedAt: isoDaysAgo(10),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [staleOpen, recentSend])]),
    nowMs,
  );

  expect(model.recencyOrder.map((thread) => thread.session.title)).toEqual([
    "Recent send",
    "Stale open",
  ]);
  expect(model.recencySections.map((section) => section.bucket)).toEqual(["today", "last-7-days"]);
});

test("labels worktree sessions with folder context", () => {
  const root = workspace("root", "Repo", [
    session("local", "Local thread", { updatedAt: isoDaysAgo(0) }),
  ]);
  const worktreeWorkspace = workspace(
    "wt",
    "feature",
    [session("wt-thread", "Worktree thread", { updatedAt: isoDaysAgo(0, 11) })],
    { kind: "worktree", rootWorkspaceId: "root", branchName: "feature" },
  );
  const worktree: WorktreeRecord = {
    id: "wt-record",
    rootWorkspaceId: "root",
    linkedWorkspaceId: "wt",
    name: "feature",
    path: "/tmp/feature",
    status: "ready",
    branchName: "feature",
    updatedAt: isoDaysAgo(0),
  };
  const model = buildThreadSidebarModel(
    state([root, worktreeWorkspace], { worktreesByWorkspace: { root: [worktree] } }),
    nowMs,
  );

  const worktreeEntry = model.recencyOrder.find((thread) => thread.session.id === "wt-thread");
  expect(worktreeEntry?.contextLabel).toBe("Repo / feature");
  expect(worktreeEntry?.environment.kind).toBe("worktree");
  expect(worktreeEntry?.folderId).toBe("root");
  expect(
    model.workspaceGroups
      .find((group) => group.workspace.id === "root")
      ?.threads.map((thread) => thread.session.title),
  ).toEqual(["Local thread", "Worktree thread"]);
});

test("sorts a workspace folder by last user message, not catalog updatedAt", () => {
  const opened = session("opened", "Opened recently", {
    updatedAt: isoDaysAgo(0, 18),
    lastInteractedAt: isoDaysAgo(3),
  });
  const sent = session("sent", "Sent earlier today", {
    updatedAt: isoDaysAgo(4),
    lastInteractedAt: isoDaysAgo(0, 9),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [opened, sent])]),
    nowMs,
  );

  expect(model.workspaceGroups[0]?.threads.map((thread) => thread.session.title)).toEqual([
    "Sent earlier today",
    "Opened recently",
  ]);
});

test("numbers shortcut slots pinned first, then visible rows", () => {
  const olderPin = session("pin", "Older pin", {
    updatedAt: isoDaysAgo(8),
    lastInteractedAt: isoDaysAgo(2),
    pinnedAt: isoDaysAgo(1),
  });
  const newerSend = session("send", "Newer send", {
    updatedAt: isoDaysAgo(0, 16),
    lastInteractedAt: isoDaysAgo(0, 16),
  });
  const hidden = Array.from({ length: 5 }, (_, index) =>
    session(`extra-${index}`, `Extra ${index}`, {
      updatedAt: isoDaysAgo(0, 10 - index),
      lastInteractedAt: isoDaysAgo(0, 10 - index),
    }),
  );
  const week = session("week", "Week thread", {
    updatedAt: isoDaysAgo(3),
    lastInteractedAt: isoDaysAgo(3),
  });
  const archived = session("archived", "Archived", {
    updatedAt: isoDaysAgo(0, 18),
    lastInteractedAt: isoDaysAgo(0, 18),
    archivedAt: isoDaysAgo(0, 18),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [olderPin, newerSend, ...hidden, week, archived])], {
      pinnedSessionOrder: ["alpha:pin"],
    }),
    nowMs,
  );

  expect(model.recencyOrder[0]?.session.title).toBe("Newer send");
  expect(
    visibleThreadShortcutOrder({ grouping: "time", model }).map((thread) => thread.session.title),
  ).toEqual(["Older pin", "Newer send", "Extra 0", "Extra 1", "Extra 2", "Extra 3", "Week thread"]);
  expect(
    visibleThreadShortcutOrder({
      grouping: "time",
      model,
      expandedHistory: new Set([recencyHistoryExpansionKey("today")]),
    }).map((thread) => thread.session.title),
  ).toEqual([
    "Older pin",
    "Newer send",
    "Extra 0",
    "Extra 1",
    "Extra 2",
    "Extra 3",
    "Extra 4",
    "Week thread",
  ]);
  expect(
    visibleThreadShortcutOrder({ grouping: "time", model, archivedOpen: true }).at(-1)?.session
      .title,
  ).toBe("Archived");
});

test("numbers workspace rows after pins, skipping collapsed overflow", () => {
  const pin = session("pin", "Pinned", {
    updatedAt: isoDaysAgo(1),
    lastInteractedAt: isoDaysAgo(1),
    pinnedAt: isoDaysAgo(0),
  });
  const alphaThreads = Array.from({ length: 6 }, (_, index) =>
    session(`a-${index}`, `Alpha ${index}`, {
      updatedAt: isoDaysAgo(0, 12 - index),
      lastInteractedAt: isoDaysAgo(0, 12 - index),
    }),
  );
  const beta = session("b", "Beta thread", {
    updatedAt: isoDaysAgo(0, 8),
    lastInteractedAt: isoDaysAgo(0, 8),
  });
  const model = buildThreadSidebarModel(
    state(
      [workspace("alpha", "Alpha", [pin, ...alphaThreads]), workspace("beta", "Beta", [beta])],
      { pinnedSessionOrder: ["alpha:pin"] },
    ),
    nowMs,
  );

  expect(
    visibleThreadShortcutOrder({ grouping: "workspace", model }).map(
      (thread) => thread.session.title,
    ),
  ).toEqual(["Pinned", "Alpha 0", "Alpha 1", "Alpha 2", "Alpha 3", "Alpha 4", "Beta thread"]);
  expect(
    visibleThreadShortcutOrder({
      grouping: "workspace",
      model,
      expandedHistory: new Set([workspaceHistoryExpansionKey("alpha")]),
    }).map((thread) => thread.session.title),
  ).toEqual([
    "Pinned",
    "Alpha 0",
    "Alpha 1",
    "Alpha 2",
    "Alpha 3",
    "Alpha 4",
    "Alpha 5",
    "Beta thread",
  ]);
});

test("numbers workspace rows only for folders that are open", () => {
  const alpha = session("a", "Alpha thread", {
    updatedAt: isoDaysAgo(0, 12),
    lastInteractedAt: isoDaysAgo(0, 12),
  });
  const beta = session("b", "Beta thread", {
    updatedAt: isoDaysAgo(0, 8),
    lastInteractedAt: isoDaysAgo(0, 8),
  });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [alpha]), workspace("beta", "Beta", [beta])]),
    nowMs,
  );

  expect(
    visibleThreadShortcutOrder({
      grouping: "workspace",
      model,
      collapsedWorkspaceIds: ["alpha"],
    }).map((thread) => thread.session.title),
  ).toEqual(["Beta thread"]);
  // Time buckets have no folders to fold, so every row stays numbered.
  expect(
    visibleThreadShortcutOrder({
      grouping: "time",
      model,
      collapsedWorkspaceIds: ["alpha"],
    }).map((thread) => thread.session.title),
  ).toEqual(["Alpha thread", "Beta thread"]);
});

test("numbers visible rows in order when nothing is pinned", () => {
  const model = buildThreadSidebarModel(
    state([
      workspace("alpha", "Alpha", [
        session("today", "Today thread", { updatedAt: isoDaysAgo(0) }),
        session("older", "Older thread", { updatedAt: isoDaysAgo(40) }),
      ]),
    ]),
    nowMs,
  );

  expect(
    visibleThreadShortcutOrder({ grouping: "time", model }).map((thread) => thread.session.title),
  ).toEqual(["Today thread", "Older thread"]);
});

test("caps a history list at five until it is expanded", () => {
  const threads = ["1", "2", "3", "4", "5", "6"].map((id) => ({ id }));
  expect(threadHistoryPreview(threads, false)).toEqual({
    visible: threads.slice(0, 5),
    overflow: true,
  });
  expect(threadHistoryPreview(threads, true).visible).toEqual(threads);
  expect(threadHistoryPreview(threads.slice(0, 5), false).overflow).toBe(false);
});

test("the history cap counts top-level chats, keeping subagent rows with their chat", () => {
  const rows = [
    { id: "1" },
    { id: "1a", depth: 1 },
    { id: "1b", depth: 1 },
    { id: "2" },
    { id: "3" },
    { id: "4" },
    { id: "5" },
    { id: "5a", depth: 1 },
    { id: "6" },
  ];
  const preview = threadHistoryPreview(rows, false);
  expect(preview.overflow).toBe(true);
  expect(preview.visible.map((row) => row.id)).toEqual(["1", "1a", "1b", "2", "3", "4", "5", "5a"]);
  expect(threadHistoryPreview(rows.slice(0, 8), false).overflow).toBe(false);
});

test("subagent chats are listed under the chat that started them", () => {
  const parent = session("parent", "Parent chat", { updatedAt: isoDaysAgo(0, 10) });
  const child = session("child", "Planner task", { updatedAt: isoDaysAgo(0, 11) });
  const other = session("other", "Other chat", { updatedAt: isoDaysAgo(1) });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [parent, child, other])], {
      orchestrationChildren: [
        {
          id: "link",
          parentWorkspaceId: "alpha",
          parentSessionId: "parent",
          childWorkspaceId: "alpha",
          childSessionId: "child",
          title: "Planner task",
          goal: "",
          status: "running",
          latestTranscript: "",
          transcript: [],
          evidence: [],
        } as unknown as DesktopAppState["orchestrationChildren"][number],
      ],
    }),
    nowMs,
  );
  const rows = model.workspaceGroups[0]!.threads.map((entry) => [
    entry.session.id,
    entry.depth ?? 0,
  ]);
  expect(rows).toEqual([
    ["parent", 0],
    ["child", 1],
    ["other", 0],
  ]);
  expect(model.recencyOrder.map((entry) => entry.session.id)).toEqual(["parent", "child", "other"]);
});

test("a folded chat keeps its row and count but hides its subagent rows", () => {
  const parent = session("parent", "Parent chat", { updatedAt: isoDaysAgo(0, 10) });
  const child = session("child", "Planner task", { updatedAt: isoDaysAgo(0, 11) });
  const other = session("other", "Other chat", { updatedAt: isoDaysAgo(1) });
  const model = buildThreadSidebarModel(
    state([workspace("alpha", "Alpha", [parent, child, other])], {
      orchestrationChildren: [
        {
          id: "link",
          parentWorkspaceId: "alpha",
          parentSessionId: "parent",
          childWorkspaceId: "alpha",
          childSessionId: "child",
          title: "Planner task",
          status: "running",
        } as unknown as DesktopAppState["orchestrationChildren"][number],
      ],
    }),
    nowMs,
  );
  const parentRow = model.recencyOrder[0]!;
  expect(parentRow.childCount).toBe(1);
  expect(model.recencyOrder[1]!.parentKey).toBe(sessionThreadKey(parentRow));

  const folded = foldThreadSidebarModel(model, new Set([sessionThreadKey(parentRow)]));
  expect(folded.recencyOrder.map((entry) => entry.session.id)).toEqual(["parent", "other"]);
  expect(folded.workspaceGroups[0]!.threads.map((entry) => entry.session.id)).toEqual([
    "parent",
    "other",
  ]);
  expect(folded.recencySections.flatMap((s) => s.threads).map((e) => e.session.id)).toEqual([
    "parent",
    "other",
  ]);
  expect(foldThreadSidebarModel(model, new Set())).toBe(model);
});

test("failed, unseen and running chats leave the time buckets for Needs you and Working", () => {
  const model = buildThreadSidebarModel(
    state([
      workspace("alpha", "Alpha", [
        session("failed", "Failed run", { updatedAt: isoDaysAgo(9), status: "failed" }),
        session("unseen", "Finished away", { updatedAt: isoDaysAgo(3), hasUnseenUpdate: true }),
        session("running", "Busy", { updatedAt: isoDaysAgo(20), status: "running" }),
        session("runningUnseen", "Busy and news", {
          updatedAt: isoDaysAgo(21),
          status: "running",
          hasUnseenUpdate: true,
        }),
        session("plain", "Plain", { updatedAt: isoDaysAgo(1) }),
        session("pinned", "Pinned failed", {
          updatedAt: isoDaysAgo(1),
          status: "failed",
          pinnedAt: isoDaysAgo(1),
        }),
      ]),
    ]),
    nowMs,
  );
  expect(model.needsYouThreads.map((entry) => entry.session.id)).toEqual(["unseen", "failed"]);
  expect(model.workingThreads.map((entry) => entry.session.id)).toEqual([
    "running",
    "runningUnseen",
  ]);
  expect(model.pinnedThreads.map((entry) => entry.session.id)).toEqual(["pinned"]);
  expect(model.recencySections.flatMap((s) => s.threads).map((e) => e.session.id)).toEqual([
    "plain",
  ]);
  // Folder grouping keeps every unpinned chat under its folder.
  expect(model.workspaceGroups[0]!.threads).toHaveLength(5);
});

test("shortcut order follows the screen: pinned, needs you, working, then the buckets", () => {
  const model = buildThreadSidebarModel(
    state([
      workspace("alpha", "Alpha", [
        session("plain", "Plain", { updatedAt: isoDaysAgo(1) }),
        session("running", "Busy", { updatedAt: isoDaysAgo(2), status: "running" }),
        session("failed", "Failed", { updatedAt: isoDaysAgo(3), status: "failed" }),
        session("pinned", "Pinned", { updatedAt: isoDaysAgo(4), pinnedAt: isoDaysAgo(4) }),
      ]),
    ]),
    nowMs,
  );
  const ids = (workingFolded: boolean) =>
    visibleThreadShortcutOrder({ grouping: "time", model, workingFolded }).map(
      (entry) => entry.session.id,
    );
  expect(ids(false)).toEqual(["pinned", "failed", "running", "plain"]);
  expect(ids(true)).toEqual(["pinned", "failed", "plain"]);
  expect(
    visibleThreadShortcutOrder({ grouping: "workspace", model }).map((entry) => entry.session.id),
  ).toEqual(["pinned", "plain", "running", "failed"]);
});
