import type {
  DesktopAppState,
  PendingDialog,
  SessionExtensionUiState,
  SessionRecord,
  WorkspaceRecord,
} from "./types";

/**
 * Where a chat sits in the phone's list: like the desktop sidebar's Needs you / Working sections.
 * "Needs you" is exactly `sessionsNeedingOwner` (apps/desktop/contracts/session-attention.ts): a
 * pending extension dialog, or a failed run the owner has not seen. A chat that finished with news
 * is only unread (`ChatRow.unread`), not "needs you".
 */
export type ChatSection = "needs-you" | "working" | "recent";

export interface ChatRow {
  readonly workspace: WorkspaceRecord;
  readonly session: SessionRecord;
  readonly section: ChatSection;
  /** Finished with something the owner has not opened yet (and does not need them). */
  readonly unread: boolean;
  /** Extension dialogs waiting on this chat, answered from the phone. */
  readonly pendingDialogs: readonly PendingDialog[];
  /** Subagent chats this chat started (listed under it on the desktop, hidden here). */
  readonly childCount: number;
}

/** The key `sessionExtensionUiBySession` uses. */
export function sessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

const SECTION_ORDER: Record<ChatSection, number> = { "needs-you": 0, working: 1, recent: 2 };

function sectionOf(session: SessionRecord, waiting: number): ChatSection {
  if (waiting > 0 || (session.status === "failed" && session.hasUnseenUpdate)) return "needs-you";
  return session.status === "running" ? "working" : "recent";
}

/** When the owner last touched the chat, as the desktop sorts it (contracts/thread-recency.ts). */
function lastActive(session: SessionRecord): string {
  return session.lastInteractedAt ?? session.updatedAt;
}

function byRecency(a: ChatRow, b: ChatRow): number {
  const left = lastActive(a.session);
  const right = lastActive(b.session);
  return left === right ? a.session.title.localeCompare(b.session.title) : right.localeCompare(left);
}

function rowsOf(
  workspaces: readonly WorkspaceRecord[],
  extensionUi: Readonly<Record<string, SessionExtensionUiState>>,
  childCounts: ReadonlyMap<string, number> = new Map(),
): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const workspace of workspaces) {
    for (const session of workspace.sessions) {
      if (session.archivedAt) continue;
      const key = sessionKey(workspace.id, session.id);
      const pendingDialogs = extensionUi[key]?.pendingDialogs ?? [];
      const section = sectionOf(session, pendingDialogs.length);
      rows.push({
        workspace,
        session,
        section,
        unread: section === "recent" && session.hasUnseenUpdate,
        pendingDialogs,
        childCount: childCounts.get(key) ?? 0,
      });
    }
  }
  return rows;
}

