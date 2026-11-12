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

export function transcriptDelta(
  previous: SelectedTranscriptRecord | null,
  next: SelectedTranscriptRecord | null,
  sequence: number,
): SessionTranscriptDelta | null {
  if (!next) return null;
  if (
    previous &&
    (previous.workspaceId !== next.workspaceId || previous.sessionId !== next.sessionId)
  )
    return null;
  const before = previous?.transcript ?? [];
  const after = next.transcript;
  const oldById = new Map(before.map((item) => [item.id, item]));
  const newIds = new Set(after.map((item) => item.id));
  const patches: TranscriptPatch[] = [];
  for (const item of after) {
    const old = oldById.get(item.id);
    if (!old) patches.push({ type: "append", item });
    else if (JSON.stringify(old) !== JSON.stringify(item))
      patches.push({ type: "update", id: item.id, item });
  }
  for (const item of before)
    if (!newIds.has(item.id)) patches.push({ type: "remove", id: item.id });
  if (patches.length === 0) return null;
  return {
    version: REMOTE_STATE_DELTA_VERSION,
    sequence,
    workspaceId: next.workspaceId,
    sessionId: next.sessionId,
    patches,
  };
}

export function applyTranscriptDelta(
  current: SelectedTranscriptRecord | null,
  delta: SessionTranscriptDelta,
): SelectedTranscriptRecord | null {
  if (delta.version !== REMOTE_STATE_DELTA_VERSION) return null;
  if (
    current &&
    (current.workspaceId !== delta.workspaceId || current.sessionId !== delta.sessionId)
  )
    return null;
  const items = [...(current?.transcript ?? [])];
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
  return { workspaceId: delta.workspaceId, sessionId: delta.sessionId, transcript: items };
}

export type RemoteStateSnapshot = Pick<
  DesktopAppState,
  "revision" | "workspaces" | "selectedWorkspaceId" | "selectedSessionId"
>;
