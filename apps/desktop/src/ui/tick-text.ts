// One shared second tick for live labels (elapsed times). A label subscribes through a ref
// callback and rewrites its own text node, so a ticking clock never re-renders React: not the
// app shell, not the timeline, not the row around it. Pattern from T3 Code's tickTextContent.

type Listener = () => void;

const listeners = new Set<Listener>();
let timer = 0;

function subscribeSecond(listener: Listener): () => void {
  listeners.add(listener);
  if (!timer) {
    timer = window.setInterval(() => {
      for (const write of listeners) write();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      window.clearInterval(timer);
      timer = 0;
    }
  };
}

/**
 * Ref callback that writes `format(Date.now())` into the node now and, while `live`, again on
 * every shared second tick. Pass a stable callback (useCallback) so React does not detach and
 * reattach it on every render.
 */
export function tickTextContent(
  format: (nowMs: number) => string,
  live = true,
): (node: HTMLElement | null) => (() => void) | undefined {
  return (node) => {
    if (!node) return undefined;
    const write = () => {
      const text = format(Date.now());
      if (node.textContent !== text) node.textContent = text;
    };
    write();
    return live ? subscribeSecond(write) : undefined;
  };
}

/** "12s", "3m 4s", "1h 5m": the elapsed time between two instants, never below one second. */
export function formatElapsed(startMs: number, nowMs: number): string {
  const totalSeconds = Math.max(1, Math.floor((nowMs - startMs) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
