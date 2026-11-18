import { useEffect, useRef, useState, type RefObject } from "react";
import type { ThreadListEntry } from "./thread-groups";
import { sessionLastInteractedAt } from "../../../contracts/thread-recency";
import { formatRelativeTime } from "../../lib/string-utils";
import { FloatingMenu } from "../../ui/floating-menu";

/** How long the pointer rests on a chat row before its card appears. */
export const HOVER_CARD_DELAY_MS = 400;
/** Card width in CSS pixels (kept in sync with .thread-hover-card). */
const CARD_WIDTH = 296;
const GAP = 8;

type ThreadCardStatus = "working" | "needs-you" | "done";

export function threadCardStatus(thread: ThreadListEntry): {
  readonly kind: ThreadCardStatus;
  readonly label: string;
} {
  const session = thread.session;
  if (session.status === "running" || thread.childrenRunning) {
    return { kind: "working", label: "Working" };
  }
  if (session.status === "failed" || session.hasUnseenUpdate) {
    return { kind: "needs-you", label: "Needs you" };
  }
  return { kind: "done", label: "Done" };
}

/**
 * Shows a card beside a chat row once the pointer has rested on it for ~400 ms. It hides on
 * leave, on any scroll and on right-click. Returns the handlers for the row and the card node.
 */
export function useThreadHoverCard(
  rowRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  thread: ThreadListEntry,
) {
  const [at, setAt] = useState<{ x: number; y: number; side: "left" | "right" } | null>(null);
  const timer = useRef(0);
  const cancel = () => {
    window.clearTimeout(timer.current);
    setAt(null);
  };
  useEffect(() => {
    if (!at) return;
    const hide = () => setAt(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("wheel", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [at]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled]);

  const handlers = {
    onMouseEnter: () => {
      // Touch and pen have no hover; a card there would stick after a tap.
      if (!enabled || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const row = rowRef.current;
        if (!row) return;
        const rect = row.getBoundingClientRect();
        // Right of the row; on its left when the window has no room (FloatingMenu clamps to the window).
        const fitsRight = rect.right + GAP + CARD_WIDTH <= window.innerWidth - GAP;
        setAt({
          x: fitsRight ? rect.right + GAP : rect.left - GAP - CARD_WIDTH,
          y: rect.top,
          side: fitsRight ? "right" : "left",
        });
      }, HOVER_CARD_DELAY_MS);
    },
    onMouseLeave: cancel,
    onMouseDown: cancel,
    onContextMenuCapture: cancel,
  };
  const card = at ? <ThreadHoverCard at={at} thread={thread} /> : null;
  return { handlers, card };
}

function activityLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const relative = formatRelativeTime(value);
  const absolute = new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return relative === "now" ? `Just now · ${absolute}` : `${relative} ago · ${absolute}`;
}

function ThreadHoverCard({
  at,
  thread,
}: {
  readonly at: { readonly x: number; readonly y: number; readonly side: "left" | "right" };
  readonly thread: ThreadListEntry;
}) {
  const session = thread.session;
  const status = threadCardStatus(thread);
  const model = [session.config?.provider, session.config?.modelId].filter(Boolean).join(" / ");
  const preview = session.preview.trim();
  return (
    <FloatingMenu at={at}>
      <div
        className="thread-hover-card"
        data-testid="thread-hover-card"
        data-side={at.side}
        data-status={status.kind}
        role="tooltip"
        style={{ width: CARD_WIDTH }}
      >
        <div className="thread-hover-card__title">{session.title}</div>
        <dl className="thread-hover-card__facts">
          <dt>Project</dt>
          <dd data-field="project">{thread.contextLabel}</dd>
          <dt>Status</dt>
          <dd data-field="status">
            <span className={`thread-hover-card__dot thread-hover-card__dot--${status.kind}`} />
            {status.label}
          </dd>
          {model ? (
            <>
              <dt>Model</dt>
              <dd data-field="model">{model}</dd>
            </>
          ) : null}
          <dt>Last activity</dt>
          <dd data-field="activity">{activityLabel(sessionLastInteractedAt(session))}</dd>
        </dl>
        {preview ? (
          <div className="thread-hover-card__preview" data-field="preview">
            {preview}
          </div>
        ) : null}
      </div>
    </FloatingMenu>
  );
}
