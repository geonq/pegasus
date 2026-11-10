import {
  createContext,
  memo,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  AppView,
  SessionRecord,
  ThreadGrouping,
  WorkspaceRecord,
  WorktreeRecord,
} from "../../../contracts/desktop-state";
import {
  ArchiveIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExtensionIcon,
  FolderIcon,
  ForkIcon,
  MoreIcon,
  UsageIcon,
  PinIcon,
  PlusIcon,
  RestoreIcon,
  SettingsIcon,
  SkillIcon,
  ClockIcon,
  WorktreeIcon,
  AppBrand,
} from "../../ui/icons";
import {
  getDesktopShortcutLabel,
  THREAD_SHORTCUT_SLOT_COUNT,
  type PiDesktopApi,
} from "../../../contracts/ipc";
import { formatRelativeTime } from "../../lib/string-utils";
import { useStableHandlers } from "../../lib/use-stable-handlers";
import { PaneResizeHandle, type PaneWidthBounds } from "../../ui/pane-resize-handle";
import { usePersistedPaneWidth } from "../../ui/use-persisted-pane-width";
import { sessionLastInteractedAt } from "../../../contracts/thread-recency";
import type { WorkspaceMenuState } from "./hooks/use-workspace-menu";
import type { ThreadMenuState } from "./hooks/use-thread-actions";
import { archiveThreadShortcut, ThreadActionsMenu } from "./thread-actions";
import { type ChatFoldMotion, useFoldedChatParents } from "./chat-fold";
import {
  foldThreadSidebarModel,
  recencyHistoryExpansionKey,
  sessionThreadKey,
  threadHistoryPreview,
  visibleThreadShortcutOrder,
  visibleWorkspaceGroups,
  workspaceHistoryExpansionKey,
  type RecencyThreadSection,
  type ThreadSidebarModel,
  type ThreadListEntry,
} from "./thread-groups";
import { UndoToastHost } from "./undo-toast";
import { useThreadShortcutHintsVisible } from "./thread-shortcut-hints";
import { useSignIns } from "../usage/account-state";
import { UpdateBanner } from "../updates/update-banner";
import type { Dispatch, SetStateAction } from "react";
import type { DesktopAppState } from "../../../contracts/desktop-state";

interface SidebarProps {
  readonly activeView: AppView;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly visibleWorkspaces: readonly WorkspaceRecord[];
  readonly threadSidebarModel: ThreadSidebarModel;
  readonly threadGrouping: ThreadGrouping;
  readonly collapsedWorkspaceIds: readonly string[];
  readonly linkedWorktreeByWorkspaceId: ReadonlyMap<string, WorktreeRecord>;
  readonly wsMenu: WorkspaceMenuState;
  readonly threadMenu: ThreadMenuState;
  readonly api: PiDesktopApi;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
  readonly onNewThread: (workspaceId?: string) => void;
  readonly onBrowseFiles: () => void;
  readonly onSetActiveView: (view: AppView) => void;
  readonly onOpenSkills: (workspaceId?: string) => void;
  readonly onOpenExtensions: (workspaceId?: string) => void;
  readonly onOpenSettings: (workspaceId?: string) => void;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
  readonly onUnarchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly threadShortcutOrderRef: MutableRefObject<readonly ThreadListEntry[] | null>;
}

const SIDEBAR_WIDTH_RANGE = { min: 200, max: 520 } as const;

