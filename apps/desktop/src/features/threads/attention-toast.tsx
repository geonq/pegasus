import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ThreadListEntry } from "./thread-groups";

export const ATTENTION_TOAST_MS = 8000;

interface AttentionToast {
  readonly id: number;
  readonly message: string;
  readonly workspaceId: string;
  readonly sessionId: string;
}

// One toast at a time: the newest chat that needs you replaces the older notice. Kept outside React
// so a snapshot refresh never re-renders the sidebar just to show or hide the notice.
let current: AttentionToast | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function publish(toast: AttentionToast | null) {
  current = toast;
  clearTimeout(timer);
  if (toast) timer = setTimeout(() => publish(null), ATTENTION_TOAST_MS);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function threadKey(thread: ThreadListEntry): string {
  return `${thread.workspaceId}\u0000${thread.session.id}`;
}

/** Chats that just started needing the owner, excluding the one already open. */
export function freshNeedsYou(
  previous: ReadonlySet<string>,
  needsYou: readonly ThreadListEntry[],
  selectedSessionId: string | undefined,
): readonly ThreadListEntry[] {
  return needsYou.filter(
    (thread) => !previous.has(threadKey(thread)) && thread.session.id !== selectedSessionId,
  );
}

export function attentionMessage(fresh: readonly ThreadListEntry[]): string {
  const [first] = fresh;
  if (!first) return "";
  return fresh.length === 1
    ? `${first.session.title || "A chat"} needs you`
    : `${fresh.length} chats need you`;
}

/**
 * Announces chats that newly need the owner while another chat is open. Chats already waiting when
 * the sidebar first mounts are not announced, so launch does not stack a notice per chat.
 */
export function useAttentionToasts({
  needsYou,
  selectedSessionId,
}: {
  readonly needsYou: readonly ThreadListEntry[];
  readonly selectedSessionId: string | undefined;
}) {
  const seenRef = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const previous = seenRef.current;
    seenRef.current = new Set(needsYou.map(threadKey));
    if (!previous) return;
    const fresh = freshNeedsYou(previous, needsYou, selectedSessionId);
    const first = fresh[0];
    if (!first) return;
    publish({
      id: nextId++,
      message: attentionMessage(fresh),
      workspaceId: first.workspaceId,
      sessionId: first.session.id,
    });
  }, [needsYou, selectedSessionId]);
}

export function AttentionToastHost({
  onView,
}: {
  readonly onView: (target: { workspaceId: string; sessionId: string }) => void;
}) {
  const toast = useSyncExternalStore(subscribe, () => current);
  if (!toast) return null;
  return (
    <div className="attention-toast" key={toast.id} role="status" aria-live="polite">
      <span className="attention-toast__dot" aria-hidden="true" />
      <span className="attention-toast__message">{toast.message}</span>
      <button
        className="attention-toast__action"
        type="button"
        onClick={() => {
          publish(null);
          onView({ workspaceId: toast.workspaceId, sessionId: toast.sessionId });
        }}
      >
        View
      </button>
      <button
        className="attention-toast__close"
        type="button"
        aria-label="Dismiss"
        onClick={() => publish(null)}
      >
        ×
      </button>
    </div>
  );
}
