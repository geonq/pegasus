/**
 * The host's phone routes (crates/pegasus-host/src/remote-phone.md): a compact chat list with an ETag,
 * transcript pages, and parsed diffs. Read-only; same bearer token as /v1/invoke.
 */
import { PegasusError } from "./client";
import type { Pairing, SessionStatus, TranscriptItem } from "./types";
import type { ReviewCoverage, ReviewIssue } from "../features/review/types";

export interface ChatSummary {
  readonly workspaceId: string;
  readonly id: string;
  readonly title: string;
  /** The project the chat lists under (a worktree's root project). */
  readonly projectId: string;
  readonly status: SessionStatus;
  readonly section: "needs-you" | "working" | "recent";
  readonly needsYou: boolean;
  readonly unread: boolean;
  /** lastInteractedAt, else updatedAt (ISO). */
  readonly lastActivity: string;
  /** At most 160 chars. */
  readonly preview: string;
  /** Pending extension dialogs. */
  readonly waiting?: number;
  readonly childCount?: number;
  /** A subagent chat shown on its own because it needs the owner or is working. */
  readonly child?: true;
  readonly pinnedAt?: string;
  readonly runningSince?: string;
  readonly currentStep?: string;
}

export interface ChatList {
  readonly etag: string;
  readonly revision: number | null;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly pinnedSessionOrder: readonly string[];
  /** Newest activity first. */
  readonly chats: readonly ChatSummary[];
}

export interface TranscriptPageInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** 1..200, default 50. */
  readonly limit?: number;
  /** Entry id: the page ends just before it. Omit for the newest page. */
  readonly before?: string;
}

export type PageItem = TranscriptItem & { readonly detailTruncated?: true };

export interface TranscriptPage {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly total: number;
  /** Index of `entries[0]` in the whole transcript. */
  readonly start: number;
  readonly hasMore: boolean;
  /** Oldest first. */
  readonly entries: readonly PageItem[];
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly header: string;
  /** Each keeps its " ", "+", "-" or "\" prefix. */
  readonly lines: readonly string[];
}

export interface DiffFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly binary: boolean;
  readonly hunks: readonly DiffHunk[];
}

export interface ParsedDiff {
  readonly files: readonly DiffFile[];
  readonly truncated: boolean;
  readonly omittedLines: number;
}

export type PhoneDiffResult =
  | {
      readonly state: "available";
      readonly reviewId: string;
      readonly fileId: string;
      readonly diff: ParsedDiff;
      readonly summary?: string;
      readonly coverage: ReviewCoverage;
    }
  | ReviewIssue;

async function request<T>(
  pairing: Pairing,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; etag?: string },
): Promise<{ status: number; etag: string | null; result: T | null }> {
  let response: Response;
  try {
    response = await fetch(`${pairing.url}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${pairing.token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.etag ? { "If-None-Match": `"${init.etag}"` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new PegasusError(
      `Cannot reach ${pairing.hostName}. Is Tailscale on, on both devices?`,
      "unreachable",
    );
  }
  const etag = response.headers.get("etag")?.replace(/"/g, "") ?? null;
  if (response.status === 304) return { status: 304, etag, result: null };
  const body = (await response.json().catch(() => null)) as {
    result?: T;
    error?: { code: string; message: string };
  } | null;
  if (!response.ok || !body || body.error) {
    throw new PegasusError(
      body?.error?.message ?? `Pegasus answered ${response.status}.`,
      body?.error?.code ?? "http_error",
      response.status,
    );
  }
  return { status: response.status, etag, result: body.result as T };
}

/** Thin calls to /v1/phone/*. Errors are PegasusError with the host's code (e.g. "not_selected"). */
export function phoneApi(pairing: Pairing) {
  return {
    /** Null when `etag` still matches (nothing changed, 0 bytes sent). */
    chats: async (etag?: string): Promise<ChatList | null> =>
      (await request<ChatList>(pairing, "/v1/phone/chats", { method: "GET", etag })).result,
    transcriptPage: async (input: TranscriptPageInput): Promise<TranscriptPage> =>
      (
        await request<TranscriptPage>(pairing, "/v1/phone/transcript", {
          method: "POST",
          body: input,
        })
      ).result as TranscriptPage,
    diff: async (reviewId: string, fileId: string, maxBytes?: number): Promise<PhoneDiffResult> =>
      (
        await request<PhoneDiffResult>(pairing, "/v1/phone/diff", {
          method: "POST",
          body: { reviewId, fileId, ...(maxBytes === undefined ? {} : { maxBytes }) },
        })
      ).result as PhoneDiffResult,
  };
}
