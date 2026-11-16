import type {
  PendingDialog,
  SessionExtensionUiState,
  SessionRecord,
  WorkspaceRecord,
} from "./types";

/**
 * Where a chat sits in the phone's list: like the desktop sidebar's Needs you / Working sections.
 * `sessionsNeedingOwner` (apps/desktop/contracts/session-attention.ts) decides "needs you" the same
 * way: a pending extension dialog, or a failure the owner has not opened yet.
 */
export type ChatSection = "needs-you" | "working" | "recent";

export interface ChatRow {
  readonly workspace: WorkspaceRecord;
  readonly session: SessionRecord;
  readonly section: ChatSection;
  /** Extension dialogs waiting on this chat, answered from the phone. */
  readonly pendingDialogs: readonly PendingDialog[];
}

/** The key `sessionExtensionUiBySession` uses. */
export function sessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

const SECTION_ORDER: Record<ChatSection, number> = { "needs-you": 0, working: 1, recent: 2 };

function sectionOf(session: SessionRecord, waiting: number): ChatSection {
  if (waiting > 0) return "needs-you";
  if (session.status === "failed" || (session.status !== "running" && session.hasUnseenUpdate)) {
    return "needs-you";
  }
  return session.status === "running" ? "working" : "recent";
}

/** Every unarchived chat, needs-you first, then running, then by last update (newest first). */
export function orderChats(
  workspaces: readonly WorkspaceRecord[],
  extensionUi: Readonly<Record<string, SessionExtensionUiState>> = {},
): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const workspace of workspaces) {
    for (const session of workspace.sessions) {
      if (session.archivedAt) continue;
      const pendingDialogs =
        extensionUi[sessionKey(workspace.id, session.id)]?.pendingDialogs ?? [];
      rows.push({
        workspace,
        session,
        section: sectionOf(session, pendingDialogs.length),
        pendingDialogs,
      });
    }
  }
  return rows.sort(
    (a, b) =>
      SECTION_ORDER[a.section] - SECTION_ORDER[b.section] ||
      b.pendingDialogs.length - a.pendingDialogs.length ||
      Date.parse(b.session.updatedAt) - Date.parse(a.session.updatedAt) ||
      a.session.id.localeCompare(b.session.id),
  );
}

export const SECTION_TITLES: Record<ChatSection, string> = {
  "needs-you": "Needs you",
  working: "Working",
  recent: "Recent",
};

/** The dialogs waiting on one chat, in the order the PC holds them (oldest first). */
export function pendingDialogsOf(
  extensionUi: Readonly<Record<string, SessionExtensionUiState>> | undefined,
  workspaceId: string,
  sessionId: string,
): readonly PendingDialog[] {
  return extensionUi?.[sessionKey(workspaceId, sessionId)]?.pendingDialogs ?? [];
}

/** What the phone is being asked for, in the row's one line. */
export function waitingLabel(dialogs: readonly PendingDialog[]): string | null {
  if (dialogs.length === 0) return null;
  const approval = dialogs.some((dialog) => dialog.kind === "confirm");
  const question = dialogs.some((dialog) => dialog.kind !== "confirm");
  const what = approval && question ? "Approval and input" : approval ? "Approval" : "Input";
  return dialogs.length > 1 ? `${what} · ${dialogs.length} waiting` : `${what} needed`;
}
