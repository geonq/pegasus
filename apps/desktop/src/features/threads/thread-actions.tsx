import type { ReactNode } from "react";
import type { SessionRecord } from "../../../contracts/desktop-state";
import { formatShortcut } from "../../../contracts/ipc";
import {
  ArchiveIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  PencilIcon,
  PinIcon,
  RestoreIcon,
} from "../../ui/icons";

/**
 * The one list of things a thread can do. The thread header menu, the sidebar
 * row's right-click menu and the command palette all render this list, so they
 * cannot drift apart.
 */
export type ThreadActionId =
  | "rename-thread"
  | "pin-thread"
  | "snooze-hour"
  | "snooze-tomorrow"
  | "wake-thread"
  | "archive-thread"
  | "restore-thread"
  | "mark-read"
  | "scheduled-task"
  | "copy-session-id";

export interface ThreadAction {
  readonly id: ThreadActionId;
  readonly title: string;
  readonly icon: ReactNode;
  readonly hint?: string;
  readonly run: () => void;
}

/** The thread an action applies to. Sidebar entries and the open thread both fit. */
export interface ThreadActionSubject {
  readonly workspaceId: string;
  readonly session: SessionRecord;
}

export interface ThreadActionHandlers {
  readonly platform: NodeJS.Platform;
  readonly hasScheduledTask: (subject: ThreadActionSubject) => boolean;
  readonly startRename: (subject: ThreadActionSubject) => void;
  readonly setPinned: (subject: ThreadActionSubject, pinned: boolean) => void;
  /** Snooze until the given time; null wakes the chat now. */
  readonly setSnoozed: (subject: ThreadActionSubject, until: Date | null) => void;
  readonly archive: (subject: ThreadActionSubject) => void;
  readonly restore: (subject: ThreadActionSubject) => void;
  readonly markRead: (subject: ThreadActionSubject) => void;
  readonly openScheduledTask: (subject: ThreadActionSubject) => void;
  readonly copySessionId: (subject: ThreadActionSubject) => void;
}

export function renameThreadShortcut(platform: NodeJS.Platform): string {
  return formatShortcut(platform, "R", { shift: true });
}

export function archiveThreadShortcut(platform: NodeJS.Platform): string {
  return formatShortcut(platform, "A", { shift: true });
}

/** When the snooze menu items wake a chat: in an hour, or tomorrow at 9:00. */
export function snoozeTimes(now: Date = new Date()): {
  readonly hour: Date;
  readonly tomorrow: Date;
} {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return { hour: new Date(now.getTime() + 60 * 60 * 1000), tomorrow };
}

export function buildThreadActions(
  subject: ThreadActionSubject,
  handlers: ThreadActionHandlers,
): readonly ThreadAction[] {
  const { session } = subject;
  const archived = Boolean(session.archivedAt);
  const pinned = Boolean(session.pinnedAt);
  const actions: ThreadAction[] = [
    {
      id: "rename-thread",
      title: "Rename chat",
      icon: <PencilIcon />,
      hint: renameThreadShortcut(handlers.platform),
      run: () => handlers.startRename(subject),
    },
  ];
  if (archived) {
    actions.push({
      id: "restore-thread",
      title: "Unarchive chat",
      icon: <RestoreIcon />,
      run: () => handlers.restore(subject),
    });
  } else {
    actions.push(
      {
        id: "pin-thread",
        title: pinned ? "Unpin chat" : "Pin chat",
        icon: <PinIcon filled={pinned} />,
        run: () => handlers.setPinned(subject, !pinned),
      },
      ...(session.snoozedUntil
        ? [
            {
              id: "wake-thread" as const,
              title: "Wake chat now",
              icon: <ClockIcon />,
              run: () => handlers.setSnoozed(subject, null),
            },
          ]
        : [
            {
              id: "snooze-hour" as const,
              title: "Snooze for an hour",
              icon: <ClockIcon />,
              run: () => handlers.setSnoozed(subject, snoozeTimes().hour),
            },
            {
              id: "snooze-tomorrow" as const,
              title: "Snooze until tomorrow",
              icon: <ClockIcon />,
              run: () => handlers.setSnoozed(subject, snoozeTimes().tomorrow),
            },
          ]),
      {
        id: "archive-thread",
        title: "Archive chat",
        icon: <ArchiveIcon />,
        hint: archiveThreadShortcut(handlers.platform),
        run: () => handlers.archive(subject),
      },
    );
  }
  if (session.hasUnseenUpdate) {
    actions.push({
      id: "mark-read",
      title: "Mark as read",
      icon: <CheckIcon />,
      run: () => handlers.markRead(subject),
    });
  }
  actions.push(
    {
      id: "scheduled-task",
      title: handlers.hasScheduledTask(subject) ? "Edit scheduled task…" : "Add scheduled task…",
      icon: <ClockIcon />,
      run: () => handlers.openScheduledTask(subject),
    },
    {
      id: "copy-session-id",
      title: "Copy session ID",
      icon: <CopyIcon />,
      run: () => handlers.copySessionId(subject),
    },
  );
  return actions;
}

interface ThreadActionsMenuProps {
  readonly actions: readonly ThreadAction[];
  readonly className: string;
}

export function ThreadActionsMenu({ actions, className }: ThreadActionsMenuProps) {
  return (
    <div className={`workspace-menu ${className}`} role="menu">
      {actions.map((action) => (
        <button
          key={action.id}
          className="workspace-menu__item"
          data-thread-action={action.id}
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            action.run();
          }}
        >
          <span>{action.title}</span>
          {action.hint ? (
            <span className="workspace-menu__shortcut" aria-hidden="true">
              {action.hint}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
