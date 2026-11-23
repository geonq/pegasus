// node --test --experimental-strip-types src/features/review/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildComment,
  formatCommentsPrompt,
  longestRow,
  nextGitStep,
  parsePatch,
  sortFiles,
  splitPath,
  stageActionsFor,
  totals,
  turnOptions,
  type DiffRow,
} from "./review-logic.ts";
import type { GitActionState, ReviewFileEntry } from "./types.ts";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,3 +10,4 @@ function a() {",
  " keep",
  "-old",
  "+new",
  "+added",
  " tail",
  "@@ -40,2 +41,1 @@",
  " ctx",
  "--- removed line that starts with dashes",
  "\\ No newline at end of file",
  "",
].join("\n");

test("a patch becomes rows with numbers, gaps for skipped lines and notes", () => {
  assert.deepEqual(parsePatch(PATCH), [
    { kind: "gap", count: 9 },
    { kind: "context", text: "keep", oldNumber: 10, newNumber: 10 },
    { kind: "removed", text: "old", oldNumber: 11 },
    { kind: "added", text: "new", newNumber: 11 },
    { kind: "added", text: "added", newNumber: 12 },
    { kind: "context", text: "tail", oldNumber: 12, newNumber: 13 },
    { kind: "gap", count: 27 },
    { kind: "context", text: "ctx", oldNumber: 40, newNumber: 41 },
    { kind: "removed", text: "-- removed line that starts with dashes", oldNumber: 41 },
    { kind: "note", text: "No newline at end of file" },
  ] satisfies DiffRow[]);
});

test("a new file starts at line 1 without a gap; a delete-only hunk counts its gap right", () => {
  assert.deepEqual(parsePatch("--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+one\n+two\n"), [
    { kind: "added", text: "one", newNumber: 1 },
    { kind: "added", text: "two", newNumber: 2 },
  ]);
  // Deleting old line 5 alone: new file keeps lines 1-4 untouched before it.
  assert.deepEqual(parsePatch("@@ -5 +4,0 @@\n-gone\n"), [
    { kind: "gap", count: 4 },
    { kind: "removed", text: "gone", oldNumber: 5 },
  ]);
});

test("binary patches show their note; empty patches show nothing", () => {
  assert.deepEqual(
    parsePatch("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n"),
    [{ kind: "note", text: "Binary files a/i.png and b/i.png differ" }],
  );
  assert.deepEqual(parsePatch(""), []);
});

test("longest row counts tabs as four columns and ignores gaps", () => {
  assert.equal(longestRow(parsePatch("@@ -1 +1 @@\n-\tab\n+abcdefgh\n")), 8);
  assert.equal(longestRow([{ kind: "gap", count: 500 }]), 0);
});

test("paths split into folder and name; files sort by folder then name", () => {
  assert.deepEqual(splitPath("a/b/c.ts"), { name: "c.ts", folder: "a/b/" });
  assert.deepEqual(splitPath("README.md"), { name: "README.md", folder: "" });
  assert.deepEqual(
    sortFiles([{ path: "src/z.ts" }, { path: "b.ts" }, { path: "src/a.ts" }]).map((f) => f.path),
    ["b.ts", "src/a.ts", "src/z.ts"],
  );
});

test("totals skip binary files and count reviewed ones", () => {
  assert.deepEqual(
    totals([
      { lines: { added: 3, removed: 1 }, reviewed: true },
      { lines: null, reviewed: false },
      { lines: { added: 2, removed: 0 } },
    ]),
    { files: 3, added: 5, removed: 1, reviewed: 1 },
  );
});

test("turns are listed newest first, the newest called Last turn", () => {
  const turn = (id: string, added: number) => ({
    checkpointId: id,
    checkoutId: "w",
    entryIds: [],
    files: [{ path: "a", lines: { added, removed: 0 } }],
  });
  assert.deepEqual(
    turnOptions([turn("c1", 1), turn("c2", 2), turn("c3", 3)]).map((t) => [
      t.checkpointId,
      t.label,
      t.totals.added,
    ]),
    [
      ["c3", "Last turn", 3],
      ["c2", "Turn 2", 2],
      ["c1", "Turn 1", 1],
    ],
  );
});

