import type { TranscriptItem, TranscriptMessage, TranscriptTool } from "./types";

/** Tools the app draws as the interface they describe (desktop contracts/generative-ui.ts). */
export const GENERATIVE_UI_TOOLS: ReadonlySet<string> = new Set(["ask_user", "show_ui"]);

export type WorkLogRow =
  | { readonly kind: "message"; readonly id: string; readonly item: TranscriptMessage }
  | {
      readonly kind: "thinking";
      readonly id: string;
      readonly text: string;
      readonly durationMs?: number;
    }
  | {
      readonly kind: "activity";
      readonly id: string;
      readonly label: string;
      /** Names under the label, one per line (the subagents still working). */
      readonly entries: readonly string[];
    }
  | { readonly kind: "custom"; readonly id: string; readonly text: string }
  /** An ask_user or show_ui call: drawn as a card, never folded into a tool run. */
  | { readonly kind: "ui"; readonly id: string; readonly tool: TranscriptTool }
  | {
      readonly kind: "tools";
      readonly id: string;
      readonly tools: readonly TranscriptTool[];
      /** Per tool: until the next row started; undefined for the transcript's last row. */
      readonly durations: readonly (number | undefined)[];
      /** Count of tool calls that failed, so one failed call is visible in a collapsed row. */
      readonly failed: number;
      readonly running: boolean;
      readonly startedAt: string;
      readonly endedAt: string;
      /** From the first call to the row after the run; undefined while the run ends the transcript. */
      readonly durationMs?: number;
    };

function isTool(item: TranscriptItem | undefined): item is TranscriptTool {
  return item?.kind === "tool" && "label" in item;
}

function createdAtOf(item: TranscriptItem | undefined): number | undefined {
  if (!item || !("createdAt" in item) || typeof item.createdAt !== "string") return undefined;
  const at = Date.parse(item.createdAt);
  return Number.isNaN(at) ? undefined : at;
}

function between(start: TranscriptItem | undefined, end: TranscriptItem | undefined) {
  const from = createdAtOf(start);
  const to = createdAtOf(end);
  return from === undefined || to === undefined ? undefined : Math.max(0, to - from);
}

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
    if (isTool(item) && GENERATIVE_UI_TOOLS.has(item.toolName)) {
      rows.push({ kind: "ui", id: item.id, tool: item });
      index += 1;
      continue;
    }
    if (isTool(item)) {
      const tools: TranscriptTool[] = [];
      const durations: (number | undefined)[] = [];
      while (index < items.length) {
        const run = items[index];
        if (!isTool(run) || GENERATIVE_UI_TOOLS.has(run.toolName)) break;
        tools.push(run);
        durations.push(run.status === "running" ? undefined : between(run, items[index + 1]));
        index += 1;
      }
      const first = tools[0];
      if (!first) continue;
      const last = tools[tools.length - 1] ?? first;
      const running = tools.some((tool) => tool.status === "running");
      const durationMs = running ? undefined : between(first, items[index]);
      rows.push({
        kind: "tools",
        id: `tools:${first.id}`,
        tools,
        durations,
        failed: tools.filter((tool) => tool.status === "error").length,
        running,
        startedAt: first.createdAt,
        endedAt: last.createdAt,
        ...(durationMs === undefined ? {} : { durationMs }),
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
      const raw: unknown = (item as { readonly entries?: unknown }).entries;
      const entries = Array.isArray(raw)
        ? raw.filter((entry): entry is string => typeof entry === "string")
        : [];
      rows.push({ kind: "activity", id: item.id, label: item.label, entries });
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
