import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** The folded height in rem; a prompt folds only when it is at least twice this tall. */
const FOLDED_REM = 11;

// Opened folds by message id. Rows unmount when scrolled out of the window, so the choice lives
// outside React to survive that; it is never persisted.
const openFolds = new Set<string>();

/**
 * A long pasted prompt is cut to 11rem with a fade and a "Show full message" button (T3's
 * useTallEnoughToFold, Orca's NativeChatUserMessageFold). Short prompts render unchanged.
 */
export function UserMessageFold({
  messageId,
  children,
}: {
  readonly messageId: string;
  readonly children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(() => openFolds.has(messageId));
  const clipId = useId();

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;
    const measure = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setTall(content.offsetHeight >= FOLDED_REM * 2 * rem);
    };
    // Measured before paint so a long prompt never shows one unfolded frame.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const folded = tall && !open;
  return (
    <>
      <div
        className="user-message-fold"
        data-folded={folded ? "" : undefined}
        data-testid="user-message-fold"
        id={clipId}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {tall ? (
        <button
          aria-controls={clipId}
          aria-expanded={open}
          className="user-message-fold__toggle"
          data-testid="user-message-fold-toggle"
          type="button"
          onClick={() => {
            const next = !open;
            if (next) openFolds.add(messageId);
            else openFolds.delete(messageId);
            setOpen(next);
          }}
        >
          {open ? "Show less" : "Show full message"}
        </button>
      ) : null}
    </>
  );
}
