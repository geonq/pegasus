import { expect, test } from "@playwright/test";
import {
  attentionMessage,
  freshNeedsYou,
  threadKey,
} from "../../src/features/threads/attention-toast";
import type { ThreadListEntry } from "../../src/features/threads/thread-groups";

function entry(workspaceId: string, sessionId: string, title: string): ThreadListEntry {
  return {
    folderId: workspaceId,
    workspaceId,
    session: { id: sessionId, title } as ThreadListEntry["session"],
    environment: {} as ThreadListEntry["environment"],
    contextLabel: "",
  };
}

test("a chat that starts needing you is announced once, by its title", () => {
  const alpha = entry("ws", "a", "Builds");
  const beta = entry("ws", "b", "Deploy");
  const previous = new Set([threadKey(alpha)]);
  const fresh = freshNeedsYou(previous, [alpha, beta], undefined);
  expect(fresh.map((thread) => thread.session.id)).toEqual(["b"]);
  expect(attentionMessage(fresh)).toBe("Deploy needs you");
});

test("the chat already open is never announced", () => {
  const open = entry("ws", "open", "Open chat");
  expect(freshNeedsYou(new Set(), [open], "open")).toEqual([]);
});

test("several new chats collapse into one count instead of a notice each", () => {
  const fresh = freshNeedsYou(
    new Set(),
    [entry("ws", "a", "One"), entry("ws", "b", "Two"), entry("other", "c", "Three")],
    undefined,
  );
  expect(attentionMessage(fresh)).toBe("3 chats need you");
});

test("the same session in another folder is a different chat", () => {
  const first = entry("ws-1", "same", "First");
  const second = entry("ws-2", "same", "Second");
  const fresh = freshNeedsYou(new Set([threadKey(first)]), [first, second], undefined);
  expect(fresh.map((thread) => thread.workspaceId)).toEqual(["ws-2"]);
});

test("nothing new means no notice", () => {
  const alpha = entry("ws", "a", "Builds");
  expect(freshNeedsYou(new Set([threadKey(alpha)]), [alpha], undefined)).toEqual([]);
  expect(attentionMessage([])).toBe("");
});
