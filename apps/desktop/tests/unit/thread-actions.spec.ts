import { expect, test } from "@playwright/test";
import type { SessionRecord } from "../../contracts/desktop-state";
import {
  buildThreadActions,
  snoozeTimes,
  type ThreadActionHandlers,
} from "../../src/features/threads/thread-actions";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session-1",
    title: "Thread",
    updatedAt: "2026-09-23T00:00:00.000Z",
    preview: "",
    status: "idle",
    hasUnseenUpdate: false,
    ...overrides,
  };
}

function handlers(
  platform: NodeJS.Platform,
  scheduled = false,
): ThreadActionHandlers & { readonly calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    platform,
    hasScheduledTask: () => scheduled,
    startRename: record("rename"),
    setPinned: (_subject, pinned) => calls.push(`pin:${pinned}`),
    setSnoozed: (_subject, until) => calls.push(`snooze:${until ? "until" : "wake"}`),
    archive: record("archive"),
    restore: record("restore"),
    markRead: record("mark-read"),
    openScheduledTask: record("scheduled"),
    copySessionId: record("copy"),
  };
}

function titles(actions: readonly { readonly title: string }[]): string[] {
  return actions.map((action) => action.title);
}

test("an open thread lists rename, pin, archive, scheduled task and copy with shortcut hints", () => {
  const actions = buildThreadActions({ workspaceId: "ws", session: session() }, handlers("darwin"));
  expect(titles(actions)).toEqual([
    "Rename chat",
    "Pin chat",
    "Snooze for an hour",
    "Snooze until tomorrow",
    "Archive chat",
    "Add scheduled task…",
    "Copy session ID",
  ]);
  expect(actions.find((action) => action.id === "rename-thread")?.hint).toBe("⇧⌘R");
  expect(actions.find((action) => action.id === "archive-thread")?.hint).toBe("⇧⌘A");
  const linux = buildThreadActions({ workspaceId: "ws", session: session() }, handlers("linux"));
  expect(linux.find((action) => action.id === "archive-thread")?.hint).toBe("Ctrl+Shift+A");
});

test("state changes the list: pinned, unseen, scheduled and archived threads", () => {
  const recorder = handlers("linux", true);
  const actions = buildThreadActions(
    { workspaceId: "ws", session: session({ pinnedAt: "x", hasUnseenUpdate: true }) },
    recorder,
  );
  expect(titles(actions)).toEqual([
    "Rename chat",
    "Unpin chat",
    "Snooze for an hour",
    "Snooze until tomorrow",
    "Archive chat",
    "Mark as read",
    "Edit scheduled task…",
    "Copy session ID",
  ]);
  actions.find((action) => action.id === "pin-thread")?.run();
  actions.find((action) => action.id === "snooze-hour")?.run();
  expect(recorder.calls).toEqual(["pin:false", "snooze:until"]);

  // A snoozed chat offers to wake instead.
  const sleeping = buildThreadActions(
    { workspaceId: "ws", session: session({ snoozedUntil: "2026-11-11T09:00:00.000Z" }) },
    recorder,
  );
  expect(titles(sleeping)).toContain("Wake chat now");
  expect(titles(sleeping)).not.toContain("Snooze for an hour");
  sleeping.find((action) => action.id === "wake-thread")?.run();
  expect(recorder.calls.at(-1)).toBe("snooze:wake");

  const restored: Array<{ workspaceId: string; sessionId: string }> = [];
  const archivedSubject = {
    workspaceId: "workspace-native-id",
    session: session({ id: "session-native-id", archivedAt: "x" }),
  };
  const archived = buildThreadActions(archivedSubject, {
    ...handlers("linux"),
    restore: (subject) =>
      restored.push({ workspaceId: subject.workspaceId, sessionId: subject.session.id }),
  });
  expect(titles(archived)).toEqual([
    "Rename chat",
    "Unarchive chat",
    "Add scheduled task…",
    "Copy session ID",
  ]);
  expect(archived.some((action) => action.id === "archive-thread")).toBe(false);
  archived.find((action) => action.id === "restore-thread")?.run();
  expect(restored).toEqual([
    { workspaceId: "workspace-native-id", sessionId: "session-native-id" },
  ]);
});

test("snooze times are one hour from now and tomorrow at 9:00 local time", () => {
  const now = new Date(2026, 10, 10, 22, 30);
  const { hour, tomorrow } = snoozeTimes(now);
  expect(hour.getTime() - now.getTime()).toBe(60 * 60 * 1000);
  expect([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([11, 9, 0]);
});
