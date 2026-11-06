import { sessionKey, type SessionDriverEvent } from "@pi-gui/session-driver";
import type { DesktopAppState } from "../../contracts/desktop-state";
import type { NotificationStore } from "./notification-manager";

/**
 * The run events the notification manager acts on, read from two successive snapshots of the
 * Windows host. A remote client (the Mac) runs no sessions itself and receives only snapshots, so
 * its notification manager never heard that a chat finished, failed or waits for an answer.
 */
export function remoteNotificationEvents(
  previous: DesktopAppState | undefined,
  next: DesktopAppState,
  timestamp = new Date().toISOString(),
): SessionDriverEvent[] {
  if (!previous) return [];
  const before = new Map(
    previous.workspaces.flatMap((workspace) =>
      workspace.sessions.map((session) => [`${workspace.id}\0${session.id}`, session] as const),
    ),
  );
  const events: SessionDriverEvent[] = [];
  for (const workspace of next.workspaces) {
    for (const session of workspace.sessions) {
      const sessionRef = { workspaceId: workspace.id, sessionId: session.id };
      const was = before.get(`${workspace.id}\0${session.id}`);
      if (was?.status === "running" && session.status === "failed") {
        events.push({
          type: "runFailed",
          sessionRef,
          timestamp,
          error: { message: session.preview || "The run failed." },
        } as SessionDriverEvent);
      } else if (was?.status === "running" && session.status !== "running") {
        events.push({
          type: "runCompleted",
          sessionRef,
          timestamp,
          runId: `remote:${session.updatedAt}`,
          snapshot: { ref: sessionRef, title: session.title, status: session.status },
        } as unknown as SessionDriverEvent);
      }
      // Questions and warnings the chat has newly raised, as the host would announce them.
      const key = sessionKey(sessionRef);
      const now = next.sessionExtensionUiBySession[key];
      const then = previous.sessionExtensionUiBySession[key];
      const seenDialogs = new Set(then?.pendingDialogs.map((dialog) => dialog.requestId) ?? []);
      for (const request of now?.pendingDialogs ?? []) {
        if (!seenDialogs.has(request.requestId)) {
          events.push({
            type: "hostUiRequest",
            sessionRef,
            timestamp,
            request,
          } as SessionDriverEvent);
        }
      }
      const seenNotices = new Set(then?.notices.map((notice) => notice.id) ?? []);
      for (const notice of now?.notices ?? []) {
        if (!seenNotices.has(notice.id)) {
          events.push({
            type: "hostUiRequest",
            sessionRef,
            timestamp,
            request: {
              kind: "notify",
              requestId: notice.id,
              message: notice.message,
              level: notice.level,
            },
          } as SessionDriverEvent);
        }
      }
    }
  }
  return events;
}

/** A notification store for a remote client, fed by the host's snapshots. */
export function createRemoteNotificationStore(options: {
  readonly selectSession: NotificationStore["selectSession"];
}): NotificationStore & { readonly publish: (state: DesktopAppState) => void } {
  const stateListeners = new Set<Parameters<NotificationStore["subscribe"]>[0]>();
  const eventListeners = new Set<Parameters<NotificationStore["subscribeToSessionEvents"]>[0]>();
  let latest: DesktopAppState | undefined;
  return {
    subscribe(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    subscribeToSessionEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    selectSession: options.selectSession,
    publish(state) {
      const events = remoteNotificationEvents(latest, state);
      latest = state;
      for (const listener of stateListeners)
        void Promise.resolve(listener(state)).catch((error: unknown) => {
          console.error("[notifications] remote state listener failed", error);
        });
      for (const event of events)
        for (const listener of eventListeners)
          void Promise.resolve(listener(event, state)).catch((error: unknown) => {
            console.error("[notifications] remote event listener failed", error);
          });
    },
  };
}
