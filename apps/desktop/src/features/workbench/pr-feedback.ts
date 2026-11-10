import type { PullRequestFeedbackResult } from "../../../contracts/git-actions";

type Feedback = Extract<PullRequestFeedbackResult, { state: "feedback" }>;

/** The header button: a short state first, the full sentence for its tooltip. */
export function summarizePullRequestFeedback(feedback: Feedback): {
  readonly label: string;
  readonly short: string;
  readonly tone: "fail" | "pending" | "pass" | "neutral";
} {
  const failing = feedback.checks.filter((check) => check.state === "fail").length;
  const pending = feedback.checks.filter((check) => check.state === "pending").length;
  const passing = feedback.checks.filter((check) => check.state === "pass").length;
  const comments = feedback.comments.length;
  const commentText = comments > 0 ? ` · ${comments} comment${comments === 1 ? "" : "s"}` : "";
  if (failing > 0)
    return { label: `${failing} failing${commentText}`, short: `${failing} failing`, tone: "fail" };
  if (pending > 0)
    return { label: `Checks running${commentText}`, short: "Running", tone: "pending" };
  if (passing > 0) return { label: `Checks pass${commentText}`, short: "Passing", tone: "pass" };
  return {
    label: comments > 0 ? `${comments} comment${comments === 1 ? "" : "s"}` : "No checks",
    short: `PR #${feedback.number}`,
    tone: "neutral",
  };
}

/** One message that hands the failing checks and the reviewers' comments to the agent; null when there is nothing to act on. */
export function formatPullRequestFeedback(feedback: Feedback): string | null {
  const failing = feedback.checks.filter((check) => check.state === "fail");
  if (failing.length === 0 && feedback.comments.length === 0) return null;
  const lines = [`Feedback on pull request #${feedback.number} (${feedback.url}):`];
  if (failing.length > 0) {
    lines.push("", "Failing checks:");
    for (const check of failing)
      lines.push(`- ${check.name}${check.link ? ` (${check.link})` : ""}`);
  }
  if (feedback.comments.length > 0) {
    lines.push("", "Review comments:");
    for (const comment of feedback.comments) {
      const where = comment.path
        ? ` on ${comment.path}${comment.line === null ? "" : `:${comment.line}`}`
        : comment.kind === "changes-requested"
          ? " (requested changes)"
          : "";
      const body = comment.body.replace(/\r\n/g, "\n").split("\n").join("\n  ");
      lines.push(`- @${comment.author}${where}:\n  ${body}`);
    }
  }
  lines.push(
    "",
    failing.length > 0
      ? "Find out why the checks fail (gh run view --log-failed helps), fix them and address the comments, then commit and push."
      : "Address the comments, then commit and push.",
  );
  return lines.join("\n");
}
