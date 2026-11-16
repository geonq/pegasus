import type { TranscriptItem, TranscriptMessage, TranscriptTool } from "./types";

export type WorkLogRow =
  | { readonly kind: "message"; readonly id: string; readonly item: TranscriptMessage }
  | {
      readonly kind: "thinking";
      readonly id: string;
      readonly text: string;
      readonly durationMs?: number;
    }
  | { readonly kind: "activity"; readonly id: string; readonly label: string }
  | { readonly kind: "custom"; readonly id: string; readonly text: string }
  | {
      readonly kind: "tools";
      readonly id: string;
      readonly tools: readonly TranscriptTool[];
      /** Count of tool calls that failed, so one failed call is visible in a collapsed row. */
      readonly failed: number;
      readonly running: boolean;
      readonly startedAt: string;
      readonly endedAt: string;
    };

/**
 * The phone's work log: messages stay as they are, and every run of consecutive tool calls
 * collapses into one row (a 40-row tool dump is not readable on a phone). Pure and derived on
 * every render; the expanded/collapsed choice is the screen's own local state, nothing here is kept.
 */
export function groupTranscript(items: readonly TranscriptItem[]): WorkLogRow[] {
  const rows: WorkLogRow[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (!item) break;
    if (item.kind === "tool" && "label" in item) {
      const tools: TranscriptTool[] = [];
      while (index < items.length) {
        const run = items[index];
        if (!run || run.kind !== "tool" || !("label" in run)) break;
        tools.push(run);
        index += 1;
      }
      const first = tools[0];
      if (!first) continue;
      const last = tools[tools.length - 1] ?? first;
      rows.push({
        kind: "tools",
        id: `tools:${first.id}`,
        tools,
        failed: tools.filter((tool) => tool.status === "error").length,
        running: tools.some((tool) => tool.status === "running"),
        startedAt: first.createdAt,
        endedAt: last.createdAt,
      });
      continue;
    }
    index += 1;
    if (item.kind === "message" && "role" in item) {
      rows.push({ kind: "message", id: item.id, item });
    } else if (item.kind === "thinking" && "text" in item) {
      rows.push({
        kind: "thinking",
        id: item.id,
        text: item.text,
        ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
      });
    } else if (item.kind === "activity" && "label" in item) {
      rows.push({ kind: "activity", id: item.id, label: item.label });
    } else if (item.kind === "custom" && "text" in item) {
      rows.push({ kind: "custom", id: item.id, text: item.text });
    }
  }
  return rows;
}

/** "4 steps · 1 failed", the whole of what a collapsed tool run says. */
export function toolsSummary(count: number, failed: number, running: boolean): string {
  const steps = count === 1 ? "1 step" : `${count} steps`;
  const failure = failed === 0 ? "" : ` · ${failed} failed`;
  return running ? `${steps} · running` : `${steps}${failure}`;
}

/** "12s", "1m 04s", "1h 02m": short enough for one line, never a growing number of fields. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
