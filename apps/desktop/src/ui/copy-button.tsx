import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";

/**
 * Copies `text` and confirms in place with a check for 1.5 s, no toast (Orca's chat copy button).
 * `text` may be a function so a long message is only read when the button is pressed.
 */
export function CopyButton({
  text,
  label,
  className,
  showLabel = false,
  testId,
}: {
  readonly text: string | (() => string);
  readonly label: string;
  readonly className: string;
  readonly showLabel?: boolean;
  readonly testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = () => {
    const value = typeof text === "function" ? text() : text;
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      },
      (error: unknown) => console.error("[renderer] copy failed", error),
    );
  };

  const current = copied ? "Copied" : label;
  return (
    <button
      aria-label={current}
      className={className}
      data-copied={copied ? "" : undefined}
      data-testid={testId}
      title={current}
      type="button"
      onClick={copy}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {showLabel ? <span className="timeline-item__action-label">{current}</span> : null}
    </button>
  );
}
