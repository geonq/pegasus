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

/** One extension dialog the PC is waiting on; the driver asks only these four kinds. */
export type PendingDialog =
  | {
      readonly kind: "confirm";
      readonly requestId: string;
      readonly title: string;
      readonly message: string;
      readonly defaultValue?: boolean;
    }
  | {
      readonly kind: "input";
      readonly requestId: string;
      readonly title: string;
      readonly placeholder?: string;
      readonly initialValue?: string;
    }
  | {
      readonly kind: "select";
      readonly requestId: string;
      readonly title: string;
      readonly options: readonly string[];
      readonly allowMultiple?: boolean;
    }
  | {
      readonly kind: "editor";
      readonly requestId: string;
      readonly title: string;
      readonly initialValue?: string;
    };

/** What the phone sends back; the PC checks it against the dialog still being pending. */
export type PendingDialogAnswer =
  | { readonly requestId: string; readonly confirmed: boolean }
  | { readonly requestId: string; readonly value: string }
  | { readonly requestId: string; readonly cancelled: true };

export interface SessionExtensionUiState {
  readonly pendingDialogs: readonly PendingDialog[];
}

/** A message sent while a run is live and held by the PC until the run reaches it. */
export interface QueuedComposerMessage {
  readonly id: string;
  readonly mode: "steer" | "followUp";
  readonly text: string;
  readonly createdAt: string;
}

/** One subscription window as pi reports it, e.g. `windowMinutes: 300` for the 5-hour window. */
export interface SessionPlanLimit {
  readonly windowMinutes: number;
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

export interface SessionPlanLimits {
  readonly provider: string;
  readonly limits: readonly SessionPlanLimit[];
  readonly reportedAt: string;
}

export interface SessionUsageSnapshot {
  readonly planLimits?: SessionPlanLimits;
  /** True when the provider bills through a subscription, so `totals.cost` is not money spent. */
  readonly subscription: boolean;
  readonly totals?: { readonly cost: number };
}

export type OrchestrationChildStatus = "queued" | "running" | "waiting" | "complete" | "failed";

export interface OrchestrationChildThread {
  readonly id: string;
  readonly title: string;
  readonly role?: string;
  readonly status: OrchestrationChildStatus;
  readonly latestTranscript: string;
  readonly parentWorkspaceId: string;
  readonly parentSessionId: string;
  readonly childWorkspaceId: string;
  readonly childSessionId: string;
  readonly updatedAt: string;
}

/** One signed-in account's plan windows, from the PC's `getAccountLimits`. */
export interface AccountLimitWindow {
  readonly label: string;
  readonly usedPercent: number;
  /** Epoch ms. */
  readonly resetsAt?: number;
}

export interface AccountLimits {
  readonly id: string;
  readonly name: string;
  readonly windows: readonly AccountLimitWindow[];
  readonly asOf: number;
  /** Where the numbers come from, or why there are none. */
  readonly note?: string;
}

export interface DesktopAppState {
  readonly revision: number;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  /**
   * These four are what the PC already sends (the desktop projection filters them to the workspaces
   * this phone may see). Optional so a phone build newer than the PC still connects.
   */
  readonly sessionExtensionUiBySession?: Readonly<Record<string, SessionExtensionUiState>>;
  readonly queuedComposerMessages?: readonly QueuedComposerMessage[];
  readonly sessionUsageBySession?: Readonly<Record<string, SessionUsageSnapshot>>;
  readonly orchestrationChildren?: readonly OrchestrationChildThread[];
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