const file = (staged: boolean, unstaged: boolean): ReviewFileEntry => ({
  id: "f",
  path: "a",
  status: "modified",
  hasStagedChanges: staged,
  hasUnstagedChanges: unstaged,
  conflicted: false,
  reviewed: false,
  lines: null,
});

test("stage actions follow the scope and what the file has", () => {
  assert.deepEqual(stageActionsFor({ kind: "uncommitted" }, file(true, true)), [
    "stage",
    "unstage",
  ]);
  assert.deepEqual(stageActionsFor({ kind: "uncommitted" }, file(false, true)), ["stage"]);
  assert.deepEqual(stageActionsFor({ kind: "staged" }, file(true, true)), ["unstage"]);
  assert.deepEqual(stageActionsFor({ kind: "branch" }, file(true, true)), []);
  assert.deepEqual(stageActionsFor({ kind: "turn" }, file(false, true)), []);
});

const git = (over: Partial<GitActionState>): GitActionState => ({
  state: "available",
  branch: "feature",
  upstream: "origin/feature",
  remote: "origin",
  ahead: 0,
  staged: 0,
  unstaged: 0,
  conflicted: 0,
  base: "main",
  aheadOfBase: 0,
  ghAvailable: true,
  pullRequest: null,
  ...over,
});

test("the git step goes stage, commit, push, PR, view PR", () => {
  assert.equal(nextGitStep(git({ conflicted: 1, staged: 2 })).kind, "none");
  assert.equal(nextGitStep(git({ branch: null })).label, "Detached HEAD");
  assert.equal(nextGitStep(git({ unstaged: 2 })).kind, "stage");
  assert.equal(nextGitStep(git({ staged: 1, unstaged: 2 })).hint, "1 file staged, 2 left out");
  assert.equal(nextGitStep(git({ ahead: 2 })).hint, "2 commits to origin/feature");
  assert.equal(
    nextGitStep(git({ upstream: null, aheadOfBase: 1 })).hint,
    "Publish feature to origin",
  );
  assert.equal(nextGitStep(git({ ahead: 1, remote: null })).label, "No remote");
  assert.equal(nextGitStep(git({ aheadOfBase: 1 })).label, "Create PR");
  assert.equal(nextGitStep(git({ aheadOfBase: 1, ghAvailable: false })).label, "Open PR page");
  assert.equal(nextGitStep(git({ pullRequest: { number: 7, url: "u" } })).label, "View PR #7");
  assert.equal(nextGitStep(git({ branch: "main", aheadOfBase: 1 })).label, "Up to date");
});

test("line comments carry their reference and quote; the prompt fences them safely", () => {
  const rows = parsePatch(PATCH);
  const added = rows[3];
  const removed = rows[2];
  assert.ok(added?.kind === "added" && removed?.kind === "removed");
  assert.equal(buildComment("src/a.ts", added, "   ", "1"), null);
  const one = buildComment("src/a.ts", added, " Rename this ", "1");
  const two = buildComment("src/a.ts", { ...removed, text: "x ``` y" }, "Why?", "2");
  assert.deepEqual(one, { id: "1", label: "src/a.ts:11", quote: "+new", text: "Rename this" });
  assert.equal(two?.label, "src/a.ts:11 (removed line)");
  const prompt = formatCommentsPrompt([one!, two!]);
  assert.match(prompt, /^Review comments on the current changes \(2 comments\)\./);
  assert.ok(prompt.includes("1. src/a.ts:11\n```diff\n+new\n```\nRename this"));
  assert.ok(prompt.includes("````diff\n-x ``` y\n````\nWhy?"));
});
