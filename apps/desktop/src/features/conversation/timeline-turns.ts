import type { TurnChangeSummary } from "../../../contracts/review";
import type {
  DisplayTimelineItem,
  TimelineTranscriptItem,
  TimelineTurnMarker,
} from "../../../contracts/timeline-types";

const MIN_WORKED_DURATION_MS = 1_000;

function isUserMessage(item: TimelineTranscriptItem | undefined): boolean {
  return item?.kind === "message" && item.role === "user";
}

/**
 * Insert "Worked for Ns" turn markers, derived purely from real message/tool
 * timestamps. A turn begins at a user message and runs until the next user
 * message; the marker sits directly above the turn's final assistant reply
 * (Codex-style), or at the end of the turn when it has no assistant reply, and
 * reports the elapsed time from the prompt to the last item of that turn.
 *
 * Durations are never fabricated: a marker is emitted only when the turn has
 * downstream work and both endpoints carry parseable timestamps spanning at
 * least one second. The turn still in progress gets no marker, since its final
 * reply is not known yet.
 *
 * Each captured turn that changed files gets a changes card at the end of that turn: after
 * the last transcript item of the turn and any rows that follow it, before the next user
 * message or extension message.
 */
export function buildDisplayTimelineItems(
  source: readonly TimelineTranscriptItem[],
  options: {
    readonly lastTurnRunning?: boolean;
    readonly turnChanges?: readonly TurnChangeSummary[];
    /** Titles of this chat's subagents that are still working after its own turn ended. */
    readonly subagentsWorking?: readonly string[];
  } = {},
): readonly DisplayTimelineItem[] {
  const transcript = withSubagentsWorking(withThoughtDurations(withWorkingLast(source), options.lastTurnRunning === true), options);
  // Marker to emit immediately before the transcript item at that index.
  // Index `transcript.length` means "after the last item".
  const markersBefore = new Map<number, TimelineTurnMarker>();

  for (let start = 0; start < transcript.length; start += 1) {
    const prompt = transcript[start];
    if (!prompt || !isUserMessage(prompt)) {
      continue;
    }

    let end = start + 1;
    while (end < transcript.length && !isUserMessage(transcript[end])) {
      end += 1;
    }
    if (end === transcript.length && options.lastTurnRunning) {
      break;
    }

    const startMs = Date.parse(prompt.createdAt);
    if (Number.isNaN(startMs)) {
      continue;
    }

    let endMs: number | null = null;
    let finalReplyIndex: number | null = null;
    for (let index = start + 1; index < end; index += 1) {
      const item = transcript[index];
      if (!item) {
        continue;
      }
      if (item.kind === "message" && item.role === "assistant") {
        finalReplyIndex = index;
      }
      // An extension can post into the thread long after the run settled, and a keyed card
      // carries its latest write's time; a message steered into the run is already covered
      // by the reply that follows it.
      if (item.kind === "custom" || item.kind === "card") {
        continue;
      }
      const itemMs = Date.parse(item.createdAt);
      if (!Number.isNaN(itemMs)) {
        endMs = endMs == null ? itemMs : Math.max(endMs, itemMs);
      }
    }

    if (endMs == null || endMs - startMs < MIN_WORKED_DURATION_MS) {
      continue;
    }

    markersBefore.set(finalReplyIndex ?? end, {
      kind: "turn-marker",
      id: `turn-marker:${prompt.id}`,
      durationMs: endMs - startMs,
    });
  }

  const cardsAfter = turnChangeCardPositions(transcript, options.turnChanges ?? []);
  if (markersBefore.size === 0 && cardsAfter.size === 0) {
    return transcript;
  }

  const result: DisplayTimelineItem[] = [];
  for (let index = 0; index <= transcript.length; index += 1) {
    const marker = markersBefore.get(index);
    if (marker) {
      result.push(marker);
    }
    const item = transcript[index];
    if (item) {
      result.push(item);
    }
    for (const turn of cardsAfter.get(index) ?? []) {
      result.push({ kind: "turn-changes", id: `turn-changes:${turn.checkpointId}`, turn });
    }
  }
  return result;
}

/** The live "Thinking…" pill is the run's leading edge, so it always renders after the latest row. */
function withWorkingLast(
  transcript: readonly TimelineTranscriptItem[],
): readonly TimelineTranscriptItem[] {
  const index = transcript.findIndex((item) => item.kind === "activity" && item.tone === "working");
  if (index < 0 || index === transcript.length - 1) return transcript;
  return [...transcript.slice(0, index), ...transcript.slice(index + 1), transcript[index]!];
}

