import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DesktopAppState } from "../../contracts/desktop-state";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type {
  ChangeReviewFileStageInput,
  ChangeReviewFileStageResult,
  GetReviewInput,
  ReviewCoverage,
  ReviewFileInput,
  ReviewFileResult,
  ReviewIssue,
  ReviewResult,
  SetReviewFileReviewedInput,
  SetReviewFileReviewedResult,
  TurnChangedFile,
  TurnChangeSummary,
  TurnChangesInput,
  TurnChangesResult,
} from "../../contracts/review";
import { isWorkingReviewScope } from "../../contracts/review";
import {
  changeGitReviewFileStage,
  checkGitReviewFileCurrent,
  createGitReview,
  readGitReviewFile,
  summarizeGitTreeChanges,
  type GitReviewFile,
  type GitReviewScope,
  type GitReviewSnapshot,
} from "../platform/files/git-review";
import { ReviewedStore } from "./reviewed-store";

export interface ReviewCheckpoint {
  readonly state: "available";
  readonly checkpointId: string;
  readonly checkoutId: string;
  /** App-owned bare repository containing the captured trees. */
  readonly repositoryPath: string;
  readonly beforeTreeOid: string;
  readonly afterTreeOid: string;
  readonly capturedAt: string;
  readonly coverage: ReviewCoverage;
}

export interface ReviewCheckpointSource {
  resolve(input: {
    readonly target: SessionRef;
    readonly checkoutId: string;
    readonly checkpointId?: string;
  }): Promise<ReviewCheckpoint | ReviewIssue>;
  listTurns?(target: SessionRef): Promise<readonly ListedTurn[]>;
}

export interface ListedTurn extends ReviewCheckpoint {
  readonly entryIds: readonly string[];
}

export interface ReviewOwnerOptions {
  readonly userDataDir: string;
  readonly resolveCheckoutPath: (checkoutId: string) => string | undefined;
  readonly validateTask: (target: SessionRef) => boolean;
  readonly checkpoints?: ReviewCheckpointSource;
  /** Repository roots holding files the task changed, newest first. */
  readonly touchedRepositories?: (
    target: SessionRef,
    checkoutPath: string,
  ) => Promise<readonly string[]>;
}

interface OwnedReview {
  readonly id: string;
  readonly target: SessionRef;
  readonly checkoutId: string;
  /** Where Git runs: the checkout, or the touched repository shown in its place. */
  readonly checkoutPath: string | null;
  /** The checkout itself, to notice when it moves. */
  readonly sourcePath: string | null;
  readonly snapshot: GitReviewSnapshot;
}

const MAX_RETAINED_REVIEWS = 16;
/** Captured trees never change, so a turn's summary is computed once. */
const MAX_CACHED_TURN_SUMMARIES = 500;

/** Main owns comparison identities and reviewed state; the Git adapter owns Git semantics. */
export class ReviewOwner {
  private readonly reviews = new Map<string, OwnedReview>();
  private readonly reviewed: ReviewedStore;
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly turnFiles = new Map<string, Promise<readonly TurnChangedFile[]>>();

  constructor(private readonly options: ReviewOwnerOptions) {
    this.reviewed = new ReviewedStore(options.userDataDir);
  }

  async getTurnChanges(input: TurnChangesInput): Promise<TurnChangesResult> {
    try {
      if (!this.options.validateTask(input.target)) {
        return unavailable("task-unavailable", "This task is unavailable.");
      }
      const turns = (await this.options.checkpoints?.listTurns?.(input.target)) ?? [];
      const summaries = await Promise.all(
        turns.map(async (turn): Promise<TurnChangeSummary | null> => {
          try {
            return {
              checkpointId: turn.checkpointId,
              checkoutId: turn.checkoutId,
              entryIds: turn.entryIds,
              files: await this.turnChangedFiles(turn),
            };
          } catch {
            // One unreadable capture drops only its own card; its Review still reports why.
            return null;
          }
        }),
      );
      return {
        state: "available",
        turns: summaries.filter((turn): turn is TurnChangeSummary => Boolean(turn?.files.length)),
      };
    } catch (error: unknown) {
      return failed(error);
    }
  }

