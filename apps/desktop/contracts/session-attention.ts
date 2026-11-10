import type { DesktopAppState } from "./desktop-state";

export interface SessionNeedingOwner {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** `workspaceId:sessionId`, the key sessionExtensionUiBySession uses. */
  readonly key: string;
}

/**
 * Chats that need the owner: an extension dialog waits for an answer or approval, or the last
 * run failed and the failure has not been seen yet. The palette and the taskbar/Dock badge
 * read this one definition.
 */
export function sessionsNeedingOwner(
  state: Pick<DesktopAppState, "workspaces" | "sessionExtensionUiBySession">,
): readonly SessionNeedingOwner[] {
  const waiting: SessionNeedingOwner[] = [];
  for (const workspace of state.workspaces) {
    for (const session of workspace.sessions) {
      if (session.archivedAt) {
        continue;
      }
      const key = `${workspace.id}:${session.id}`;
      const dialogWaits = (state.sessionExtensionUiBySession[key]?.pendingDialogs.length ?? 0) > 0;
      if (dialogWaits || (session.status === "failed" && session.hasUnseenUpdate)) {
        waiting.push({ workspaceId: workspace.id, sessionId: session.id, key });
      }
    }
  }
  return waiting;
}