function sidebarWidthBounds(_sidebar: HTMLElement, shell: HTMLElement): PaneWidthBounds {
  return {
    min: SIDEBAR_WIDTH_RANGE.min,
    max: Math.floor(Math.min(SIDEBAR_WIDTH_RANGE.max, shell.clientWidth * 0.45)),
  };
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

interface ThreadShortcutBadge {
  readonly slot: number;
  readonly label: string;
}

const ThreadShortcutContext = createContext<ReadonlyMap<string, ThreadShortcutBadge> | undefined>(
  undefined,
);

interface ChatFold {
  readonly folded: ReadonlySet<string>;
  readonly motion: ChatFoldMotion;
  readonly setFolded: (parentKey: string, folded: boolean) => void;
}

const ChatFoldContext = createContext<ChatFold | undefined>(undefined);

/**
 * App re-renders on every composer keystroke and stream update and hands over fresh closures
 * each time; the thread list only needs to render again when its data changes.
 */
export function Sidebar(props: SidebarProps) {
  const wsMenu = useStableHandlers(props.wsMenu);
  const threadMenu = useStableHandlers(props.threadMenu);
  return <SidebarContent {...useStableHandlers({ ...props, wsMenu, threadMenu })} />;
}

const SidebarContent = memo(function SidebarContent(props: SidebarProps) {
  const signInNeedsOwner = useSignIns().some((signIn) => signIn.state !== "ok");
  const {
    activeView,
    selectedWorkspace,
    selectedSession,
    visibleWorkspaces,
    threadSidebarModel: unfoldedSidebarModel,
    threadGrouping,
    collapsedWorkspaceIds,
    linkedWorktreeByWorkspaceId,
    wsMenu,
    threadMenu,
    api,
    setSnapshot,
    updateSnapshot,
    onNewThread,
    onBrowseFiles,
    onSetActiveView,
    onOpenSkills,
    onOpenExtensions,
    onOpenSettings,
    onArchiveSession,
    onSelectSession,
    onSetSessionPinned,
    onUnarchiveSession,
    threadShortcutOrderRef,
  } = props;

  const [sidebarWidth, setSidebarWidth] = usePersistedPaneWidth(
    "pi-gui.sidebar-width",
    SIDEBAR_WIDTH_RANGE,
  );
  const sidebarWidthStyle: (CSSProperties & { "--sidebar-width": string }) | undefined =
    sidebarWidth === undefined ? undefined : { "--sidebar-width": `${sidebarWidth}px` };
  const [activeId, setActiveId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [workingFolded, setWorkingFolded] = useState(false);
  const [foldedChatParents, setChatParentFolded, chatFoldMotion] = useFoldedChatParents();
  const chatFold: ChatFold = {
    folded: foldedChatParents,
    motion: chatFoldMotion,
    setFolded: setChatParentFolded,
  };
  const threadSidebarModel = foldThreadSidebarModel(unfoldedSidebarModel, foldedChatParents);
  const [expandedHistory, setExpandedHistory] = useState<ReadonlySet<string>>(() => new Set());
  const commandHeld = useThreadShortcutHintsVisible(api.platform);
  const collapsedFolderIds = new Set(collapsedWorkspaceIds);
  const setFolderCollapsed = (workspaceId: string, collapsed: boolean) => {
    void updateSnapshot(setSnapshot, () => api.setWorkspaceCollapsed(workspaceId, collapsed)).catch(
      (error: unknown) => {
        console.error("[renderer] setWorkspaceCollapsed failed", error);
      },
    );
  };
  const shortcutOrder = visibleThreadShortcutOrder({
    grouping: threadGrouping,
    model: threadSidebarModel,
    expandedHistory,
    archivedOpen,
    workingFolded,
    collapsedWorkspaceIds,
  });
  threadShortcutOrderRef.current = shortcutOrder;
  const shortcutByKey = commandHeld
    ? new Map(
        shortcutOrder.slice(0, THREAD_SHORTCUT_SLOT_COUNT).map((thread, index) => {
          const slot = index + 1;
          return [
            sessionThreadKey(thread),
            { slot, label: getDesktopShortcutLabel(api.platform, String(slot)) },
          ] as const;
        }),
      )
    : undefined;

  useEffect(() => {
    return () => {
      threadShortcutOrderRef.current = null;
    };
  }, [threadShortcutOrderRef]);

  // Rename can start from the header, Cmd-K or its shortcut, so reveal the
  // row that holds the rename field when it sits in a collapsed group.
  const renameSessionId = threadMenu.renameSessionId;
  useEffect(() => {
    if (!renameSessionId) return;
    const holds = (threads: readonly ThreadListEntry[]) =>
      threads.some((thread) => thread.session.id === renameSessionId);
    if (holds(threadSidebarModel.archivedThreads)) {
      setArchivedOpen(true);
      return;
    }
    const parentKey = unfoldedSidebarModel.recencyOrder.find(
      (thread) => thread.session.id === renameSessionId,
    )?.parentKey;
    if (parentKey) setChatParentFolded(parentKey, false);
    const keys = [
      ...threadSidebarModel.recencySections
        .filter((section) => holds(section.threads))
        .map((section) => recencyHistoryExpansionKey(section.bucket)),
      ...threadSidebarModel.workspaceGroups
        .filter((group) => holds(group.threads))
        .map((group) => workspaceHistoryExpansionKey(group.workspace.id)),
    ];
    setExpandedHistory((current) =>
      keys.every((key) => current.has(key)) ? current : new Set([...current, ...keys]),
    );
    // A folded folder hides the rename field; open it so the input is reachable.
    // Time grouping shows no folder threads, so leave the folded set alone there.
    for (const group of threadGrouping === "workspace" ? threadSidebarModel.workspaceGroups : []) {
      if (holds(group.threads) && collapsedFolderIds.has(group.workspace.id)) {
        setFolderCollapsed(group.workspace.id, false);
      }
    }
    // Reveal once per rename; later list changes should not reopen groups.
  }, [renameSessionId]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const pinnedSortableId = (thread: ThreadListEntry) => `pinned:${sessionThreadKey(thread)}`;
  const pinnedSessionKeyFromSortableId = (id: string) =>
    id.startsWith("pinned:") ? id.slice("pinned:".length) : id;

  // Collision detection based on workspace row headers only (~30px top of each group),
  // not the full group height including all sessions.
  const headerCollision: CollisionDetection = (args) => {
    if (String(args.active.id).startsWith("pinned:")) {
      const pointerY = args.pointerCoordinates?.y;
      if (pointerY == null) return [];
      let closest: { id: string; distance: number } | null = null;
      for (const container of args.droppableContainers) {
        const containerId = String(container.id);
        if (!containerId.startsWith("pinned:") || containerId === String(args.active.id)) {
          continue;
        }
        const rect = container.rect.current;
        if (!rect) continue;
        const rowCenter = rect.top + rect.height / 2;
        const distance = Math.abs(pointerY - rowCenter);
        if (!closest || distance < closest.distance) {
          closest = { id: containerId, distance };
        }
      }
      return closest
        ? [
            {
              id: closest.id,
              data: {
                droppableContainer: args.droppableContainers.find(
                  (c) => String(c.id) === closest!.id,
                )!,
              },
            },
          ]
        : [];
    }
    const pointerY = args.pointerCoordinates?.y;
    if (pointerY == null) return [];

    let closest: { id: string; distance: number } | null = null;
    for (const container of args.droppableContainers) {
      if (String(container.id).startsWith("pinned:")) {
        continue;
      }
      const rect = container.rect.current;
      if (!rect) continue;
      const headerCenter = rect.top + 15; // center of the ~30px workspace row header
      const distance = Math.abs(pointerY - headerCenter);
      if (!closest || distance < closest.distance) {
        closest = { id: String(container.id), distance };
      }
    }
    return closest
      ? [
          {
            id: closest.id,
            data: {
              droppableContainer: args.droppableContainers.find(
                (c) => String(c.id) === closest!.id,
              )!,
            },
          },
        ]
      : [];
  };

  const sidebarFolderGroups = visibleWorkspaceGroups(threadSidebarModel, threadGrouping);
  const rootGroups = sidebarFolderGroups.filter((group) => group.workspace.kind === "primary");
  const orphanGroups = sidebarFolderGroups.filter((group) => group.workspace.kind !== "primary");
  const pinnedThreads = threadSidebarModel.pinnedThreads;
  const pinnedSortableIds = pinnedThreads.map(pinnedSortableId);
  const rootGroupIds = rootGroups.map((group) => group.workspace.id);
  const canDrag = rootGroups.length > 1;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    if (String(active.id).startsWith("pinned:")) {
      const oldIndex = pinnedSortableIds.indexOf(String(active.id));
      const newIndex = pinnedSortableIds.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

      const newOrder = arrayMove(pinnedSortableIds, oldIndex, newIndex).map(
        pinnedSessionKeyFromSortableId,
      );
      applyOptimisticReorder(
        (prev) => ({ ...prev, pinnedSessionOrder: newOrder }),
        () => api.reorderPinnedSessions(newOrder),
      );
      return;
    }

    const oldIndex = rootGroupIds.indexOf(String(active.id));
    const newIndex = rootGroupIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    const newOrder = arrayMove(rootGroupIds, oldIndex, newIndex);
    applyOptimisticReorder(
      (prev) => ({ ...prev, workspaceOrder: newOrder }),
      () => api.reorderWorkspaces(newOrder),
    );
  }

  // Optimistically update local state to avoid snap-back animation, then reconcile with the
  // authoritative state the IPC call returns; roll back to the pre-reorder snapshot on rejection.
  function applyOptimisticReorder(
    optimistic: (prev: DesktopAppState) => DesktopAppState,
    commit: () => Promise<DesktopAppState>,
  ) {
    let previousSnapshot: DesktopAppState | null = null;
    setSnapshot((prev) => {
      previousSnapshot = prev;
      return prev ? optimistic(prev) : prev;
    });
    void commit().then(
      (state) => setSnapshot(state),
      () => setSnapshot(previousSnapshot),
    );
  }

  const activeFolder = activeId
    ? rootGroups.find((group) => group.workspace.id === activeId)?.workspace
    : undefined;
  const activePinnedThread = activeId?.startsWith("pinned:")
    ? pinnedThreads.find((thread) => pinnedSortableId(thread) === activeId)
    : undefined;

  function toggleHistoryExpanded(key: string) {
    setExpandedHistory((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <aside className="sidebar" id="primary-sidebar" style={sidebarWidthStyle}>
      <PaneResizeHandle
        className="sidebar__resize-handle"
        label="Sidebar width"
        controls="primary-sidebar"
        edge="right"
        bounds={sidebarWidthBounds}
        onResize={setSidebarWidth}
        onReset={() => setSidebarWidth(undefined)}
        cssVar="--sidebar-width"
        cssVarOn="pane"
      />
      <div className="sidebar__top">
        <AppBrand />
        <button
          className="sidebar__new"
          type="button"
          disabled={!selectedWorkspace}
          onClick={() => onNewThread()}
        >
          <PlusIcon />
          <span>New chat</span>
        </button>

        <div className="sidebar__nav">
          <button
            aria-current={activeView === "threads" ? "page" : undefined}
            className={`sidebar__nav-item ${activeView === "threads" ? "sidebar__nav-item--active" : ""}`}
            type="button"
            onClick={() => onSetActiveView("threads")}
          >
            <FolderIcon />
            <span>Chats</span>
          </button>
          <button
            aria-current={activeView === "scheduled" ? "page" : undefined}
            className={`sidebar__nav-item ${activeView === "scheduled" ? "sidebar__nav-item--active" : ""}`}
            type="button"
            data-testid="sidebar-scheduled"
            onClick={() => onSetActiveView("scheduled")}
          >
            <ClockIcon />
            <span>Scheduled</span>
          </button>
          <button
            aria-current={activeView === "usage" ? "page" : undefined}
            className={`sidebar__nav-item ${activeView === "usage" ? "sidebar__nav-item--active" : ""}`}
            type="button"
            data-testid="sidebar-usage"
            onClick={() => onSetActiveView("usage")}
          >
            <UsageIcon />
            <span>Usage</span>
            {signInNeedsOwner ? (
              <span
                aria-label="A sign-in needs attention"
                className="sidebar__nav-item-alert"
                role="img"
              />
            ) : null}
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() =>
              onOpenSkills(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)
            }
          >
            <SkillIcon />
            <span>Skills</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() =>
              onOpenExtensions(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)
            }
          >
            <ExtensionIcon />
            <span>Extensions</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() =>
              onOpenSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)
            }
          >
            <SettingsIcon />
            <span>Settings</span>
          </button>
        </div>
      </div>

      <div className="sidebar__section">
        <div className="section__head">
          <span>Chats & Folders</span>
          <div className="section__tools">
            <ThreadGroupingControl
              grouping={threadGrouping}
              onChange={(grouping) => {
                void updateSnapshot(setSnapshot, () => api.setThreadGrouping(grouping)).catch(
                  (error: unknown) => {
                    console.error("[renderer] setThreadGrouping failed", error);
                  },
                );
              }}
            />
          </div>
        </div>

        {threadGrouping === "workspace" ? (
          <div className="sidebar__folder-actions">
            <button
              className="sidebar__nav-item"
              type="button"
              onClick={() => wsMenu.addWorkspace()}
            >
              <FolderIcon />
              <span>Open folder</span>
            </button>
            <button
              className="sidebar__nav-item"
              type="button"
              onClick={() => wsMenu.addWorkspace(true)}
            >
              <PlusIcon />
              <span>New folder</span>
            </button>
            <button
              className="sidebar__nav-item"
              type="button"
              disabled={!selectedWorkspace}
              onClick={onBrowseFiles}
            >
              <FolderIcon />
              <span>Browse files</span>
            </button>
          </div>
        ) : null}

        {visibleWorkspaces.length === 0 ? (
          <div className="empty-state" data-testid="empty-state">
            <h2>No folders yet</h2>
            <p>Open a project folder to start building a workspace and session list.</p>
            <button
              className="button button--primary"
              type="button"
              onClick={() => wsMenu.addWorkspace()}
            >
              Open first folder
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={headerCollision}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <ThreadShortcutContext.Provider value={shortcutByKey}>
              <ChatFoldContext.Provider value={chatFold}>
                <div className="workspace-list" data-testid="workspace-list">
                  <SortableContext items={rootGroupIds} strategy={verticalListSortingStrategy}>
                    {rootGroups.map((group) => (
                      <SortableWorkspaceFolder
                        key={group.workspace.id}
                        workspace={group.workspace}
                        threads={threadGrouping === "workspace" ? group.threads : undefined}
                        historyExpanded={expandedHistory.has(
                          workspaceHistoryExpansionKey(group.workspace.id),
                        )}
                        onToggleHistory={() =>
                          toggleHistoryExpanded(workspaceHistoryExpansionKey(group.workspace.id))
                        }
                        collapsed={collapsedFolderIds.has(group.workspace.id)}
                        onToggleCollapsed={() =>
                          setFolderCollapsed(
                            group.workspace.id,
                            !collapsedFolderIds.has(group.workspace.id),
                          )
                        }
                        canDrag={canDrag}
                        selectedWorkspace={selectedWorkspace}
                        selectedSession={selectedSession}
                        linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                        wsMenu={wsMenu}
                        api={api}
                        threadMenu={threadMenu}
                        onNewThread={onNewThread}
                        onArchiveSession={onArchiveSession}
                        onSelectSession={onSelectSession}
                        onSetSessionPinned={onSetSessionPinned}
                      />
                    ))}
                  </SortableContext>
                  {orphanGroups.map((group) => (
                    <section
                      key={group.workspace.id}
                      className="workspace-group"
                      data-workspace-id={group.workspace.id}
                    >
                      <WorkspaceFolderContent
                        workspace={group.workspace}
                        threads={threadGrouping === "workspace" ? group.threads : undefined}
                        historyExpanded={expandedHistory.has(
                          workspaceHistoryExpansionKey(group.workspace.id),
                        )}
                        onToggleHistory={() =>
                          toggleHistoryExpanded(workspaceHistoryExpansionKey(group.workspace.id))
                        }
                        collapsed={collapsedFolderIds.has(group.workspace.id)}
                        onToggleCollapsed={() =>
                          setFolderCollapsed(
                            group.workspace.id,
                            !collapsedFolderIds.has(group.workspace.id),
                          )
                        }
                        canDrag={false}
                        selectedWorkspace={selectedWorkspace}
                        selectedSession={selectedSession}
                        linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                        wsMenu={wsMenu}
                        api={api}
                        threadMenu={threadMenu}
                        onNewThread={onNewThread}
                        onArchiveSession={onArchiveSession}
                        onSelectSession={onSelectSession}
                        onSetSessionPinned={onSetSessionPinned}
                      />
                    </section>
                  ))}
                  {pinnedThreads.length > 0 ? (
                    <PinnedThreadsSection
                      pinnedThreads={pinnedThreads}
                      sortableIds={pinnedSortableIds}
                      sortableIdForThread={pinnedSortableId}
                      selectedWorkspace={selectedWorkspace}
                      selectedSession={selectedSession}
                      threadMenu={threadMenu}
                      onArchiveSession={onArchiveSession}
                      onSelectSession={onSelectSession}
                      onSetSessionPinned={onSetSessionPinned}
                    />
                  ) : null}
                  {threadGrouping === "time" ? (
                    <>
                      <AttentionSection
                        kind="needs-you"
                        label="Needs you"
                        threads={threadSidebarModel.needsYouThreads}
                        selectedWorkspace={selectedWorkspace}
                        selectedSession={selectedSession}
                        threadMenu={threadMenu}
                        onArchiveSession={onArchiveSession}
                        onSelectSession={onSelectSession}
                        onSetSessionPinned={onSetSessionPinned}
                      />
                      <AttentionSection
                        kind="working"
                        label="Working"
                        threads={threadSidebarModel.workingThreads}
                        folded={workingFolded}
                        onToggleFolded={() => setWorkingFolded((current) => !current)}
                        selectedWorkspace={selectedWorkspace}
                        selectedSession={selectedSession}
                        threadMenu={threadMenu}
                        onArchiveSession={onArchiveSession}
                        onSelectSession={onSelectSession}
                        onSetSessionPinned={onSetSessionPinned}
                      />
                    </>
                  ) : null}
                  {threadGrouping === "time"
                    ? threadSidebarModel.recencySections.map((section) => (
                        <RecencyThreadSectionView
                          key={section.bucket}
                          section={section}
                          historyExpanded={expandedHistory.has(
                            recencyHistoryExpansionKey(section.bucket),
                          )}
                          onToggleHistory={() =>
                            toggleHistoryExpanded(recencyHistoryExpansionKey(section.bucket))
                          }
                          selectedWorkspace={selectedWorkspace}
                          selectedSession={selectedSession}
                          threadMenu={threadMenu}
                          onArchiveSession={onArchiveSession}
                          onSelectSession={onSelectSession}
                          onSetSessionPinned={onSetSessionPinned}
                        />
                      ))
                    : null}
                  {threadSidebarModel.archivedThreads.length > 0 ? (
                    <ArchivedThreadsSection
                      archivedThreads={threadSidebarModel.archivedThreads}
                      open={archivedOpen}
                      onToggle={() => setArchivedOpen((current) => !current)}
                      selectedWorkspace={selectedWorkspace}
                      selectedSession={selectedSession}
                      threadMenu={threadMenu}
                      onUnarchiveSession={onUnarchiveSession}
                      onSelectSession={onSelectSession}
                      onSetSessionPinned={onSetSessionPinned}
                    />
                  ) : null}
                </div>
                <DragOverlay>
                  {activePinnedThread ? (
                    <ThreadSessionRow
                      active={
                        activePinnedThread.workspaceId === selectedWorkspace?.id &&
                        activePinnedThread.session.id === selectedSession?.id
                      }
                      thread={activePinnedThread}
                      showContext
                      overlay
                      onAction={() => undefined}
                      onSelect={() => undefined}
                      onTogglePinned={() => undefined}
                    />
                  ) : activeFolder ? (
                    <div className="workspace-group workspace-group--overlay">
                      <WorkspaceFolderContent
                        workspace={activeFolder}
                        canDrag={false}
                        selectedWorkspace={selectedWorkspace}
                        linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                        wsMenu={wsMenu}
                        api={api}
                      />
                    </div>
                  ) : null}
                </DragOverlay>
              </ChatFoldContext.Provider>
            </ThreadShortcutContext.Provider>
          </DndContext>
        )}
      </div>
      <UndoToastHost />
      <UpdateBanner api={api} />
    </aside>
  );
});