  private turnChangedFiles(turn: ListedTurn): Promise<readonly TurnChangedFile[]> {
    let files = this.turnFiles.get(turn.checkpointId);
    if (!files) {
      files = summarizeGitTreeChanges(turn.repositoryPath, turn.beforeTreeOid, turn.afterTreeOid);
      // A failed read is retried on the next request instead of being remembered.
      files.catch(() => this.turnFiles.delete(turn.checkpointId));
      this.turnFiles.set(turn.checkpointId, files);
      while (this.turnFiles.size > MAX_CACHED_TURN_SUMMARIES) {
        const oldest = this.turnFiles.keys().next().value;
        if (oldest === undefined) break;
        this.turnFiles.delete(oldest);
      }
    }
    return files;
  }

  async getReview(input: GetReviewInput): Promise<ReviewResult> {
    try {
      if (!this.options.validateTask(input.target)) {
        return unavailable("task-unavailable", "This task is unavailable.");
      }
      let checkoutPath: string | null = null;
      let gitPath: string;
      let scope: GitReviewScope;
      let capturedAt: string | undefined;
      let repositories: readonly string[] = [];
      if (input.scope.kind === "turn") {
        if (!this.options.checkpoints) {
          return unavailable(
            "checkpoint-unavailable",
            "No captured turn is available for this task.",
          );
        }
        const checkpoint = await this.options.checkpoints.resolve({
          target: input.target,
          checkoutId: input.checkoutId,
          ...(input.scope.checkpointId ? { checkpointId: input.scope.checkpointId } : {}),
        });
        if (checkpoint.state !== "available") return checkpoint;
        if (checkpoint.checkoutId !== input.checkoutId) {
          return unavailable(
            "checkpoint-checkout-mismatch",
            "The captured turn belongs to another checkout.",
          );
        }
        gitPath = checkpoint.repositoryPath;
        capturedAt = checkpoint.capturedAt;
        scope = {
          kind: "turn",
          checkpointId: checkpoint.checkpointId,
          beforeTreeOid: checkpoint.beforeTreeOid,
          afterTreeOid: checkpoint.afterTreeOid,
          coverage: checkpoint.coverage,
        };
      } else {
        const currentPath = await this.checkoutPath(input.target, input.checkoutId);
        if (typeof currentPath !== "string") return currentPath;
        checkoutPath = currentPath;
        gitPath = currentPath;
        scope = input.scope;
      }
      // The task and its child threads often change other repositories and worktrees than the
      // checkout: those are offered beside it, and reviewed in its place when it is no repository.
      const touched =
        checkoutPath && this.options.touchedRepositories
          ? (await this.options.touchedRepositories(input.target, checkoutPath)).filter(
              (path) => path !== checkoutPath,
            )
          : [];
      const picked =
        input.repository && touched.includes(input.repository) ? input.repository : null;
      let snapshot = await createGitReview(picked ?? gitPath, scope);
      if (picked) gitPath = picked;
      const checkoutIsRepository =
        checkoutPath !== null &&
        (picked ? await exists(join(checkoutPath, ".git")) : snapshot.state === "available");
      if (
        !picked &&
        snapshot.state !== "available" &&
        snapshot.code === "not-a-repository" &&
        touched[0]
      ) {
        gitPath = touched[0];
        snapshot = await createGitReview(gitPath, scope);
      }
      if (touched.length)
        repositories = checkoutIsRepository ? [checkoutPath!, ...touched] : touched;
      if (snapshot.state !== "available") return snapshot;
      const marks = await this.reviewed.snapshot();
      const owned: OwnedReview = {
        id: randomUUID(),
        target: { ...input.target },
        checkoutId: input.checkoutId,
        checkoutPath: checkoutPath === null ? null : gitPath,
        sourcePath: checkoutPath,
        snapshot,
      };
      this.remember(owned);
      return {
        state: "available",
        reviewId: owned.id,
        scope: snapshot.scope,
        checkoutId: input.checkoutId,
        baseLabel: snapshot.baseLabel,
        headOid: snapshot.headOid,
        baseOid: snapshot.baseOid,
        ...(capturedAt ? { capturedAt } : {}),
        ...(snapshot.branchName ? { branchName: snapshot.branchName } : {}),
        ...(snapshot.baseOptions ? { baseOptions: snapshot.baseOptions } : {}),
        coverage: snapshot.coverage,
        // `repository` is set only when Git ran somewhere other than the checkout itself.
        ...(repositories.length ? { repositories } : {}),
        ...(repositories.length && gitPath !== checkoutPath ? { repository: gitPath } : {}),
        files: snapshot.files.map((file) => ({
          id: file.id,
          path: file.path,
          // An unstaged change is shown at its current path, so it reports no rename.
          ...(file.previousPath === undefined || snapshot.scope.kind === "unstaged"
            ? {}
            : { previousPath: file.previousPath }),
          status: file.status,
          hasStagedChanges: file.hasStagedChanges,
          hasUnstagedChanges: file.hasUnstagedChanges,
          conflicted: file.conflicted,
          lines: file.lines,
          reviewed: marks.has(markKey(owned, file)),
        })),
      };
    } catch (error: unknown) {
      return failed(error);
    }
  }

