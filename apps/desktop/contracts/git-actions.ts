import type { ReviewIssue } from "./review";

/** What the review header's one git button needs to know about the repository being reviewed. */
export interface GitActionState {
  readonly state: "available";
  /** Null when HEAD is detached. */
  readonly branch: string | null;
  /** Short name of the remote branch this branch tracks, e.g. `origin/feature`. */
  readonly upstream: string | null;
  /** Remote a first push goes to (origin when present); null when the repository has none. */
  readonly remote: string | null;
  readonly ahead: number;
  readonly staged: number;
  /** Modified or untracked files that are not staged. */
  readonly unstaged: number;
  readonly conflicted: number;
  /** The default branch pull requests target, e.g. `main`; null when unknown. */
  readonly base: string | null;
  /** Commits on this branch that the base does not have; 0 when there is no base. */
  readonly aheadOfBase: number;
  readonly ghAvailable: boolean;
  /** Open pull request for this branch, when `gh` is installed and signed in. */
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
}

export type GitActionStateResult = GitActionState | ReviewIssue;

export interface DraftGitTextInput {
  readonly reviewId: string;
  readonly kind: "commit" | "pr";
}

/** Drafts are always editable text: `title` is the commit subject or the PR title. */
export type DraftGitTextResult =
  | {
      readonly state: "drafted";
      readonly title: string;
      readonly body: string;
      /** True when the chat's model could not write it and a plain summary stands in. */
      readonly fallback: boolean;
    }
  | ReviewIssue;

export type GitActionInput =
  | { readonly reviewId: string; readonly action: "stage-all" | "push" }
  | {
      readonly reviewId: string;
      readonly action: "commit";
      readonly title: string;
      readonly body: string;
    }
  | {
      readonly reviewId: string;
      readonly action: "pr";
      readonly title: string;
      readonly body: string;
    };

export type GitActionResult =
  | { readonly state: "done" }
  /** A pull request was created (`gh`) or the compare page must be opened by the caller. */
  | { readonly state: "pull-request"; readonly url: string; readonly opened: "created" | "compare" }
  | ReviewIssue;

export function decodeGitActionStateInput(value: unknown): { readonly reviewId: string } {
  return { reviewId: reviewId(record(value, ["reviewId"])) };
}

export function decodeDraftGitTextInput(value: unknown): DraftGitTextInput {
  const input = record(value, ["reviewId", "kind"]);
  if (input.kind !== "commit" && input.kind !== "pr") fail("kind");
  return { reviewId: reviewId(input), kind: input.kind };
}

export function decodeGitActionInput(value: unknown): GitActionInput {
  const input = record(value, ["reviewId", "action", "title", "body"]);
  const id = reviewId(input);
  if (input.action === "stage-all" || input.action === "push") {
    if (input.title !== undefined || input.body !== undefined) fail("fields");
    return { reviewId: id, action: input.action };
  }
  if (input.action !== "commit" && input.action !== "pr") fail("action");
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > 300 || title.includes("\0")) fail("title");
  const body = input.body === undefined ? "" : input.body;
  if (typeof body !== "string" || body.length > 60_000 || body.includes("\0")) fail("body");
  return { reviewId: id, action: input.action, title, body };
}

function reviewId(input: Record<string, unknown>): string {
  const id = input.reviewId;
  if (typeof id !== "string" || !id || id.length > 200) return fail("reviewId");
  return id;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key)))
    return fail("object fields");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(label: string): never {
  throw new Error(`Invalid git action request: ${label}`);
}