/* ── Sortable workspace folder ─────────────────────────── */

interface WorkspaceFolderProps {
  readonly workspace: WorkspaceRecord;
  readonly threads?: readonly ThreadListEntry[];
  readonly historyExpanded?: boolean;
  readonly onToggleHistory?: () => void;
  readonly collapsed?: boolean;
  readonly onToggleCollapsed?: () => void;
  readonly canDrag: boolean;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession?: SessionRecord;
  readonly linkedWorktreeByWorkspaceId: ReadonlyMap<string, WorktreeRecord>;
  readonly wsMenu: WorkspaceMenuState;
  readonly api: PiDesktopApi;
  readonly threadMenu?: ThreadMenuState;
  readonly onNewThread?: (workspaceId: string) => void;
  readonly onArchiveSession?: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession?: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned?: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}

function SortableWorkspaceFolder(props: WorkspaceFolderProps) {
  const { workspace, wsMenu } = props;
  const isRenaming = wsMenu.workspaceRenameId === workspace.id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: workspace.id,
    disabled: isRenaming,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : undefined,
  };

  return (
    <section
      ref={setNodeRef}
      style={style}
      className={`workspace-group ${isDragging ? "workspace-group--dragging" : ""}`}
      data-workspace-id={workspace.id}
    >
      <WorkspaceFolderContent
        {...props}
        dragHandleProps={props.canDrag && !isRenaming ? { attributes, listeners } : undefined}
      />
    </section>
  );
}