  async getReviewFile(input: ReviewFileInput): Promise<ReviewFileResult> {
    try {
      const resolved = await this.resolveFile(input);
      if (isIssue(resolved)) return resolved;
      const result = await readGitReviewFile(resolved.review.snapshot, input.fileId);
      return result.state === "available"
        ? { ...result, reviewId: input.reviewId, fileId: input.fileId }
        : result;
    } catch (error: unknown) {
      return failed(error);
    }
  }

  async setReviewFileReviewed(
    input: SetReviewFileReviewedInput,
  ): Promise<SetReviewFileReviewedResult> {
    try {
      const resolved = await this.resolveFile(input);
      if (isIssue(resolved)) return resolved;
      const issue = await checkGitReviewFileCurrent(resolved.review.snapshot, input.fileId);
      if (issue) return issue;
      await this.reviewed.set(markKey(resolved.review, resolved.file), input.reviewed);
      return {
        state: "available",
        reviewId: input.reviewId,
        fileId: input.fileId,
        reviewed: input.reviewed,
      };
    } catch (error: unknown) {
      return failed(error);
    }
  }

  async changeReviewFileStage(
    input: ChangeReviewFileStageInput,
  ): Promise<ChangeReviewFileStageResult> {
    try {
      const resolved = await this.resolveFile(input);
      if (isIssue(resolved)) return resolved;
      if (
        !isWorkingReviewScope(resolved.review.snapshot.scope) ||
        resolved.review.checkoutPath === null
      ) {
        return unavailable(
          "read-only-comparison",
          "Staging is available only for Uncommitted, Staged and Unstaged changes.",
        );
      }
      return await this.withMutation(resolved.review.checkoutPath, async () => {
        const current = await this.resolveFile(input);
        if (isIssue(current)) return current;
        return changeGitReviewFileStage(current.review.snapshot, input.fileId, input.action);
      });
    } catch (error: unknown) {
      return failed(error);
    }
  }

  private async resolveFile(
    input: ReviewFileInput,
  ): Promise<{ readonly review: OwnedReview; readonly file: GitReviewFile } | ReviewIssue> {
    const review = this.reviews.get(input.reviewId);
    if (!review)
      return unavailable(
        "review-expired",
        "This comparison expired. Refresh to review current changes.",
      );
    if (!this.options.validateTask(review.target)) {
      return unavailable("task-unavailable", "This task is unavailable.");
    }
    if (review.snapshot.scope.kind !== "turn") {
      const currentPath = await this.checkoutPath(review.target, review.checkoutId);
      if (typeof currentPath !== "string") return currentPath;
      if (currentPath !== review.sourcePath) {
        return {
          state: "stale",
          code: "checkout-changed",
          message: "The checkout moved. Refresh this comparison.",
        };
      }
    }
    const file = review.snapshot.files.find((entry) => entry.id === input.fileId);
    return file
      ? { review, file }
      : unavailable("review-file-unavailable", "This file is not part of the selected comparison.");
  }

