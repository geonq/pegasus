import type { DesktopAppState, SelectedTranscriptRecord } from "../../contracts/desktop-state";
import type { TranscriptMessage } from "../../contracts/timeline-types";

export const REMOTE_STATE_DELTA_VERSION = 1 as const;

export type TranscriptPatch =
  | { readonly type: "append"; readonly item: TranscriptMessage }
  | { readonly type: "update"; readonly id: string; readonly item: TranscriptMessage }
  | { readonly type: "remove"; readonly id: string };

export interface SessionTranscriptDelta {
  readonly version: typeof REMOTE_STATE_DELTA_VERSION;
  readonly sequence: number;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly patches: readonly TranscriptPatch[];
}

/**
 * How `next` differs from `previous`: nothing, a delta, or "full" when only the whole record can
 * say it (another session, no record, or an order a delta cannot rebuild).
 */
export function transcriptChange(
  previous: SelectedTranscriptRecord | null,
  next: SelectedTranscriptRecord | null,
  sequence: number,
): SessionTranscriptDelta | "none" | "full" {
  if (!next || !previous) return previous === next ? "none" : "full";
  if (previous.workspaceId !== next.workspaceId || previous.sessionId !== next.sessionId)
    return "full";
  const before = previous.transcript;
  const after = next.transcript;
  const oldById = new Map(before.map((item) => [item.id, item]));
  const newIds = new Set(after.map((item) => item.id));
  // Patches rebuild order only when kept rows stay in order and new rows come after them all;
  // anything else (a row inserted mid-transcript, a reorder) is sent whole.
  const kept = before.filter((item) => newIds.has(item.id)).map((item) => item.id);
  for (let index = 0; index < after.length; index += 1) {
    const expected = index < kept.length ? kept[index] : undefined;
    if (expected !== undefined ? after[index]!.id !== expected : oldById.has(after[index]!.id))
      return "full";
  }
  const patches: TranscriptPatch[] = [];
  for (const item of before)
    if (!newIds.has(item.id)) patches.push({ type: "remove", id: item.id });
  for (const item of after) {
    const old = oldById.get(item.id);
    if (!old) patches.push({ type: "append", item });
    else if (old !== item && JSON.stringify(old) !== JSON.stringify(item))
      patches.push({ type: "update", id: item.id, item });
  }
  if (patches.length === 0) return "none";
  return {
    version: REMOTE_STATE_DELTA_VERSION,
    sequence,
    workspaceId: next.workspaceId,
    sessionId: next.sessionId,
    patches,
  };
}

/** The delta from `previous` to `next`, or null when there is none or only a full record can say it. */
export function transcriptDelta(
  previous: SelectedTranscriptRecord | null,
  next: SelectedTranscriptRecord | null,
  sequence: number,
): SessionTranscriptDelta | null {
  const change = transcriptChange(previous, next, sequence);
  return typeof change === "string" ? null : change;
}

export function applyTranscriptDelta(
  current: SelectedTranscriptRecord | null,
  delta: SessionTranscriptDelta,
): SelectedTranscriptRecord | null {
  if (delta.version !== REMOTE_STATE_DELTA_VERSION || !current) return null;
  if (current.workspaceId !== delta.workspaceId || current.sessionId !== delta.sessionId)
    return null;
  const items = [...current.transcript];
  for (const patch of delta.patches) {
    if (patch.type === "append") items.push(patch.item);
    else if (patch.type === "remove") {
      const index = items.findIndex((item) => item.id === patch.id);
      if (index >= 0) items.splice(index, 1);
    } else {
      const index = items.findIndex((item) => item.id === patch.id);
      if (index >= 0) items[index] = patch.item;
      else items.push(patch.item);
    }
  }
  return { ...current, transcript: items };
}

export type RemoteStateSnapshot = Pick<
  DesktopAppState,
  "revision" | "workspaces" | "selectedWorkspaceId" | "selectedSessionId"
>;
