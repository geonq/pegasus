/**
 * The review and git-action wire types the phone reads. Source of truth:
 * apps/desktop/contracts/review.ts and apps/desktop/contracts/git-actions.ts (copied, trimmed).
 */

export interface SessionRef {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export type ReviewScope =
  | { readonly kind: "uncommitted" }
  | { readonly kind: "staged" }
  | { readonly kind: "unstaged" }
  | { readonly kind: "branch"; readonly baseRef?: string }
  | { readonly kind: "turn"; readonly checkpointId?: string };

export interface ReviewCoverage {
  readonly state: "complete" | "partial";
  readonly notes: readonly string[];
}

export interface ReviewIssue {
  readonly state: "stale" | "unavailable" | "failed";
  readonly code: string;
  readonly message: string;
}

export type ReviewFileStatus =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "typechanged";

export interface ReviewLineCounts {
  readonly added: number;
  readonly removed: number;
}

export interface ReviewFileEntry {
  readonly id: string;
  readonly path: string;
  readonly previousPath?: string;
  readonly status: ReviewFileStatus;
  readonly hasStagedChanges: boolean;
  readonly hasUnstagedChanges: boolean;
  readonly conflicted: boolean;
  readonly reviewed: boolean;
  /** Null for binary files or when Git could not count them. */
  readonly lines: ReviewLineCounts | null;
}

export interface AvailableReview {
  readonly state: "available";
  readonly reviewId: string;
  readonly scope: ReviewScope;
  readonly checkoutId: string;
  readonly baseLabel: string;
  readonly headOid: string | null;
  readonly baseOid: string | null;
  readonly capturedAt?: string;
  readonly branchName?: string;
  readonly files: readonly ReviewFileEntry[];
  readonly coverage: ReviewCoverage;
  readonly repository?: string;
  readonly repositories?: readonly string[];
}

export type ReviewResult = AvailableReview | ReviewIssue;

export type ReviewFileResult =
  | {
      readonly state: "available";
      readonly reviewId: string;
      readonly fileId: string;
      readonly patch: string;
      readonly summary?: string;
      readonly coverage: ReviewCoverage;
    }
  | ReviewIssue;

export interface GetReviewInput {
  readonly target: SessionRef;
  readonly checkoutId: string;
  readonly scope: ReviewScope;
  readonly repository?: string;
}

export interface TurnChangedFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly lines: ReviewLineCounts | null;
}

export interface TurnChangeSummary {
  readonly checkpointId: string;
  readonly checkoutId: string;
  readonly entryIds: readonly string[];
  readonly files: readonly TurnChangedFile[];
}

export type TurnChangesResult =
  { readonly state: "available"; readonly turns: readonly TurnChangeSummary[] } | ReviewIssue;

export type SetReviewFileReviewedResult =
  | {
      readonly state: "available";
      readonly reviewId: string;
      readonly fileId: string;
      readonly reviewed: boolean;
    }
  | ReviewIssue;

export type ChangeReviewFileStageResult = { readonly state: "applied" } | ReviewIssue;

export interface GitActionState {
  readonly state: "available";
  readonly branch: string | null;
  readonly upstream: string | null;
  readonly remote: string | null;
  readonly ahead: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly conflicted: number;
  readonly base: string | null;
  readonly aheadOfBase: number;
  readonly ghAvailable: boolean;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
}

export type GitActionStateResult = GitActionState | ReviewIssue;

export type DraftGitTextResult =
  | {
      readonly state: "drafted";
      readonly title: string;
      readonly body: string;
      readonly fallback: boolean;
    }
  | ReviewIssue;

export type GitActionInput =
  | { readonly reviewId: string; readonly action: "stage-all" | "push" }
  | {
      readonly reviewId: string;
      readonly action: "commit" | "pr";
      readonly title: string;
      readonly body: string;
    };

export type GitActionResult =
  | { readonly state: "done" }
  | { readonly state: "pull-request"; readonly url: string; readonly opened: "created" | "compare" }
  | ReviewIssue;

export type SendReviewCommentsResult = { readonly state: "sent" } | ReviewIssue;
