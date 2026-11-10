import type { SessionRecord, WorkspaceRecord } from "./types";

/** Where a chat sits in the phone's list: like the desktop sidebar's Needs you / Working sections. */
export type ChatSection = "needs-you" | "working" | "recent";

export interface ChatRow {
  readonly workspace: WorkspaceRecord;
  readonly session: SessionRecord;
  readonly section: ChatSection;
}

const SECTION_ORDER: Record<ChatSection, number> = { "needs-you": 0, working: 1, recent: 2 };

function sectionOf(session: SessionRecord): ChatSection {
  if (session.status === "failed" || (session.status !== "running" && session.hasUnseenUpdate)) {
    return "needs-you";
  }
  return session.status === "running" ? "working" : "recent";
}

/** Every unarchived chat, needs-you first, then running, then by last update (newest first). */
export function orderChats(workspaces: readonly WorkspaceRecord[]): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const workspace of workspaces) {
    for (const session of workspace.sessions) {
      if (session.archivedAt) continue;
      rows.push({ workspace, session, section: sectionOf(session) });
    }
  }
  return rows.sort(
    (a, b) =>
      SECTION_ORDER[a.section] - SECTION_ORDER[b.section] ||
      Date.parse(b.session.updatedAt) - Date.parse(a.session.updatedAt) ||
      a.session.id.localeCompare(b.session.id),
  );
}

export const SECTION_TITLES: Record<ChatSection, string> = {
  "needs-you": "Needs you",
  working: "Working",
  recent: "Recent",
};
