import { expect, test } from "@playwright/test";
import { createEmptyDesktopAppState, type DesktopAppState } from "../../contracts/desktop-state";
import {
  createRemoteNotificationStore,
  remoteNotificationEvents,
} from "../../electron/platform/remote-notification-source";

test("rejected async notification listeners are handled without losing later notifications", async () => {
  const store = createRemoteNotificationStore({ selectSession: async () => snapshot({}) });
  const errors: unknown[][] = [];
  const previous = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  let delivered = 0;
  try {
    store.subscribeToSessionEvents(async () => {
      throw new Error("event listener failed");
    });
    store.subscribeToSessionEvents(() => {
      delivered++;
    });
    store.publish(snapshot({ a: "running" }));
    store.publish(snapshot({ a: "idle" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delivered).toBe(1);
    expect(errors).toHaveLength(1);
  } finally {
    console.error = previous;
  }
});

function snapshot(
  sessions: Record<string, "running" | "idle" | "failed">,
  ui: DesktopAppState["sessionExtensionUiBySession"] = {},
): DesktopAppState {
  return {
    ...createEmptyDesktopAppState(),
    workspaces: [
      {
        id: "D:\\Pi\\projects\\sprintline",
        name: "sprintline",
        sessions: Object.entries(sessions).map(([id, status]) => ({
          id,
          title: `Chat ${id}`,
          status,
          updatedAt: "2026-10-24T17:00:00.000Z",
          preview: status === "failed" ? "Claude rejected the request." : "",
        })),
      },
    ],
    sessionExtensionUiBySession: ui,
  } as unknown as DesktopAppState;
}

const key = (sessionId: string) => `D:\\Pi\\projects\\sprintline:${sessionId}`;

test("the first snapshot from the host notifies nothing", () => {
  expect(remoteNotificationEvents(undefined, snapshot({ a: "idle" }))).toEqual([]);
});

test("a chat the host finished or failed becomes the run event the Mac notifies about", () => {
  const events = remoteNotificationEvents(
    snapshot({ a: "running", b: "running", c: "idle" }),
    snapshot({ a: "idle", b: "failed", c: "idle" }),
  );
  expect(events.map((event) => [event.type, event.sessionRef.sessionId])).toEqual([
    ["runCompleted", "a"],
    ["runFailed", "b"],
  ]);
  expect(events[0]).toMatchObject({ snapshot: { title: "Chat a" } });
  expect(events[1]).toMatchObject({ error: { message: "Claude rejected the request." } });
  // A chat that keeps running, or stays idle, says nothing.
  expect(remoteNotificationEvents(snapshot({ a: "running" }), snapshot({ a: "running" }))).toEqual(
    [],
  );
});

test("a new approval question or warning notifies once; one already shown does not", () => {
  const dialog = { kind: "confirm", requestId: "q1", title: "Allow command?", message: "git push" };
  const ui = (dialogs: unknown[], notices: unknown[]) =>
    ({
      [key("a")]: { instanceId: "i", statuses: [], widgets: [], pendingDialogs: dialogs, notices },
    }) as unknown as DesktopAppState["sessionExtensionUiBySession"];
  const warning = {
    id: "n1",
    level: "warning",
    message: "Opus 5.5 is unavailable.",
    createdAt: "",
  };
  const before = snapshot({ a: "running" }, ui([], []));
  const after = snapshot({ a: "running" }, ui([dialog], [warning]));
  const events = remoteNotificationEvents(before, after);
  expect(events).toMatchObject([
    { type: "hostUiRequest", request: { kind: "confirm", title: "Allow command?" } },
    { type: "hostUiRequest", request: { kind: "notify", level: "warning" } },
  ]);
  expect(remoteNotificationEvents(after, after)).toEqual([]);
});
