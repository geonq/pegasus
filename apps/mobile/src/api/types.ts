/**
 * The part of the desktop's wire types the phone reads. Source of truth: apps/desktop/contracts
 * (desktop-state.ts, timeline-types.ts) and packages/session-driver/src/transcript.ts.
 * apps/desktop/electron/remote/mobile-wire-types.check.ts checks at compile time that the desktop types
 * are assignable to these, so a breaking change there fails the desktop typecheck instead of the phone.
 */

export type SessionStatus = "idle" | "running" | "failed";

export interface SessionRecord {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly pinnedAt?: string;
  readonly preview: string;
  readonly status: SessionStatus;
  readonly runningSince?: string;
  readonly hasUnseenUpdate: boolean;
  readonly currentStep?: string;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: string;
  readonly sessions: readonly SessionRecord[];
}

export interface DesktopAppState {
  readonly revision: number;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
}

export interface TranscriptMessage {
  readonly kind: "message";
  readonly id: string;
  readonly role: "user" | "assistant" | "branchSummary" | "compactionSummary";
  readonly text: string;
  readonly createdAt: string;
}

export interface TranscriptThinking {
  readonly kind: "thinking";
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly durationMs?: number;
}

export interface TranscriptTool {
  readonly kind: "tool";
  readonly id: string;
  readonly toolName: string;
  readonly status: "running" | "success" | "error";
  readonly label: string;
  readonly detail?: string;
  readonly createdAt: string;
}

export interface TranscriptActivity {
  readonly kind: "activity";
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly createdAt: string;
}

export interface TranscriptCustom {
  readonly kind: "custom";
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
}

/** Rows the phone shows; other kinds (cards, pins, summaries) are skipped. */
export type TranscriptItem =
  | TranscriptMessage
  | TranscriptThinking
  | TranscriptTool
  | TranscriptActivity
  | TranscriptCustom
  | { readonly kind: string; readonly id: string };

export interface SelectedTranscript {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly transcript: readonly TranscriptItem[];
}

export const REMOTE_STATE_DELTA_VERSION = 1 as const;
export type TranscriptPatch =
  | { readonly type: "append"; readonly item: TranscriptItem }
  | { readonly type: "update"; readonly id: string; readonly item: TranscriptItem }
  | { readonly type: "remove"; readonly id: string };
export interface SessionTranscriptDelta {
  readonly version: typeof REMOTE_STATE_DELTA_VERSION;
  readonly sequence: number;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly patches: readonly TranscriptPatch[];
}
export function applyTranscriptDelta(
  current: SelectedTranscript | null,
  delta: SessionTranscriptDelta,
): SelectedTranscript | null {
  if (delta.version !== REMOTE_STATE_DELTA_VERSION) return null;
  if (
    current &&
    (current.workspaceId !== delta.workspaceId || current.sessionId !== delta.sessionId)
  )
    return null;
  const transcript = [...(current?.transcript ?? [])];
  for (const patch of delta.patches) {
    if (patch.type === "append") transcript.push(patch.item);
    else if (patch.type === "remove") {
      const index = transcript.findIndex((item) => item.id === patch.id);
      if (index >= 0) transcript.splice(index, 1);
    } else {
      const index = transcript.findIndex((item) => item.id === patch.id);
      if (index >= 0) transcript[index] = patch.item;
      else transcript.push(patch.item);
    }
  }
  return { workspaceId: delta.workspaceId, sessionId: delta.sessionId, transcript };
}

export type RemoteEvent =
  | { readonly type: "stateChanged"; readonly state: DesktopAppState }
  | { readonly type: "sessionTranscriptDelta"; readonly delta: SessionTranscriptDelta }
  | { readonly type: "selectedTranscriptChanged"; readonly transcript: SelectedTranscript | null }
  | { readonly type: "terminalData" | "terminalExit" | "terminalError"; readonly event: unknown };

/** The phone's connection, from the pairing QR code. */
export interface Pairing {
  readonly url: string;
  readonly token: string;
  readonly hostName: string;
}
