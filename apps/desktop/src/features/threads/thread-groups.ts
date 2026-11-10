import type {
  DesktopAppState,
  SessionRecord,
  ThreadGrouping,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import {
  compareByRecency,
  RECENCY_BUCKET_LABELS,
  RECENCY_BUCKET_ORDER,
  recencyBucketId,
  sessionLastInteractedAt,
  type RecencyBucketId,
} from "../../../contracts/thread-recency";

export interface ThreadEnvironmentMeta {
  readonly kind: "local" | "worktree";
  readonly label: string;
  readonly branchName?: string;
  readonly detached?: boolean;
}

export interface ThreadListEntry {
  readonly folderId: string;
  readonly workspaceId: string;
  readonly session: SessionRecord;
  readonly environment: ThreadEnvironmentMeta;
  readonly contextLabel: string;
  /** 1 for a subagent chat shown under the chat that started it. */
  readonly depth?: number;
  /** For a subagent chat: the thread key of the chat that started it. */
  readonly parentKey?: string;
  /** For a chat that started subagents: how many are listed under it. */
  readonly childCount?: number;
}

export interface WorkspaceThreadGroup {
  readonly workspace: WorkspaceRecord;
  readonly threads: readonly ThreadListEntry[];
}

export const THREAD_HISTORY_PREVIEW_LIMIT = 5;

/** The preview counts top-level chats only, so a chat keeps its subagent rows with it. */
export function threadHistoryPreview<T extends { readonly depth?: number }>(
  threads: readonly T[],
  expanded: boolean,
): { readonly visible: readonly T[]; readonly overflow: boolean } {
  let topLevel = 0;
  const cut = threads.findIndex(
    (thread) => !thread.depth && ++topLevel > THREAD_HISTORY_PREVIEW_LIMIT,
  );
  const overflow = cut !== -1;
  return {
    visible: overflow && !expanded ? threads.slice(0, cut) : threads,
    overflow,
  };
}

/** Drops the subagent rows of chats folded shut in the sidebar. */
export function foldChildThreads<T extends { readonly parentKey?: string }>(
  threads: readonly T[],
  collapsedParentKeys: ReadonlySet<string>,
): readonly T[] {
  if (collapsedParentKeys.size === 0) return threads;
  return threads.filter(
    (thread) => !thread.parentKey || !collapsedParentKeys.has(thread.parentKey),
  );
}

export function foldThreadSidebarModel(
  model: ThreadSidebarModel,
  collapsedParentKeys: ReadonlySet<string>,
): ThreadSidebarModel {
  if (collapsedParentKeys.size === 0) return model;
  const fold = (threads: readonly ThreadListEntry[]) =>
    foldChildThreads(threads, collapsedParentKeys);
  return {
    ...model,
    workspaceGroups: model.workspaceGroups.map((group) => ({
      ...group,
      threads: fold(group.threads),
    })),
    pinnedThreads: fold(model.pinnedThreads),
    needsYouThreads: fold(model.needsYouThreads),
    workingThreads: fold(model.workingThreads),
    recencySections: model.recencySections.map((section) => ({
      ...section,
      threads: fold(section.threads),
    })),
    recencyOrder: fold(model.recencyOrder),
  };
}

export interface RecencyThreadSection {
  readonly bucket: RecencyBucketId;
  readonly label: string;
  readonly threads: readonly ThreadListEntry[];
}

export interface ThreadSidebarModel {
  readonly folders: readonly WorkspaceRecord[];
  readonly workspaceGroups: readonly WorkspaceThreadGroup[];
  readonly pinnedThreads: readonly ThreadListEntry[];
  /** Unpinned chats that failed or finished with news the owner has not seen, newest first. */
  readonly needsYouThreads: readonly ThreadListEntry[];
  /** Unpinned chats that are running now, newest first. */
  readonly workingThreads: readonly ThreadListEntry[];
  /** Everything else unpinned, by recency bucket (Chats view only). */
  readonly recencySections: readonly RecencyThreadSection[];
  readonly archivedThreads: readonly ThreadListEntry[];
  readonly recencyOrder: readonly ThreadListEntry[];
}

/** A chat the owner has to look at: it failed, or it finished while they were away. */
export function sessionNeedsOwner(session: SessionRecord): boolean {
  return session.status === "failed" || (session.status !== "running" && session.hasUnseenUpdate);
}

/** Folder rows in Chats mode exist only for folders with an active chat. */
export function visibleWorkspaceGroups(
  model: Pick<ThreadSidebarModel, "workspaceGroups" | "recencyOrder">,
  grouping: ThreadGrouping,
): readonly WorkspaceThreadGroup[] {
  if (grouping === "workspace") return model.workspaceGroups;
  const activeFolderIds = new Set(model.recencyOrder.map((thread) => thread.folderId));
  return model.workspaceGroups.filter((group) => activeFolderIds.has(group.workspace.id));
}

export function buildThreadSidebarModel(
  state: DesktopAppState,
  nowMs: number = Date.now(),
): ThreadSidebarModel {
  const allEntries = collectThreadEntries(state);
  // Subagent chats are listed under the chat that started them, not as their own top-level chats.
  const nested = nestChildThreads(state, allEntries);
  const entries = allEntries.filter((entry) => !nested.childKeys.has(sessionThreadKey(entry)));
  const withChildren = nested.withChildren;
  const pinnedThreads = withChildren(
    entries
      .filter((entry) => !entry.session.archivedAt && Boolean(entry.session.pinnedAt))
      .sort((left, right) => comparePinnedThreads(left, right, state.pinnedSessionOrder)),
  );
  const historyThreads = entries
    .filter((entry) => !entry.session.archivedAt && !entry.session.pinnedAt)
    .sort((left, right) => compareByRecency(left.session, right.session));
  const needsYou = historyThreads.filter((entry) => sessionNeedsOwner(entry.session));
  const working = historyThreads.filter((entry) => entry.session.status === "running");
  const settled = historyThreads.filter(
    (entry) => !sessionNeedsOwner(entry.session) && entry.session.status !== "running",
  );
  const archivedThreads = allEntries
    .filter((entry) => Boolean(entry.session.archivedAt))
    .sort((left, right) => compareByRecency(left.session, right.session));
  const recencyOrder = withChildren(
    entries
      .filter((entry) => !entry.session.archivedAt)
      .sort((left, right) => compareByRecency(left.session, right.session)),
  );

  const folders = listFolders(state);
  return {
    folders,
    workspaceGroups: folders.map((workspace) => ({
      workspace,
      threads: withChildren(historyThreads.filter((entry) => entry.folderId === workspace.id)),
    })),
    pinnedThreads,
    needsYouThreads: withChildren(needsYou),
    workingThreads: withChildren(working),
    recencySections: RECENCY_BUCKET_ORDER.flatMap((bucket) => {
      const threads = settled.filter(
        (entry) => recencyBucketId(sessionLastInteractedAt(entry.session), nowMs) === bucket,
      );
      return threads.length > 0
        ? [{ bucket, label: RECENCY_BUCKET_LABELS[bucket], threads: withChildren(threads) }]
        : [];
    }),
    archivedThreads,
    recencyOrder,
  };
}

/**
 * Child chats (started by a parent's create_child_thread) whose parent is listed. `withChildren`
 * places each parent's unarchived children directly below it, newest first, at depth 1.
 */
function nestChildThreads(state: DesktopAppState, entries: readonly ThreadListEntry[]) {
  const byKey = new Map(entries.map((entry) => [sessionThreadKey(entry), entry] as const));
  const childrenByParent = new Map<string, ThreadListEntry[]>();
  const childKeys = new Set<string>();
  for (const child of state.orchestrationChildren) {
    const childKey = `${child.childWorkspaceId}:${child.childSessionId}`;
    const parentKey = `${child.parentWorkspaceId}:${child.parentSessionId}`;
    const entry = byKey.get(childKey);
    if (!entry || !byKey.has(parentKey) || childKey === parentKey) continue;
    childKeys.add(childKey);
    if (entry.session.archivedAt) continue;
    const siblings = childrenByParent.get(parentKey) ?? [];
    siblings.push({ ...entry, depth: 1, parentKey });
    childrenByParent.set(parentKey, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) => compareByRecency(left.session, right.session));
  }
  const withChildren = (threads: readonly ThreadListEntry[]): ThreadListEntry[] =>
    threads.flatMap((thread) => {
      const children = childrenByParent.get(sessionThreadKey(thread)) ?? [];
      return children.length > 0
        ? [{ ...thread, childCount: children.length }, ...children]
        : [thread];
    });
  return { childKeys, withChildren };
}

