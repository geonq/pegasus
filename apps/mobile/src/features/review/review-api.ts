import { useMemo } from "react";
import { PegasusClient } from "../../api/client";
import { usePegasus } from "../../state/PegasusProvider";
import type {
  ChangeReviewFileStageResult,
  DraftGitTextResult,
  GetReviewInput,
  GitActionInput,
  GitActionResult,
  GitActionStateResult,
  ReviewFileResult,
  ReviewResult,
  SendReviewCommentsResult,
  SessionRef,
  SetReviewFileReviewedResult,
  TurnChangesResult,
} from "./types";

/** Typed calls to the PC's review and git methods (POST /v1/invoke, one input object each). */
export function reviewApi(client: PegasusClient) {
  return {
    turnChanges: (target: SessionRef) =>
      client.invoke<TurnChangesResult>("getTurnChanges", { target }),
    review: (input: GetReviewInput) => client.invoke<ReviewResult>("getReview", input),
    file: (reviewId: string, fileId: string) =>
      client.invoke<ReviewFileResult>("getReviewFile", { reviewId, fileId }),
    setReviewed: (reviewId: string, fileId: string, reviewed: boolean) =>
      client.invoke<SetReviewFileReviewedResult>("setReviewFileReviewed", {
        reviewId,
        fileId,
        reviewed,
      }),
    stage: (reviewId: string, fileId: string, action: "stage" | "unstage") =>
      client.invoke<ChangeReviewFileStageResult>("changeReviewFileStage", {
        reviewId,
        fileId,
        action,
      }),
    gitState: (reviewId: string) =>
      client.invoke<GitActionStateResult>("getGitActions", { reviewId }),
    draft: (reviewId: string, kind: "commit" | "pr") =>
      client.invoke<DraftGitTextResult>("draftGitText", { reviewId, kind }),
    runGit: (input: GitActionInput) => client.invoke<GitActionResult>("runGitAction", input),
    sendComments: (target: SessionRef, text: string) =>
      client.invoke<SendReviewCommentsResult>("sendReviewComments", { target, text }),
  };
}

export type ReviewApi = ReturnType<typeof reviewApi>;

/** The provider keeps its client private; invoke is stateless, so a client of our own is equal. */
export function useReviewApi(): ReviewApi | null {
  const { pairing } = usePegasus();
  return useMemo(() => (pairing ? reviewApi(new PegasusClient(pairing)) : null), [pairing]);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
