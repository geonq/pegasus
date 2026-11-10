import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestFeedbackResult,
} from "../../../contracts/git-actions";
import { explainGitFailure, runTool } from "./git-actions";

const MAX_COMMENTS = 50;
const MAX_BODY = 4000;

/**
 * The open pull request of the checkout's branch, with its checks and the comments people left:
 * review summaries, conversation comments and comments on diff lines.
 */
export async function readPullRequestFeedback(cwd: string): Promise<PullRequestFeedbackResult> {
  const view = await runTool(
    "gh",
    cwd,
    ["pr", "view", "--json", "number,url,state,reviews,comments"],
    { timeoutMs: 20_000 },
  );
  if (view.code !== 0) {
    if (/no pull requests found|could not find any pull requests/i.test(view.stderr))
      return { state: "unavailable", code: "no-pull-request", message: "This branch has no pull request." };
    return { state: "failed", code: "gh-failed", message: explainGitFailure("Reading the pull request", view.stderr) };
  }
  const pr = parsePullRequestView(view.stdout);
  if (!pr)
    return { state: "unavailable", code: "no-pull-request", message: "This branch has no open pull request." };

  const [checks, inline] = await Promise.all([
    runTool("gh", cwd, ["pr", "checks", String(pr.number), "--json", "name,bucket,link"], {
      timeoutMs: 20_000,
    }),
    runTool(
      "gh",
      cwd,
      ["api", `repos/{owner}/{repo}/pulls/${pr.number}/comments?per_page=100`],
      { timeoutMs: 20_000 },
    ),
  ]);
  // gh exits non-zero while checks fail or run, and when none were reported; stdout still has the list.
  return {
    state: "feedback",
    number: pr.number,
    url: pr.url,
    checks: parseChecks(checks.stdout),
    comments: [...pr.comments, ...(inline.code === 0 ? parseInlineComments(inline.stdout) : [])]
      .slice(0, MAX_COMMENTS),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const login = (value: unknown): string => (isRecord(value) ? text(value.login) : "") || "someone";
/** Drops HTML comments (bots hide markers in them) and trims to a size a prompt can carry. */
const cleanBody = (raw: unknown): string => {
  const body = text(raw)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}…` : body;
};

export function parsePullRequestView(
  json: string,
): { readonly number: number; readonly url: string; readonly comments: PullRequestComment[] } | null {
  const value = parseJson(json);
  if (!isRecord(value) || typeof value.number !== "number" || value.state !== "OPEN") return null;
  const comments: PullRequestComment[] = [];
  for (const review of Array.isArray(value.reviews) ? value.reviews : []) {
    if (!isRecord(review)) continue;
    const body = cleanBody(review.body);
    // An approval or a bare "commented" with no text says nothing the agent can act on.
    if (!body) continue;
    comments.push({
      author: login(review.author),
      body,
      path: null,
      line: null,
      url: null,
      kind: review.state === "CHANGES_REQUESTED" ? "changes-requested" : "review",
    });
  }
  for (const comment of Array.isArray(value.comments) ? value.comments : []) {
    if (!isRecord(comment)) continue;
    const body = cleanBody(comment.body);
    if (!body) continue;
    comments.push({
      author: login(comment.author),
      body,
      path: null,
      line: null,
      url: text(comment.url) || null,
      kind: "comment",
    });
  }
  return { number: value.number, url: text(value.url), comments };
}

export function parseChecks(json: string): PullRequestCheck[] {
  const value = parseJson(json);
  if (!Array.isArray(value)) return [];
  const checks: PullRequestCheck[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !text(entry.name)) continue;
    const bucket = text(entry.bucket);
    checks.push({
      name: text(entry.name),
      state:
        bucket === "pass"
          ? "pass"
          : bucket === "fail" || bucket === "cancel"
            ? "fail"
            : bucket === "pending"
              ? "pending"
              : "skipped",
      link: text(entry.link) || null,
    });
  }
  return checks;
}

export function parseInlineComments(json: string): PullRequestComment[] {
  const value = parseJson(json);
  if (!Array.isArray(value)) return [];
  const comments: PullRequestComment[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const body = cleanBody(entry.body);
    if (!body) continue;
    const line =
      typeof entry.line === "number"
        ? entry.line
        : typeof entry.original_line === "number"
          ? entry.original_line
          : null;
    comments.push({
      author: login(entry.user),
      body,
      path: text(entry.path) || null,
      line,
      url: text(entry.html_url) || null,
      kind: "line",
    });
  }
  return comments;
}