function listFolders(state: DesktopAppState): readonly WorkspaceRecord[] {
  const workspacesById = new Map(
    state.workspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const rootWorkspaces = state.workspaces.filter((workspace) => workspace.kind === "primary");
  const orphanWorktrees = state.workspaces.filter(
    (workspace) =>
      workspace.kind === "worktree" && !workspacesById.has(workspace.rootWorkspaceId ?? ""),
  );
  const order = state.workspaceOrder;
  const sortedRoots = [...rootWorkspaces].sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return -1;
    if (bi === -1) return 1;
    return ai - bi;
  });
  return [...sortedRoots, ...orphanWorktrees];
}

function collectThreadEntries(state: DesktopAppState): ThreadListEntry[] {
  const workspacesById = new Map(
    state.workspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const folders = listFolders(state);
  return folders.flatMap((folder) => {
    if (folder.kind !== "primary") {
      return folder.sessions.map((session) => ({
        folderId: folder.id,
        workspaceId: folder.id,
        session,
        environment: {
          kind: "worktree" as const,
          label: folder.name,
          branchName: folder.branchName,
          detached: !folder.branchName,
        },
        contextLabel: folder.name,
      }));
    }

    const linkedWorkspaces = (state.worktreesByWorkspace[folder.id] ?? [])
      .map((worktree) => ({
        worktree,
        workspace: worktree.linkedWorkspaceId
          ? workspacesById.get(worktree.linkedWorkspaceId)
          : undefined,
      }))
      .filter(
        (
          entry,
        ): entry is {
          worktree: NonNullable<(typeof state.worktreesByWorkspace)[string][number]>;
          workspace: WorkspaceRecord;
        } => Boolean(entry.workspace),
      );

    return [
      ...folder.sessions.map((session) => ({
        folderId: folder.id,
        workspaceId: folder.id,
        session,
        environment: {
          kind: "local" as const,
          label: "Local",
        },
        contextLabel: folder.name,
      })),
      ...linkedWorkspaces.flatMap(({ workspace, worktree }) =>
        workspace.sessions.map((session) => ({
          folderId: folder.id,
          workspaceId: workspace.id,
          session,
          environment: {
            kind: "worktree" as const,
            label: worktree.name,
            branchName: worktree.branchName,
            detached: !worktree.branchName,
          },
          contextLabel: `${folder.name} / ${worktree.name}`,
        })),
      ),
    ];
  });
}

export function sessionThreadKey(thread: ThreadListEntry): string {
  return `${thread.workspaceId}:${thread.session.id}`;
}

const EMPTY_EXPANDED_HISTORY: ReadonlySet<string> = new Set();

export function workspaceHistoryExpansionKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export function recencyHistoryExpansionKey(bucket: RecencyBucketId): string {
  return `bucket:${bucket}`;
}

export interface VisibleThreadShortcutOptions {
  readonly grouping: ThreadGrouping;
  readonly model: ThreadSidebarModel;
  readonly expandedHistory?: ReadonlySet<string>;
  readonly archivedOpen?: boolean;
  /** The Working section is folded shut in the Chats view; its rows are not on screen. */
  readonly workingFolded?: boolean;
  /** Folder groups folded shut in the sidebar; their rows are not on screen. */
  readonly collapsedWorkspaceIds?: readonly string[];
}

export function visibleThreadShortcutOrder(
  options: VisibleThreadShortcutOptions,
): readonly ThreadListEntry[] {
  const expandedHistory = options.expandedHistory ?? EMPTY_EXPANDED_HISTORY;
  const collapsedWorkspaceIds = new Set(options.collapsedWorkspaceIds ?? []);
  const unpinned =
    options.grouping === "workspace"
      ? options.model.workspaceGroups
          .filter((group) => !collapsedWorkspaceIds.has(group.workspace.id))
          .flatMap(
            (group) =>
              threadHistoryPreview(
                group.threads,
                expandedHistory.has(workspaceHistoryExpansionKey(group.workspace.id)),
              ).visible,
          )
      : options.model.recencySections.flatMap(
          (section) =>
            threadHistoryPreview(
              section.threads,
              expandedHistory.has(recencyHistoryExpansionKey(section.bucket)),
            ).visible,
        );
  const attention =
    options.grouping === "time"
      ? [
          ...options.model.needsYouThreads,
          ...(options.workingFolded ? [] : options.model.workingThreads),
        ]
      : [];
  return [
    ...options.model.pinnedThreads,
    ...attention,
    ...unpinned,
    ...(options.archivedOpen ? options.model.archivedThreads : []),
  ];
}

export function comparePinnedThreads(
  left: ThreadListEntry,
  right: ThreadListEntry,
  pinnedSessionOrder: readonly string[] = [],
): number {
  const order = new Map(pinnedSessionOrder.map((key, index) => [key, index] as const));
  const leftIndex = order.get(sessionThreadKey(left));
  const rightIndex = order.get(sessionThreadKey(right));
  if (leftIndex !== undefined || rightIndex !== undefined) {
    if (leftIndex === undefined) return 1;
    if (rightIndex === undefined) return -1;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  }
  const leftPinnedAt = left.session.pinnedAt ?? "";
  const rightPinnedAt = right.session.pinnedAt ?? "";
  if (leftPinnedAt !== rightPinnedAt) {
    return rightPinnedAt.localeCompare(leftPinnedAt);
  }
  return compareByRecency(left.session, right.session);
}