/** Every unarchived chat, needs-you first, then running, then by last update (newest first). */
export function orderChats(
  workspaces: readonly WorkspaceRecord[],
  extensionUi: Readonly<Record<string, SessionExtensionUiState>> = {},
): ChatRow[] {
  return rowsOf(workspaces, extensionUi).sort(
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

export interface HomeSection {
  readonly key: string;
  readonly title: string;
  /** Set on a project's section: the project new chats from it start in. */
  readonly workspace?: WorkspaceRecord;
  readonly rows: readonly ChatRow[];
}

/** Projects the phone lists, in the desktop sidebar's order; worktrees fold into their project. */
export function projectsOf(state: Pick<DesktopAppState, "workspaces" | "workspaceOrder">) {
  const ids = new Set(state.workspaces.map((workspace) => workspace.id));
  const order = state.workspaceOrder ?? [];
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? -1 : index;
  };
  return state.workspaces
    .filter(
      (workspace) =>
        workspace.kind !== "worktree" || !ids.has(workspace.rootWorkspaceId ?? ""),
    )
    .map((workspace, index) => ({ workspace, index }))
    .sort((a, b) => rank(a.workspace.id) - rank(b.workspace.id) || a.index - b.index)
    .map(({ workspace }) => workspace);
}

/**
 * The home list, laid out like the desktop sidebar: Needs you, Working, Pinned, then one section per
 * project with its other chats, newest first. Subagent chats stay under the chat that started them
 * (only counted here). A search shows one flat "Results" section over titles, previews and projects.
 */
export function buildHome(
  state: Pick<
    DesktopAppState,
    | "workspaces"
    | "workspaceOrder"
    | "pinnedSessionOrder"
    | "sessionExtensionUiBySession"
    | "orchestrationChildren"
  >,
  query = "",
): HomeSection[] {
  const listed = new Set(
    state.workspaces.flatMap((workspace) =>
      workspace.sessions.map((session) => sessionKey(workspace.id, session.id)),
    ),
  );
  const childKeys = new Set<string>();
  const childCounts = new Map<string, number>();
  for (const child of state.orchestrationChildren ?? []) {
    const childKey = sessionKey(child.childWorkspaceId, child.childSessionId);
    const parentKey = sessionKey(child.parentWorkspaceId, child.parentSessionId);
    if (childKey === parentKey || !listed.has(childKey) || !listed.has(parentKey)) continue;
    childKeys.add(childKey);
    childCounts.set(parentKey, (childCounts.get(parentKey) ?? 0) + 1);
  }
  const all = rowsOf(state.workspaces, state.sessionExtensionUiBySession ?? {}, childCounts)
    .filter(
      (row) =>
        // A child that needs the owner or works still shows; otherwise its parent stands for it.
        row.section !== "recent" || !childKeys.has(sessionKey(row.workspace.id, row.session.id)),
    )
    .sort(byRecency);

  const needle = query.trim().toLowerCase();
  if (needle) {
    const rows = all.filter((row) =>
      [row.session.title, row.session.preview, row.workspace.name].some((field) =>
        field.toLowerCase().includes(needle),
      ),
    );
    return rows.length > 0 ? [{ key: "results", title: "Results", rows }] : [];
  }

  const sections: HomeSection[] = [];
  const push = (key: string, title: string, rows: readonly ChatRow[], workspace?: WorkspaceRecord) => {
    if (rows.length > 0) sections.push({ key, title, rows, ...(workspace ? { workspace } : {}) });
  };
  push(
    "needs-you",
    SECTION_TITLES["needs-you"],
    all
      .filter((row) => row.section === "needs-you")
      .sort((a, b) => b.pendingDialogs.length - a.pendingDialogs.length),
  );
  push("working", SECTION_TITLES.working, all.filter((row) => row.section === "working"));
  const pinOrder = state.pinnedSessionOrder ?? [];
  const pinRank = (row: ChatRow) => {
    const index = pinOrder.indexOf(sessionKey(row.workspace.id, row.session.id));
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const settled = all.filter((row) => row.section === "recent");
  push(
    "pinned",
    "Pinned",
    settled
      .filter((row) => row.session.pinnedAt)
      .sort(
        (a, b) =>
          pinRank(a) - pinRank(b) ||
          (b.session.pinnedAt ?? "").localeCompare(a.session.pinnedAt ?? ""),
      ),
  );
  const unpinned = settled.filter((row) => !row.session.pinnedAt);
  const ids = new Set(state.workspaces.map((workspace) => workspace.id));
  const projectOf = (workspace: WorkspaceRecord) =>
    workspace.kind === "worktree" && workspace.rootWorkspaceId && ids.has(workspace.rootWorkspaceId)
      ? workspace.rootWorkspaceId
      : workspace.id;
  for (const project of projectsOf(state)) {
    push(
      `project:${project.id}`,
      project.name,
      unpinned.filter((row) => projectOf(row.workspace) === project.id),
      project,
    );
  }
  return sections;
}

/** "now", "4m", "3h", "2d", "5w", "3mo", "2y": how long ago, in the row's corner. */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor(Math.max(0, nowMs - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

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
