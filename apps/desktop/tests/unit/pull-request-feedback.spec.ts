import { expect, test } from "@playwright/test";
import {
  parseChecks,
  parseInlineComments,
  parsePullRequestView,
} from "../../electron/platform/files/pull-request-feedback";
import {
  formatPullRequestFeedback,
  summarizePullRequestFeedback,
} from "../../src/features/workbench/pr-feedback";

// Shapes as `gh pr checks --json name,bucket,link`, `gh pr view --json …` and the REST
// pull request comments endpoint print them (checked against gh 2.96 on cli/cli).
const checksJson = JSON.stringify([
  { bucket: "pass", link: "https://github.com/o/r/runs/1", name: "CodeQL" },
  { bucket: "fail", link: "https://github.com/o/r/actions/runs/2/job/3", name: "test (windows)" },
  { bucket: "cancel", link: "", name: "lint" },
  { bucket: "pending", link: "https://github.com/o/r/runs/4", name: "build" },
  { bucket: "skipping", link: "https://github.com/o/r/runs/5", name: "triage" },
]);

const viewJson = JSON.stringify({
  number: 12,
  url: "https://github.com/o/r/pull/12",
  state: "OPEN",
  reviews: [
    {
      author: { login: "alice" },
      body: "<!-- bot-marker -->\nPlease split the parser change.",
      state: "CHANGES_REQUESTED",
    },
    { author: { login: "bob" }, body: "", state: "APPROVED" },
  ],
  comments: [
    {
      author: { login: "carol" },
      body: "Does this work on Windows?",
      url: "https://github.com/o/r/pull/12#issuecomment-1",
    },
  ],
});

const inlineJson = JSON.stringify([
  {
    user: { login: "alice" },
    body: "Off by one here.\nThe last line is dropped.",
    path: "src/parse.ts",
    line: 42,
    original_line: 40,
    html_url: "https://github.com/o/r/pull/12#discussion_r1",
  },
  {
    user: { login: "dave" },
    body: "Outdated note",
    path: "src/old.ts",
    line: null,
    original_line: 7,
    html_url: "",
  },
]);

test("gh output parses into checks and comments", () => {
  expect(parseChecks(checksJson).map((check) => [check.name, check.state])).toEqual([
    ["CodeQL", "pass"],
    ["test (windows)", "fail"],
    ["lint", "fail"],
    ["build", "pending"],
    ["triage", "skipped"],
  ]);
  expect(parseChecks("no checks reported on the 'x' branch")).toEqual([]);

  const view = parsePullRequestView(viewJson);
  expect(view?.number).toBe(12);
  // The approval without text is left out.
  expect(view?.comments.map((comment) => [comment.author, comment.kind])).toEqual([
    ["alice", "changes-requested"],
    ["carol", "comment"],
  ]);
  expect(parsePullRequestView(JSON.stringify({ number: 3, url: "", state: "MERGED" }))).toBeNull();

  const inline = parseInlineComments(inlineJson);
  expect(inline.map((comment) => [comment.path, comment.line])).toEqual([
    ["src/parse.ts", 42],
    ["src/old.ts", 7],
  ]);
  expect(parseInlineComments('{"message":"Not Found"}')).toEqual([]);
});

test("the message names failing checks and every comment; a clean PR sends nothing", () => {
  const view = parsePullRequestView(viewJson);
  if (!view) throw new Error("view did not parse");
  const feedback = {
    state: "feedback" as const,
    number: view.number,
    url: view.url,
    checks: parseChecks(checksJson),
    comments: [...view.comments, ...parseInlineComments(inlineJson)],
  };
  expect(summarizePullRequestFeedback(feedback)).toEqual({
    label: "2 failing · 4 comments",
    short: "2 failing",
    tone: "fail",
  });
  const message = formatPullRequestFeedback(feedback);
  expect(message).toContain("Feedback on pull request #12 (https://github.com/o/r/pull/12):");
  expect(message).toContain("- test (windows) (https://github.com/o/r/actions/runs/2/job/3)");
  expect(message).toContain("- lint\n");
  expect(message).not.toContain("CodeQL");
  expect(message).not.toContain("bot-marker");
  expect(message).toContain("- @alice (requested changes):\n  Please split the parser change.");
  expect(message).toContain(
    "- @alice on src/parse.ts:42:\n  Off by one here.\n  The last line is dropped.",
  );
  expect(message).toContain("gh run view --log-failed");

  const clean = {
    ...feedback,
    checks: parseChecks(checksJson).filter((c) => c.state === "pass"),
    comments: [],
  };
  expect(formatPullRequestFeedback(clean)).toBeNull();
  expect(summarizePullRequestFeedback(clean)).toEqual({
    label: "Checks pass",
    short: "Passing",
    tone: "pass",
  });
  expect(summarizePullRequestFeedback({ ...clean, checks: [] }).label).toBe("No checks");
});
