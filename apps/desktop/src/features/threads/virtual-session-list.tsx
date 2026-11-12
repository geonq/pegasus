import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Past this many rows a list is windowed (T3 Code Sidebar.tsx and Orca's worktree list both
 * virtualise long thread lists). Short lists render plainly, so fold motion, drag and the
 * keyboard order stay untouched for the common case.
 */
export const VIRTUAL_SESSION_LIST_THRESHOLD = 40;
const ROW_ESTIMATE = 44;

/** The nearest ancestor that scrolls: the sidebar's own section, not the window. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

export function VirtualSessionList<T>({
  items,
  itemKey,
  renderItem,
  className,
}: {
  readonly items: readonly T[];
  readonly itemKey: (item: T) => string;
  readonly renderItem: (item: T) => ReactNode;
  readonly className?: string;
}) {
  if (items.length <= VIRTUAL_SESSION_LIST_THRESHOLD) {
    return <div className={className}>{items.map((item) => renderItem(item))}</div>;
  }
  return (
    <WindowedList items={items} itemKey={itemKey} renderItem={renderItem} className={className} />
  );
}

function WindowedList<T>({
  items,
  itemKey,
  renderItem,
  className,
}: {
  readonly items: readonly T[];
  readonly itemKey: (item: T) => string;
  readonly renderItem: (item: T) => ReactNode;
  readonly className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const list = listRef.current;
    const parent = scrollParent(list);
    setScroller(parent);
    if (list && parent) {
      setScrollMargin(
        list.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop,
      );
    }
  }, [items.length]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 10,
    scrollMargin,
    getItemKey: (index) => itemKey(items[index]!),
  });

  return (
    <div
      ref={listRef}
      className={className}
      style={{ height: virtualizer.getTotalSize(), position: "relative", display: "block" }}
    >
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          ref={virtualizer.measureElement}
          data-index={row.index}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${row.start - scrollMargin}px)`,
          }}
        >
          {renderItem(items[row.index]!)}
        </div>
      ))}
    </div>
  );
}