interface DragHandleProps {
  readonly attributes: DraggableAttributes;
  readonly listeners: DraggableSyntheticListeners;
}

function WorkspaceFolderContent(
  props: WorkspaceFolderProps & { readonly dragHandleProps?: DragHandleProps },
) {
  const {
    workspace,
    threads,
    historyExpanded = false,
    onToggleHistory,
    collapsed = false,
    onToggleCollapsed,
    selectedWorkspace,
    selectedSession,
    linkedWorktreeByWorkspaceId,
    wsMenu,
    api,
    threadMenu,
    onNewThread,
    onArchiveSession,
    onSelectSession,
    onSetSessionPinned,
    dragHandleProps,
  } = props;
  // Folder grouping lists threads under each folder, so the row folds them
  // like Codex; with no threads to fold, the row just selects the folder.
  const toggleCollapsed = threads?.length ? onToggleCollapsed : undefined;
  const collapsible = toggleCollapsed !== undefined;
  const history =
    threads && !collapsed ? threadHistoryPreview(threads, historyExpanded) : undefined;

  const workspaceActive =
    workspace.id === selectedWorkspace?.id || workspace.id === selectedWorkspace?.rootWorkspaceId;
  const linkedWorktree = linkedWorktreeByWorkspaceId.get(workspace.id);

  return (
    <>
      <div className={`workspace-row ${workspaceActive ? "workspace-row--active" : ""}`}>
        <button
          className={`workspace-row__select ${dragHandleProps ? "workspace-row__select--draggable" : ""}`}
          onClick={() => {
            if (toggleCollapsed) toggleCollapsed();
            else wsMenu.selectWorkspace(workspace.id);
          }}
          type="button"
          {...(dragHandleProps
            ? { ...dragHandleProps.attributes, ...dragHandleProps.listeners }
            : {})}
          aria-expanded={collapsible ? !collapsed : undefined}
        >
          <span
            className="workspace-row__icon"
            aria-hidden="true"
            data-state={collapsible ? (collapsed ? "collapsed" : "expanded") : undefined}
          >
            <span className="workspace-row__icon-folder">
              <FolderIcon />
            </span>
            {collapsible ? (
              <span className="workspace-row__icon-chevron">
                {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
              </span>
            ) : null}
          </span>
          <span
            className="workspace-row__name"
            title={[workspace.name, wsMenu.descriptions[workspace.id]].filter(Boolean).join("\n")}
          >
            {workspace.name}
          </span>
        </button>
        <span className="workspace-row__actions">
          {onNewThread ? (
            <button
              aria-label={`New chat in ${workspace.name}`}
              className="icon-button workspace-row__action-button"
              title="New chat"
              type="button"
              onClick={() => {
                // The new thread lands in this folder, so open it to keep the row in view.
                // Gate on folder grouping, not on toggleCollapsed: a folder saved as
                // folded may be empty now, and its new thread would land hidden.
                if (collapsed && threads) onToggleCollapsed?.();
                onNewThread(workspace.id);
              }}
            >
              <PlusIcon />
            </button>
          ) : null}
          <span
            className="workspace-row__menu-wrap"
            ref={wsMenu.workspaceMenuId === workspace.id ? wsMenu.workspaceMenuWrapRef : undefined}
          >
            <button
              aria-label={`Workspace actions for ${workspace.name}`}
              aria-haspopup="menu"
              className="icon-button workspace-row__menu-button"
              aria-expanded={wsMenu.workspaceMenuId === workspace.id}
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                wsMenu.openWorkspaceMenu(workspace.id);
              }}
            >
              <MoreIcon />
            </button>
            {wsMenu.workspaceMenuId === workspace.id ? (
              <div aria-label={`${workspace.name} actions`} className="workspace-menu" role="menu">
                <button
                  className="workspace-menu__item"
                  role="menuitem"
                  type="button"
                  onClick={(event) =>
                    wsMenu.runWorkspaceMenuAction(event, () => {
                      void api.openWorkspaceInFinder(workspace.id).catch((error: unknown) => {
                        console.error("[renderer] openWorkspaceInFinder failed", error);
                      });
                    })
                  }
                >
                  Open folder
                </button>
                {linkedWorktree ? (
                  <button
                    className="workspace-menu__item workspace-menu__item--danger"
                    role="menuitem"
                    type="button"
                    onClick={(event) =>
                      wsMenu.runWorkspaceMenuAction(event, () =>
                        wsMenu.removeWorktree(
                          linkedWorktree.rootWorkspaceId || workspace.id,
                          linkedWorktree,
                        ),
                      )
                    }
                  >
                    Remove worktree
                  </button>
                ) : (
                  <button
                    className="workspace-menu__item"
                    role="menuitem"
                    type="button"
                    onClick={(event) =>
                      wsMenu.runWorkspaceMenuAction(event, () =>
                        wsMenu.createWorktree(workspace.id),
                      )
                    }
                  >
                    Create permanent worktree
                  </button>
                )}
                <button
                  className="workspace-menu__item"
                  role="menuitem"
                  type="button"
                  onClick={(event) =>
                    wsMenu.runWorkspaceMenuAction(event, () => wsMenu.startRename(workspace))
                  }
                >
                  Edit name and description
                </button>
                <button
                  className="workspace-menu__item workspace-menu__item--danger"
                  role="menuitem"
                  type="button"
                  onClick={(event) =>
                    wsMenu.runWorkspaceMenuAction(event, () => wsMenu.removeWorkspace(workspace))
                  }
                >
                  Remove
                </button>
              </div>
            ) : null}
          </span>
        </span>
      </div>
      {wsMenu.workspaceRenameId === workspace.id ? (
        <form
          className="workspace-rename"
          ref={wsMenu.workspaceRenamePanelRef}
          onSubmit={(event) => {
            event.preventDefault();
            wsMenu.submitRename(workspace);
          }}
        >
          <input
            aria-label={`Rename ${workspace.name}`}
            autoComplete="off"
            className="workspace-rename__input"
            ref={wsMenu.workspaceRenameInputRef}
            spellCheck={false}
            value={wsMenu.workspaceRenameDraft}
            onChange={(event) => {
              wsMenu.setWorkspaceRenameDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                wsMenu.cancelRename();
              }
            }}
          />
          <textarea
            aria-label={`Description of ${workspace.name}`}
            className="workspace-rename__input workspace-rename__description"
            maxLength={500}
            placeholder="What is this project for?"
            ref={wsMenu.workspaceDescriptionInputRef}
            rows={3}
            value={wsMenu.workspaceDescriptionDraft}
            onChange={(event) => {
              wsMenu.setWorkspaceDescriptionDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                wsMenu.cancelRename();
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="workspace-rename__actions">
            <button
              className="workspace-rename__button"
              type="button"
              onClick={wsMenu.cancelRename}
            >
              Cancel
            </button>
            <button
              className="workspace-rename__button workspace-rename__button--primary"
              type="submit"
            >
              Save
            </button>
          </div>
        </form>
      ) : null}
      {history && onSelectSession && onArchiveSession && onSetSessionPinned ? (
        <>
          <div className="session-list session-list--history">
            {history.visible.map((thread) => (
              <HistoryThreadRow
                key={`${thread.workspaceId}:${thread.session.id}`}
                thread={thread}
                selectedWorkspace={selectedWorkspace}
                selectedSession={selectedSession}
                threadMenu={threadMenu}
                onArchiveSession={onArchiveSession}
                onSelectSession={onSelectSession}
                onSetSessionPinned={onSetSessionPinned}
              />
            ))}
          </div>
          {history.overflow && onToggleHistory ? (
            <HistoryToggle
              expanded={historyExpanded}
              label={workspace.name}
              onToggle={onToggleHistory}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * "Needs you" and "Working" sit above the time buckets so a chat that wants the owner is never
 * buried below Last week. Working folds shut; Needs you never does.
 */
function AttentionSection({
  kind,
  label,
  threads,
  folded = false,
  onToggleFolded,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onArchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly kind: "needs-you" | "working";
  readonly label: string;
  readonly threads: readonly ThreadListEntry[];
  readonly folded?: boolean;
  readonly onToggleFolded?: () => void;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  if (threads.length === 0) return null;
  const count = threads.filter((thread) => !thread.depth).length;
  const headContent = (
    <>
      {onToggleFolded ? (
        <span
          aria-hidden="true"
          className={`attention-group__chevron ${folded ? "attention-group__chevron--folded" : ""}`}
        >
          <ChevronDownIcon />
        </span>
      ) : (
        <span aria-hidden="true" className="attention-group__dot" />
      )}
      <span>{label}</span>
      <span className="attention-group__count">{count}</span>
    </>
  );
  return (
    <section className="attention-group" aria-label={label} data-attention={kind}>
      {onToggleFolded ? (
        <button
          aria-expanded={!folded}
          className="attention-group__head attention-group__head--button"
          type="button"
          onClick={onToggleFolded}
        >
          {headContent}
        </button>
      ) : (
        <div className="attention-group__head">{headContent}</div>
      )}
      {folded ? null : (
        <div className="session-list session-list--history">
          {threads.map((thread) => (
            <HistoryThreadRow
              key={`${thread.workspaceId}:${thread.session.id}`}
              showContext
              thread={thread}
              selectedWorkspace={selectedWorkspace}
              selectedSession={selectedSession}
              threadMenu={threadMenu}
              onArchiveSession={onArchiveSession}
              onSelectSession={onSelectSession}
              onSetSessionPinned={onSetSessionPinned}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RecencyThreadSectionView({
  section,
  historyExpanded,
  onToggleHistory,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onArchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly section: RecencyThreadSection;
  readonly historyExpanded: boolean;
  readonly onToggleHistory: () => void;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  const history = threadHistoryPreview(section.threads, historyExpanded);
  return (
    <section
      className="recency-thread-group"
      aria-label={section.label}
      data-recency-bucket={section.bucket}
    >
      <div className="recency-thread-group__head">{section.label}</div>
      <div className="session-list session-list--history">
        {history.visible.map((thread) => (
          <HistoryThreadRow
            key={`${thread.workspaceId}:${thread.session.id}`}
            showContext
            thread={thread}
            selectedWorkspace={selectedWorkspace}
            selectedSession={selectedSession}
            threadMenu={threadMenu}
            onArchiveSession={onArchiveSession}
            onSelectSession={onSelectSession}
            onSetSessionPinned={onSetSessionPinned}
          />
        ))}
      </div>
      {history.overflow ? (
        <HistoryToggle
          expanded={historyExpanded}
          label={section.label}
          onToggle={onToggleHistory}
        />
      ) : null}
    </section>
  );
}

function HistoryThreadRow({
  thread,
  showContext = false,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onArchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly thread: ThreadListEntry;
  readonly showContext?: boolean;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState | undefined;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  const active =
    thread.workspaceId === selectedWorkspace?.id && thread.session.id === selectedSession?.id;
  return (
    <ThreadSessionRow
      active={active}
      showContext={showContext}
      thread={thread}
      threadMenu={threadMenu}
      onAction={() =>
        onArchiveSession({
          workspaceId: thread.workspaceId,
          sessionId: thread.session.id,
        })
      }
      onSelect={() =>
        onSelectSession({
          workspaceId: thread.workspaceId,
          sessionId: thread.session.id,
        })
      }
      onTogglePinned={() =>
        onSetSessionPinned(
          { workspaceId: thread.workspaceId, sessionId: thread.session.id },
          !thread.session.pinnedAt,
        )
      }
    />
  );
}

function HistoryToggle({
  expanded,
  label,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) {
  const text = expanded ? "Show less" : "Show more";
  return (
    <button
      aria-expanded={expanded}
      aria-label={`${text} ${label}`}
      className="thread-history-toggle"
      type="button"
      onClick={onToggle}
    >
      {text}
    </button>
  );
}

function ThreadGroupingControl({
  grouping,
  onChange,
}: {
  readonly grouping: ThreadGrouping;
  readonly onChange: (grouping: ThreadGrouping) => void;
}) {
  return (
    <div className="sidebar__grouping" role="group" aria-label="Sidebar view">
      {(
        [
          ["time", "Chats"],
          ["workspace", "Folders"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={grouping === value}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ArchivedThreadsSection({
  archivedThreads,
  open,
  onToggle,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onUnarchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly archivedThreads: readonly ThreadListEntry[];
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState;
  readonly onUnarchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  return (
    <div className="archived-thread-group">
      <button
        aria-label={`Archived chats (${archivedThreads.length})`}
        aria-expanded={open}
        className="archived-thread-group__toggle"
        title={open ? "Hide archived chats" : "Show archived chats"}
        type="button"
        onClick={onToggle}
      >
        <span
          aria-hidden="true"
          className={`archived-thread-group__chevron ${open ? "archived-thread-group__chevron--open" : ""}`}
        >
          <ChevronDownIcon />
        </span>
        <span>Archived</span>
        <span className="archived-thread-group__count">{archivedThreads.length}</span>
      </button>
      {open ? (
        <div className="session-list session-list--archived">
          {archivedThreads.map((thread) => {
            const active =
              thread.workspaceId === selectedWorkspace?.id &&
              thread.session.id === selectedSession?.id;
            return (
              <ThreadSessionRow
                key={`${thread.workspaceId}:${thread.session.id}`}
                active={active}
                archived
                thread={thread}
                showContext
                threadMenu={threadMenu}
                onAction={() =>
                  onUnarchiveSession({
                    workspaceId: thread.workspaceId,
                    sessionId: thread.session.id,
                  })
                }
                onSelect={() =>
                  onSelectSession({
                    workspaceId: thread.workspaceId,
                    sessionId: thread.session.id,
                  })
                }
                onTogglePinned={() =>
                  onSetSessionPinned(
                    { workspaceId: thread.workspaceId, sessionId: thread.session.id },
                    !thread.session.pinnedAt,
                  )
                }
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function PinnedThreadsSection({
  pinnedThreads,
  sortableIds,
  sortableIdForThread,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onArchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly pinnedThreads: readonly ThreadListEntry[];
  readonly sortableIds: readonly string[];
  readonly sortableIdForThread: (thread: ThreadListEntry) => string;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  return (
    <section className="pinned-thread-group" aria-label="Pinned threads">
      <div className="pinned-thread-group__head">
        <PinIcon filled />
        <span>Pinned</span>
      </div>
      <SortableContext items={[...sortableIds]} strategy={verticalListSortingStrategy}>
        <div className="session-list session-list--pinned">
          {pinnedThreads.map((thread) => {
            const active =
              thread.workspaceId === selectedWorkspace?.id &&
              thread.session.id === selectedSession?.id;
            return (
              <SortablePinnedThreadRow
                key={`${thread.workspaceId}:${thread.session.id}`}
                id={sortableIdForThread(thread)}
                active={active}
                thread={thread}
                threadMenu={threadMenu}
                onAction={() =>
                  onArchiveSession({
                    workspaceId: thread.workspaceId,
                    sessionId: thread.session.id,
                  })
                }
                onSelect={() =>
                  onSelectSession({ workspaceId: thread.workspaceId, sessionId: thread.session.id })
                }
                onTogglePinned={() =>
                  onSetSessionPinned(
                    { workspaceId: thread.workspaceId, sessionId: thread.session.id },
                    !thread.session.pinnedAt,
                  )
                }
              />
            );
          })}
        </div>
      </SortableContext>
    </section>
  );
}

/* ── Thread session row ────────────────────────────────── */

function SortablePinnedThreadRow({
  id,
  active,
  thread,
  threadMenu,
  onAction,
  onSelect,
  onTogglePinned,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly thread: ThreadListEntry;
  readonly threadMenu: ThreadMenuState;
  readonly onAction: () => void;
  readonly onSelect: () => void;
  readonly onTogglePinned: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : undefined,
  };
  return (
    <ThreadSessionRow
      ref={setNodeRef}
      style={style}
      active={active}
      thread={thread}
      threadMenu={threadMenu}
      showContext
      dragging={isDragging}
      dragAttributes={attributes}
      dragListeners={listeners}
      onAction={onAction}
      onSelect={onSelect}
      onTogglePinned={onTogglePinned}
    />
  );
}

function sessionIndicatorVariant(
  thread: ThreadListEntry,
): "running" | "failed" | "unseen" | "none" {
  if (thread.session.status === "running") {
    return "running";
  }
  if (thread.session.status === "failed") {
    return "failed";
  }
  if (thread.session.hasUnseenUpdate) {
    return "unseen";
  }
  return "none";
}

interface ThreadSessionRowProps {
  readonly active: boolean;
  readonly archived?: boolean;
  readonly showContext?: boolean;
  readonly overlay?: boolean;
  readonly dragging?: boolean;
  readonly style?: CSSProperties;
  readonly dragAttributes?: DraggableAttributes;
  readonly dragListeners?: DraggableSyntheticListeners;
  readonly thread: ThreadListEntry;
  readonly threadMenu?: ThreadMenuState;
  readonly onAction: () => void;
  readonly onSelect: () => void;
  readonly onTogglePinned: () => void;
  readonly ref?: Ref<HTMLDivElement>;
}

function ThreadSessionRow({
  active,
  archived = false,
  showContext = false,
  overlay = false,
  dragging = false,
  style,
  dragAttributes,
  dragListeners,
  thread,
  threadMenu,
  onAction,
  onSelect,
  onTogglePinned,
  ref,
}: ThreadSessionRowProps) {
  const indicatorVariant = sessionIndicatorVariant(thread);
  const pinned = Boolean(thread.session.pinnedAt);
  const actionContext = showContext ? ` in ${thread.contextLabel}` : "";
  const shortcut = use(ThreadShortcutContext)?.get(sessionThreadKey(thread));
  const shortcutBadge = overlay ? undefined : shortcut;
  const chatFold = use(ChatFoldContext);
  const threadKey = sessionThreadKey(thread);
  const childCount = thread.childCount ?? 0;
  const foldable = childCount > 0 && chatFold !== undefined && !overlay;
  // The chevron turns as soon as the user folds; the rows finish shrinking a moment later.
  const folded =
    foldable && (chatFold.folded.has(threadKey) || chatFold.motion.get(threadKey) === "closing");
  const rowMotion = thread.parentKey ? chatFold?.motion.get(thread.parentKey) : undefined;
  const subagentLabel = `${childCount} subagent ${childCount === 1 ? "chat" : "chats"}`;
  const menuOpen =
    !overlay &&
    threadMenu?.openMenu?.surface === "sidebar" &&
    threadMenu.openMenu.sessionId === thread.session.id;
  const classes = [
    "session-row",
    active ? "session-row--active" : "",
    pinned ? "session-row--pinned" : "",
    dragging ? "session-row--dragging" : "",
    overlay ? "session-row--overlay" : "",
    shortcutBadge ? "session-row--shortcut" : "",
    thread.depth ? "session-row--child" : "",
    foldable ? "session-row--parent" : "",
    rowMotion === "opening" ? "session-row--entering" : "",
    rowMotion === "closing" ? "session-row--leaving" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <div
        ref={ref}
        style={style}
        className={classes}
        data-sidebar-indicator={indicatorVariant}
        data-session-pinned={pinned ? "true" : "false"}
        data-session-id={thread.session.id}
        data-thread-shortcut={shortcutBadge ? String(shortcutBadge.slot) : undefined}
        aria-keyshortcuts={
          shortcutBadge ? `${IS_MAC ? "Meta" : "Control"}+${shortcutBadge.slot}` : undefined
        }
        onClick={() => {
          if (!dragging) onSelect();
        }}
        onContextMenu={(event) => {
          if (!threadMenu || overlay) return;
          event.preventDefault();
          event.stopPropagation();
          threadMenu.openSidebarMenu(thread.session.id);
        }}
      >
        {foldable ? (
          <button
            aria-expanded={!folded}
            aria-label={`${folded ? "Show" : "Hide"} ${subagentLabel} of ${thread.session.title}`}
            className="session-row__fold"
            data-state={folded ? "collapsed" : "expanded"}
            title={`${folded ? "Show" : "Hide"} ${subagentLabel}`}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              chatFold.setFolded(threadKey, !folded);
            }}
          >
            <ChevronDownIcon />
          </button>
        ) : null}
        <button
          aria-current={active ? "page" : undefined}
          className="session-row__select"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          type="button"
          {...dragAttributes}
          {...dragListeners}
        >
          <span className="session-row__leading" aria-hidden="true">
            {indicatorVariant === "none" ? (
              <span className="session-row__kind">
                {thread.depth ? <ForkIcon /> : <ChatIcon />}
              </span>
            ) : null}
            {indicatorVariant === "running" ? (
              <span className="session-row__status session-row__status--running" />
            ) : null}
            {indicatorVariant === "failed" ? (
              <span className="session-row__status session-row__status--failed" />
            ) : null}
            {indicatorVariant === "unseen" ? (
              <span className="session-row__status session-row__status--unseen" />
            ) : null}
          </span>
          <span className="session-row__body">
            <span className="session-row__title-line">
              <span className="session-row__title" title={thread.session.title}>
                {thread.session.title}
              </span>
              {folded ? (
                <span className="session-row__children" title={subagentLabel}>
                  {childCount}
                </span>
              ) : null}
            </span>
            {showContext ? (
              <span className="session-row__context">{thread.contextLabel}</span>
            ) : null}
          </span>
        </button>
        <span className="session-row__trailing">
          {thread.environment.kind === "worktree" ? (
            <span className="session-row__workspace-icon" aria-hidden="true" title="Worktree">
              <WorktreeIcon />
            </span>
          ) : null}
          {shortcutBadge ? (
            <span className="session-row__shortcut" aria-hidden="true">
              {shortcutBadge.label}
            </span>
          ) : (
            <span className="session-row__time">
              {formatRelativeTime(sessionLastInteractedAt(thread.session))}
            </span>
          )}
          <span className="session-row__action-cluster">
            {!archived ? (
              <button
                aria-label={`${pinned ? "Unpin" : "Pin"} ${thread.session.title}${actionContext}`}
                aria-pressed={pinned}
                className="icon-button session-row__action session-row__pin-action"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onTogglePinned();
                }}
              >
                <PinIcon filled={pinned} />
              </button>
            ) : null}
            <span className="shortcut-tooltip-wrap session-row__tooltip-wrap">
              <button
                aria-label={`${archived ? "Unarchive" : "Archive"} chat ${thread.session.title}${actionContext}`}
                className="icon-button session-row__action"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAction();
                }}
              >
                {archived ? <RestoreIcon /> : <ArchiveIcon />}
              </button>
              {threadMenu && !overlay && !menuOpen ? (
                <span className="shortcut-tooltip session-row__tooltip" role="tooltip">
                  <span>{archived ? "Unarchive chat" : "Archive chat"}</span>
                  {archived ? null : <kbd>{archiveThreadShortcut(threadMenu.platform)}</kbd>}
                </span>
              ) : null}
            </span>
          </span>
          {threadMenu && menuOpen ? (
            <div className="session-row__menu-wrap" ref={threadMenu.menuWrapRef}>
              <ThreadActionsMenu
                actions={threadMenu.actionsFor(thread)}
                className="session-row__menu"
              />
            </div>
          ) : null}
        </span>
      </div>
      {threadMenu?.renameSessionId === thread.session.id ? (
        <form
          className="workspace-rename session-rename"
          ref={threadMenu.renamePanelRef}
          onSubmit={(event) => {
            event.preventDefault();
            threadMenu.submitRename(thread);
          }}
        >
          <input
            aria-label={`Rename thread ${thread.session.title}`}
            autoComplete="off"
            className="workspace-rename__input"
            // Mounts when a rename starts, including after the sidebar or a
            // collapsed group opens to reveal the row.
            autoFocus
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            value={threadMenu.renameDraft}
            onChange={(event) => threadMenu.setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                threadMenu.cancelRename();
              }
            }}
          />
          <div className="workspace-rename__actions">
            <button
              className="workspace-rename__button"
              type="button"
              onClick={threadMenu.cancelRename}
            >
              Cancel
            </button>
            <button
              className="workspace-rename__button workspace-rename__button--primary"
              type="submit"
            >
              Save
            </button>
          </div>
        </form>
      ) : null}
    </>
  );
}
