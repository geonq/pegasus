import { createElement, useCallback } from "react";
import { formatElapsed, tickTextContent } from "../../../ui/tick-text";

/**
 * "Working for 12s" that counts up in place. The text is written into the node on a shared
 * second tick, so the header (and the app around it) does not re-render once a second.
 */
export function RunningLabel({ startedAt }: { readonly startedAt: string | undefined }) {
  const ref = useCallback(
    (node: HTMLElement | null) =>
      tickTextContent((now) => formatRunningLabel(startedAt, now), Boolean(startedAt))(node),
    [startedAt],
  );
  return createElement("span", { ref, "data-testid": "running-label" });
}

export function formatRunningLabel(startedAt: string | undefined, nowMs: number): string {
  const startMs = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(startMs)) return "Working…";
  return `Working for ${formatElapsed(startMs, nowMs)}`;
}
