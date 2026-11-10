import type {
  GitReviewFile,
  GitReviewFileContent,
  GitReviewScope,
  GitReviewSnapshot,
  HostClient,
  ReviewIssue as HostReviewIssue,
  TurnChangedFile as HostTurnChangedFile,
} from "@pi-gui/host-protocol";
import { sharedHost } from "@pi-gui/host-protocol/shared";
import type {
  ChangeReviewFileStageResult,
  ReviewIssue,
  TurnChangedFile,
} from "../../../contracts/review";

/**
 * Git review runs in the Rust host (crates/pegasus-host/src/review.rs): the same Git commands and
 * semantics this module used to run here, but parsing and hashing happen off Electron's main thread,
 * independent Git calls run in parallel, and the host keeps each snapshot so file reads, checks and
 * staging send only its id. A missing host is reported as an unavailable review, never hidden.
 */

export type { GitReviewFile, GitReviewFileContent, GitReviewScope, GitReviewSnapshot };

export interface GitReviewLimits {
  /** Output cap for one Git listing; larger output makes the review unavailable. */
  readonly maxGitBytes: number;
}

const HOST_MISSING =
  "The Pegasus host is not running, so Git review is unavailable. See the host log.";

async function host(): Promise<HostClient> {
  const client = await sharedHost(true);
  if (!client) throw new Error(HOST_MISSING);
  return client;
}

function unavailable(code: string, error: unknown): ReviewIssue {
  return {
    state: "unavailable",
    code,
    message: error instanceof Error ? error.message : HOST_MISSING,
  };
}

/** A readable ref name: `refs/remotes/origin/main` becomes `origin/main`. */
export function shortRefName(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes|tags)\//, "");
}

export async function createGitReview(
  checkoutPath: string,
  scope: GitReviewScope,
  limits: Partial<GitReviewLimits> = {},
): Promise<GitReviewSnapshot | HostReviewIssue> {
  try {
    return await (
      await host()
    ).call("review.create", {
      checkoutPath,
      scope,
      ...(limits.maxGitBytes === undefined ? {} : { maxGitBytes: limits.maxGitBytes }),
    });
  } catch (error) {
    return unavailable("git-review-unavailable", error);
  }
}

/** Per-file line counts between two captured trees, in Git's path order. */
export async function summarizeGitTreeChanges(
  repositoryPath: string,
  beforeTreeOid: string,
  afterTreeOid: string,
): Promise<TurnChangedFile[]> {
  const { files } = await (
    await host()
  ).call("review.treeChanges", { repositoryPath, beforeTreeOid, afterTreeOid });
  return files.map((file: HostTurnChangedFile) => ({
    path: file.path,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    lines: file.lines,
  }));
}

export async function checkGitReviewFileCurrent(
  snapshot: GitReviewSnapshot,
  fileId: string,
): Promise<HostReviewIssue | null> {
  try {
    return (await (await host()).call("review.check", { snapshotId: snapshot.id, fileId })).issue;
  } catch (error) {
    return unavailable("freshness-unavailable", error);
  }
}

export async function readGitReviewFile(
  snapshot: GitReviewSnapshot,
  fileId: string,
): Promise<GitReviewFileContent | HostReviewIssue> {
  try {
    return await (await host()).call("review.read", { snapshotId: snapshot.id, fileId });
  } catch (error) {
    return { ...unavailable("file-review-failed", error), state: "failed" };
  }
}

export async function changeGitReviewFileStage(
  snapshot: GitReviewSnapshot,
  fileId: string,
  action: "stage" | "unstage",
): Promise<ChangeReviewFileStageResult> {
  try {
    return await (await host()).call("review.stage", { snapshotId: snapshot.id, fileId, action });
  } catch (error) {
    return { ...unavailable("stage-failed", error), state: "failed" };
  }
}
