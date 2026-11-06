import type {
  SessionTranscriptCard,
  SessionTranscriptCustomMessage,
  SessionTranscriptMessage,
  SessionTranscriptPin,
  SessionTranscriptRole,
  SessionTranscriptThinking,
} from "@pi-gui/session-driver";
import type { TurnChangeSummary } from "./review";
import type { AgentActivityState } from "./agent-activity";

export type SessionRole = SessionTranscriptRole;
export type TimelineTone = "neutral" | "success" | "warning" | "error" | "working";
export type TimelineToolStatus = "running" | "success" | "error";
export type TimelineSummaryPresentation = "inline" | "divider";

export interface TimelineActivity {
  readonly kind: "activity";
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly detail?: string;
  /** Names listed under the label, one per line (the subagents still working). */
  readonly entries?: readonly string[];
  readonly metadata?: string;
  readonly tone?: TimelineTone;
  readonly activityState?: AgentActivityState;
}

export interface TimelineToolCall {
  readonly kind: "tool";
  readonly id: string;
  readonly callId: string;
  readonly toolName: string;
  readonly status: TimelineToolStatus;
  readonly label: string;
  readonly detail?: string;
  readonly metadata?: string;
  readonly createdAt: string;
  readonly input?: unknown;
  readonly output?: unknown;
}

export interface TimelineSummary {
  readonly kind: "summary";
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly metadata?: string;
  readonly presentation: TimelineSummaryPresentation;
}

export type TranscriptMessage =
  | SessionTranscriptMessage
  | SessionTranscriptCustomMessage
  // `open` marks the thinking still streaming in a running turn; the timeline sets it for display.
  | (SessionTranscriptThinking & { readonly open?: boolean })
  | SessionTranscriptCard
  | SessionTranscriptPin
  | TimelineActivity
  | TimelineToolCall
  | TimelineSummary;

/**
 * What the conversation timeline draws: the transcript without its pins, which show above the
 * composer. The renderer splits them off once, so a pin reaching the timeline fails typecheck.
 */
export type TimelineTranscriptItem = Exclude<TranscriptMessage, SessionTranscriptPin>;

/**
 * A derived, view-only marker inserted between turns to show how long the agent
 * worked on the preceding user prompt. Never persisted or produced by the store;
 * the timeline computes it from real message/tool timestamps at render time, so
 * it is kept out of {@link TranscriptMessage} to avoid leaking into store code.
 */
export interface TimelineTurnMarker {
  readonly kind: "turn-marker";
  readonly id: string;
  readonly durationMs: number;
}

/** A derived, view-only card listing the files one captured turn changed, placed after that turn. */
export interface TimelineTurnChanges {
  readonly kind: "turn-changes";
  readonly id: string;
  readonly turn: TurnChangeSummary;
}

/** A derived, view-only row folding a run of finished reads and searches: "Explored 4 files, 2 searches". */
export interface TimelineToolGroup {
  readonly kind: "tool-group";
  /** The first folded row's id, so the group keeps its place as later rows join it. */
  readonly id: string;
  readonly label: string;
  readonly tools: readonly TimelineToolCall[];
}

export type DisplayTimelineItem =
  TimelineTranscriptItem | TimelineTurnMarker | TimelineTurnChanges | TimelineToolGroup;
