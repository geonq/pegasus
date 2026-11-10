import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  commitStaged,
  compareUrl,
  countStatus,
  createPullRequest,
  explainGitFailure,
  pushBranch,
  readGitActionState,
  redactSecrets,
  stageAll,
} from "../../electron/platform/files/git-actions";
import { fallbackCommitDraft, parseDraft } from "../../electron/workbench/git-draft";
import { decodeGitActionInput } from "../../contracts/git-actions";

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await execute("git", args, { cwd })).stdout.trim();

/** A work repository with a local bare repository as origin; nothing here touches a real remote. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-git-actions-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  await git(root, "init", "--bare", "-b", "main", remote);
  await git(root, "init", "-b", "main", work);
  for (const [key, value] of [
    ["user.email", "actions@example.invalid"],
    ["user.name", "Actions fixture"],
    ["core.autocrlf", "false"],
  ] as const)
    await git(work, "config", key, value);
  await git(work, "remote", "add", "origin", remote);
  await writeFile(join(work, "a.txt"), "one\n");
  await git(work, "add", "a.txt");
  await git(work, "commit", "-m", "base");
  await git(work, "push", "-u", "origin", "main");
  await git(work, "remote", "set-head", "origin", "main");
  return { work, remote };
}

test("the flow stages, commits and pushes a new branch without gh or force", async () => {
  const { work, remote } = await fixture();
  await git(work, "checkout", "-b", "feature/x-y");
  await writeFile(join(work, "a.txt"), "one\ntwo\n");
  await writeFile(join(work, "new file.txt"), "n\n");

  let state = await readGitActionState(work);
  expect(state).toMatchObject({
    state: "available",
    branch: "feature/x-y",
    staged: 0,
    unstaged: 2,
  });

  expect(await stageAll(work)).toEqual({ state: "done" });
  state = await readGitActionState(work);
  expect(state).toMatchObject({ staged: 2, unstaged: 0 });

  // A message that looks like a flag or shell syntax is plain text.
  const title = '--amend; echo "$(whoami)" `x`';
  expect(await commitStaged(work, title, "Why\nbecause")).toEqual({ state: "done" });
  expect(await git(work, "log", "-1", "--format=%s")).toBe(title);
  expect(await git(work, "log", "-1", "--format=%b")).toBe("Why\nbecause");

  state = await readGitActionState(work);
  expect(state).toMatchObject({
    staged: 0,
    unstaged: 0,
    ahead: 1,
    upstream: null,
    remote: "origin",
  });
  expect(state).toMatchObject({ base: "main", aheadOfBase: 1 });

  expect(await pushBranch(work)).toEqual({ state: "done" });
  expect(await git(remote, "branch", "--list", "feature/x-y")).toContain("feature/x-y");
  state = await readGitActionState(work);
  expect(state).toMatchObject({ ahead: 0, upstream: "origin/feature/x-y" });
});

test("a rejected push explains the fix and never forces", async () => {
  const { work, remote } = await fixture();
  const other = await mkdtemp(join(tmpdir(), "pi-gui-git-actions-other-"));
  await git(other, "clone", remote, "clone");
  const clone = join(other, "clone");
  await git(clone, "config", "user.email", "o@example.invalid");
  await git(clone, "config", "user.name", "Other");
  await writeFile(join(clone, "b.txt"), "b\n");
  await git(clone, "add", "b.txt");
  await git(clone, "commit", "-m", "remote work");
  await git(clone, "push");

  await writeFile(join(work, "a.txt"), "changed\n");
  await stageAll(work);
  await commitStaged(work, "local work", "");
  const result = await pushBranch(work);
  expect(result).toMatchObject({ state: "failed", code: "push-failed" });
  expect(result.state === "failed" && result.message).toContain("never force-pushes");
  // The remote still has the other clone's commit.
  expect(await git(remote, "log", "-1", "--format=%s", "main")).toBe("remote work");
});

test("nothing staged, conflicts and a missing push are refused in plain words", async () => {
  const { work } = await fixture();
  expect(await commitStaged(work, "x", "")).toMatchObject({ code: "nothing-staged" });
  expect(await createPullRequest(work, "t", "")).toMatchObject({ code: "on-base" });
  await git(work, "checkout", "-b", "topic");
  expect(await createPullRequest(work, "t", "")).toMatchObject({ code: "not-pushed" });
  expect(await readGitActionState(join(work, ".."))).toMatchObject({ code: "not-a-repository" });
});

test("a failing commit hook is reported with its output", async () => {
  const { work } = await fixture();
  await writeFile(
    join(work, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\necho lint failed >&2\nexit 1\n",
    {
      mode: 0o755,
    },
  );
  await writeFile(join(work, "a.txt"), "hooked\n");
  await stageAll(work);
  const result = await commitStaged(work, "blocked", "");
  expect(result).toMatchObject({ state: "failed", code: "commit-failed" });
  expect(result.state === "failed" && result.message).toContain("lint failed");
});

test("status counting, URLs, secrets and drafts", () => {
  expect(countStatus("M  a\0 M b\0?? c\0UU d\0R  new\0old\0")).toEqual({
    staged: 2,
    unstaged: 2,
    conflicted: 1,
  });
  expect(compareUrl("git@github.com:me/repo.git", "main", "feat/a-b")).toBe(
    "https://github.com/me/repo/compare/main...feat/a-b?expand=1",
  );
  expect(compareUrl("https://tok@github.com/me/repo", null, "x")).toBe(
    "https://github.com/me/repo/compare/x?expand=1",
  );
  expect(compareUrl("https://gitlab.com/me/repo.git", "main", "x")).toBeNull();
  expect(
    redactSecrets("fatal: https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x"),
  ).not.toContain("user:ghp");
  expect(explainGitFailure("push", "remote: Permission denied (publickey).")).toContain("sign in");
  expect(parseDraft('```\nTitle: "Add thing"\n\nBody here\n```')).toEqual({
    title: "Add thing",
    body: "Body here",
  });
  expect(parseDraft("")).toBeNull();
  expect(fallbackCommitDraft(" src/a.ts | 2 +-\n 1 file changed").title).toBe("Update a.ts");
  expect(() => decodeGitActionInput({ reviewId: "r", action: "commit", title: " " })).toThrow();
  expect(() => decodeGitActionInput({ reviewId: "r", action: "push", force: true })).toThrow();
});