/**
 * A live thinking row ends where the next row starts, so it reads "Thought for Ns" once the model
 * moves on, and the newest one in a running turn is still open. Rows from history already carry their duration; a gap under a second means the two
 * rows share one saved timestamp, which says nothing about how long the thinking took.
 */
function withThoughtDurations(
  transcript: readonly TimelineTranscriptItem[],
  running: boolean,
): readonly TimelineTranscriptItem[] {
  let changed = false;
  const result = transcript.map((item, index) => {
    if (item.kind !== "thinking" || item.durationMs !== undefined) return item;
    const next = transcript
      .slice(index + 1)
      .find((later) => !(later.kind === "activity" && later.tone === "working"));
    if (!next && running) {
      changed = true;
      return { ...item, open: true };
    }
    const durationMs = next ? Date.parse(next.createdAt) - Date.parse(item.createdAt) : NaN;
    if (!(durationMs >= MIN_WORKED_DURATION_MS)) return item;
    changed = true;
    return { ...item, durationMs };
  });
  return changed ? result : transcript;
}

/** A chat whose own turn ended still shows that its subagents are working. */
function withSubagentsWorking(
  transcript: readonly TimelineTranscriptItem[],
  options: { readonly lastTurnRunning?: boolean; readonly subagentsWorking?: readonly string[] },
): readonly TimelineTranscriptItem[] {
  const titles = options.subagentsWorking ?? [];
  const last = transcript.at(-1);
  if (options.lastTurnRunning || titles.length === 0 || !last) return transcript;
  return [
    ...transcript,
    {
      kind: "activity",
      id: "subagents-working",
      createdAt: last.createdAt,
      label: titles.length === 1 ? "1 subagent working" : `${titles.length} subagents working`,
      entries: titles,
      tone: "working",
      activityState: "solving",
    },
  ];
}

/** Titles of the selected chat's subagents that are queued, running or waiting. */
export function subagentTitles(
  state:
    | {
        readonly selectedWorkspaceId: string;
        readonly selectedSessionId: string;
        readonly orchestrationChildren: readonly {
          readonly parentWorkspaceId: string;
          readonly parentSessionId: string;
          readonly status: string;
          readonly title: string;
        }[];
      }
    | null
    | undefined,
): readonly string[] {
  if (!state?.selectedSessionId) return [];
  return state.orchestrationChildren
    .filter(
      (child) =>
        child.parentWorkspaceId === state.selectedWorkspaceId &&
        child.parentSessionId === state.selectedSessionId &&
        (child.status === "running" || child.status === "queued" || child.status === "waiting"),
    )
    .map((child) => child.title);
}

function turnChangeCardPositions(
  transcript: readonly TimelineTranscriptItem[],
  turnChanges: readonly TurnChangeSummary[],
): ReadonlyMap<number, TurnChangeSummary[]> {
  const positions = new Map<number, TurnChangeSummary[]>();
  if (turnChanges.length === 0) return positions;
  const turnByEntry = new Map<string, TurnChangeSummary>();
  for (const turn of turnChanges)
    for (const entryId of turn.entryIds) turnByEntry.set(entryId, turn);
  const lastIndex = new Map<TurnChangeSummary, number>();
  transcript.forEach((item, index) => {
    if (item.kind !== "message") return;
    const turn = turnByEntry.get(item.sourceMessageId ?? item.id);
    if (turn) lastIndex.set(turn, index);
  });
  // Cards keep the capture order when several turns end at the same row.
  for (const turn of turnChanges) {
    let index = lastIndex.get(turn);
    if (index === undefined) continue;
    while (index + 1 < transcript.length && !startsAnotherTurn(transcript[index + 1], turn)) {
      index += 1;
    }
    positions.set(index, [...(positions.get(index) ?? []), turn]);
  }
  return positions;

  function startsAnotherTurn(item: TimelineTranscriptItem | undefined, turn: TurnChangeSummary) {
    // A later extension message or card is not part of the turn's work, so the card stays above it.
    if (item?.kind === "custom" || item?.kind === "card") return true;
    if (item?.kind !== "message") return false;
    const owner = turnByEntry.get(item.sourceMessageId ?? item.id);
    return item.role === "user" || (owner !== undefined && owner !== turn);
  }
}
