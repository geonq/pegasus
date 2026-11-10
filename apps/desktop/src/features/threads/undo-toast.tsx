import { useSyncExternalStore } from "react";

export const UNDO_TOAST_MS = 5000;

interface UndoToast {
  readonly id: number;
  readonly message: string;
  readonly onUndo: () => void;
}

// One toast at a time: a newer action replaces the older one, as in a chat app's "Undo send".
let current: UndoToast | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function publish(toast: UndoToast | null) {
  current = toast;
  clearTimeout(timer);
  if (toast) timer = setTimeout(() => publish(null), UNDO_TOAST_MS);
  for (const listener of listeners) listener();
}

/** Offers the owner five seconds to take back a sidebar action. */
export function showUndoToast(message: string, onUndo: () => void) {
  publish({ id: nextId++, message, onUndo });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function UndoToastHost() {
  const toast = useSyncExternalStore(subscribe, () => current);
  if (!toast) return null;
  return (
    <div className="undo-toast" key={toast.id} role="status" aria-live="polite">
      <span className="undo-toast__message">{toast.message}</span>
      <button
        className="undo-toast__action"
        type="button"
        onClick={() => {
          toast.onUndo();
          publish(null);
        }}
      >
        Undo
      </button>
    </div>
  );
}
