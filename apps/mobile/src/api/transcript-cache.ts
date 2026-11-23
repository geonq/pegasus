import type { SelectedTranscript } from "./types.ts";

/**
 * The last transcript the phone saw for each recently opened chat, so reopening a chat draws it at
 * once while the PC selects it and streams the fresh one. Memory only: shown as a stale copy until
 * the live transcript replaces it, never sent anywhere.
 * shortcut: lost when the app is killed; persist it (expo-file-system) if cold opens must be instant.
 */
export class TranscriptCache {
  private readonly entries = new Map<string, SelectedTranscript>();
  private readonly limit: number;

  constructor(limit = 12) {
    this.limit = limit;
  }

  static keyOf(workspaceId: string, sessionId: string): string {
    return `${workspaceId}:${sessionId}`;
  }

  /** Keeps the transcript as its chat's newest copy, dropping the least recently used beyond limit. */
  remember(transcript: SelectedTranscript | null): void {
    if (!transcript) return;
    const key = TranscriptCache.keyOf(transcript.workspaceId, transcript.sessionId);
    if (this.entries.get(key) === transcript) return;
    this.entries.delete(key);
    this.entries.set(key, transcript);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(workspaceId: string, sessionId: string): SelectedTranscript | undefined {
    return this.entries.get(TranscriptCache.keyOf(workspaceId, sessionId));
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * What the chat screen draws: the live transcript when it is this chat's, else the cached copy
 * (marked stale), else nothing yet.
 */
export function transcriptFor(
  live: SelectedTranscript | null,
  cache: Pick<TranscriptCache, "get">,
  workspaceId: string,
  sessionId: string,
): { readonly transcript: SelectedTranscript | null; readonly stale: boolean } {
  if (live && live.workspaceId === workspaceId && live.sessionId === sessionId) {
    return { transcript: live, stale: false };
  }
  const cached = cache.get(workspaceId, sessionId);
  return cached ? { transcript: cached, stale: true } : { transcript: null, stale: false };
}