  private async checkoutPath(
    target: SessionRef,
    checkoutId: string,
  ): Promise<string | ReviewIssue> {
    if (!this.options.validateTask(target))
      return unavailable("task-unavailable", "This task is unavailable.");
    const path = this.options.resolveCheckoutPath(checkoutId);
    if (!path) return unavailable("checkout-unavailable", "This checkout is unavailable.");
    try {
      return await realpath(path);
    } catch {
      return unavailable(
        "checkout-unavailable",
        "This checkout no longer exists or cannot be read.",
      );
    }
  }

  private remember(review: OwnedReview): void {
    this.reviews.set(review.id, review);
    while (this.reviews.size > MAX_RETAINED_REVIEWS) {
      const oldest = this.reviews.keys().next().value;
      if (oldest === undefined) break;
      this.reviews.delete(oldest);
    }
  }

  private async withMutation<T>(checkoutPath: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(checkoutPath) ?? Promise.resolve();
    const next = previous.then(action);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.mutations.set(checkoutPath, settled);
    try {
      return await next;
    } finally {
      if (this.mutations.get(checkoutPath) === settled) this.mutations.delete(checkoutPath);
    }
  }
}

/**
 * Files a task and every child thread under it changed, the task's own first. Children are found
 * through the orchestration records, so a lead's Review covers the worktrees its workers edit.
 */
export function taskTreeTouchedFiles(
  state: Pick<DesktopAppState, "workspaces" | "orchestrationChildren">,
  target: SessionRef,
): string[] {
  const sessions = new Map<string, DesktopAppState["workspaces"][number]["sessions"][number]>(
    state.workspaces.flatMap((workspace) =>
      workspace.sessions.map((session) => [`${workspace.id}\0${session.id}`, session] as const),
    ),
  );
  const files: string[] = [];
  const seen = new Set<string>();
  const queue: SessionRef[] = [target];
  for (let ref = queue.shift(); ref; ref = queue.shift()) {
    const key = `${ref.workspaceId}\0${ref.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(...(sessions.get(key)?.touchedFiles ?? []));
    for (const child of state.orchestrationChildren) {
      if (
        child.childSessionId &&
        child.parentWorkspaceId === ref.workspaceId &&
        child.parentSessionId === ref.sessionId
      ) {
        queue.push({ workspaceId: child.childWorkspaceId, sessionId: child.childSessionId });
      }
    }
  }
  return files;
}

/**
 * The Git roots (a folder holding `.git`) above the given files, in the files' order, without
 * duplicates. Relative paths start at basePath. Files outside any repository are skipped.
 */
export async function findTouchedRepositories(
  files: readonly string[],
  basePath: string,
): Promise<string[]> {
  const roots: string[] = [];
  const checked = new Map<string, string | null>();
  for (const file of files) {
    let dir = dirname(resolve(basePath, file));
    const visited: string[] = [];
    let root: string | null | undefined;
    while (root === undefined) {
      if (checked.has(dir)) root = checked.get(dir);
      else if (await exists(join(dir, ".git"))) root = await realpath(dir).catch(() => null);
      else if (dirname(dir) === dir) root = null;
      else {
        visited.push(dir);
        dir = dirname(dir);
        continue;
      }
      visited.push(dir);
    }
    for (const seen of visited) checked.set(seen, root ?? null);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function markKey(review: OwnedReview, file: GitReviewFile): string {
  const scope = review.snapshot.scope;
  return createHash("sha256")
    .update(
      JSON.stringify([
        review.target.workspaceId,
        review.target.sessionId,
        review.checkoutId,
        review.checkoutPath,
        scope.kind,
        scope.kind === "branch" ? scope.baseRef : scope.kind === "turn" ? scope.checkpointId : null,
        file.path,
        file.previousPath,
        file.contentFingerprint,
      ]),
    )
    .digest("hex");
}

function isIssue(value: { readonly review: OwnedReview } | ReviewIssue): value is ReviewIssue {
  return "state" in value;
}

function unavailable(code: string, message: string): ReviewIssue {
  return { state: "unavailable", code, message };
}

function failed(error: unknown): ReviewIssue {
  return {
    state: "failed",
    code: "review-failed",
    message: error instanceof Error ? error.message : String(error),
  };
}
