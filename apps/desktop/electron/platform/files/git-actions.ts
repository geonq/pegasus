import { execFile } from "node:child_process";
import type { GitActionResult, GitActionState } from "../../../contracts/git-actions";
import type { ReviewIssue } from "../../../contracts/review";
import { isolatedGitEnvironment } from "./git-environment";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const LOCAL_MS = 30_000;
const NETWORK_MS = 120_000;

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program without a shell, so branch names and messages are never parsed as commands. */
export function runTool(
  command: "git" | "gh",
  cwd: string,
  args: readonly string[],
  options: { readonly input?: string; readonly timeoutMs?: number } = {},
): Promise<Run> {
  return new Promise((done) => {
    const child = execFile(
      command,
      command === "git" ? ["-c", "core.fsmonitor=false", ...args] : [...args],
      {
        cwd,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? LOCAL_MS,
        env: isolatedGitEnvironment({ GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }),
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        done({
          code,
          stdout,
          stderr: error && typeof error.code === "string" ? `${error.code}: ${stderr}` : stderr,
        });
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
}

/** Never lets a credential embedded in a remote URL or a token reach the screen. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(\/\/)[^/\s@]+@/g, "$1***@")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***");
}

/** Turns Git or gh output into text that says what to do next. */
export function explainGitFailure(action: string, stderr: string): string {
  const text = redactSecrets(stderr);
  if (/non-fast-forward|fetch first|tip of your current branch is behind|\[rejected\]/i.test(text))
    return "The remote branch has commits you do not have. Pull or rebase in a terminal, then push again. Pegasus never force-pushes.";
  if (
    /could not read Username|Authentication failed|Permission denied \(publickey\)|terminal prompts disabled|HTTP 40[13]/i.test(
      text,
    )
  )
    return "Git could not sign in to the remote. Sign in with your Git credential helper or SSH key in a terminal, then try again.";
  if (/Could not resolve host|unable to access|Connection (timed out|refused)/i.test(text))
    return "The remote could not be reached. Check your connection, then try again.";
  if (/Please tell me who you are|unable to auto-detect email|empty ident/i.test(text))
    return 'Git does not know your name and email. Run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then commit again.';
  if (/hook/i.test(text) && /(declined|failed|rejected|exit code)/i.test(text))
    return `A Git hook rejected this ${action}. Fix what it reports, then try again.\n${lastLines(text, 6)}`;
  if (/not signed in|gh auth login|authentication required/i.test(text))
    return "GitHub CLI is not signed in. Run `gh auth login` in a terminal, then try again.";
  if (/already exists/i.test(text) && /pull request/i.test(text))
    return "A pull request for this branch already exists. Refresh the review to open it.";
  if (/ETIMEDOUT|killed|SIGTERM/i.test(text))
    return `The ${action} took too long and was stopped. Try again.`;
  const detail = lastLines(text, 4);
  return detail ? `The ${action} failed.\n${detail}` : `The ${action} failed.`;
}

function lastLines(text: string, count: number): string {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-count).join("\n");
}

function issue(code: string, message: string): ReviewIssue {
  return { state: "failed", code, message };
}

export async function readGitActionState(cwd: string): Promise<GitActionState | ReviewIssue> {
  // Two rounds of independent git/gh calls instead of one long serial chain: each round waits only
  // for its slowest call. Every call is still spawned once, so the parsed results are unchanged.
  const [status, branchRun, remotesRun, upstreamRun, headRun, ghRun] = await Promise.all([
    runTool("git", cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runTool("git", cwd, ["symbolic-ref", "--short", "-q", "HEAD"]),
    runTool("git", cwd, ["remote"]),
    runTool("git", cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    runTool("git", cwd, ["rev-parse", "--verify", "-q", "HEAD"]),
    runTool("gh", cwd, ["--version"]),
  ]);
  if (status.code !== 0)
    return {
      state: "unavailable",
      code: "not-a-repository",
      message: "This folder is not a Git repository.",
    };
  const counts = countStatus(status.stdout);
  const branch = branchRun.stdout.trim() || null;
  const remotes = remotesRun.stdout.split(/\r?\n/).filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
  const upstream = upstreamRun.code === 0 ? upstreamRun.stdout.trim() || null : null;
  const hasHead = headRun.code === 0;
  const ghAvailable = ghRun.code === 0;
  const [ahead, base] = await Promise.all([
    hasHead
      ? countCommits(cwd, upstream ? [`${upstream}..HEAD`] : ["HEAD", "--not", "--remotes"])
      : Promise.resolve(0),
    hasHead && remote ? defaultBase(cwd, remote) : Promise.resolve(null),
  ]);
  const [aheadOfBase, view] = await Promise.all([
    base ? countCommits(cwd, [`${base.ref}..HEAD`]) : Promise.resolve(0),
    ghAvailable && upstream && branch && ahead === 0 && branch !== base?.name
      ? runTool("gh", cwd, ["pr", "view", "--json", "number,url,state"], { timeoutMs: 15_000 })
      : Promise.resolve(undefined),
  ]);
  let pullRequest: GitActionState["pullRequest"] = null;
  if (view?.code === 0) pullRequest = parsePullRequest(view.stdout);
  return {
    state: "available",
    branch,
    upstream,
    remote,
    ahead,
    staged: counts.staged,
    unstaged: counts.unstaged,
    conflicted: counts.conflicted,
    base: base?.name ?? null,
    aheadOfBase,
    ghAvailable,
    pullRequest,
  };
}

function parsePullRequest(json: string): GitActionState["pullRequest"] {
  try {
    const value: unknown = JSON.parse(json);
    if (
      value !== null &&
      typeof value === "object" &&
      "number" in value &&
      "url" in value &&
      "state" in value &&
      typeof value.number === "number" &&
      typeof value.url === "string" &&
      value.state === "OPEN"
    )
      return { number: value.number, url: value.url };
  } catch {
    // gh printed something else; treat it as no pull request.
  }
  return null;
}

async function countCommits(cwd: string, range: readonly string[]): Promise<number> {
  const result = await runTool("git", cwd, ["rev-list", "--count", ...range]);
  const count = Number.parseInt(result.stdout.trim(), 10);
  return result.code === 0 && Number.isFinite(count) ? count : 0;
}

/** The branch pull requests target: the remote's HEAD, else main or master if it exists. */
async function defaultBase(
  cwd: string,
  remote: string,
): Promise<{ readonly name: string; readonly ref: string } | null> {
  const head = await runTool("git", cwd, [
    "symbolic-ref",
    "--short",
    "-q",
    `refs/remotes/${remote}/HEAD`,
  ]);
  const candidates = [
    ...(head.code === 0 && head.stdout.trim() ? [head.stdout.trim()] : []),
    `${remote}/main`,
    `${remote}/master`,
  ];
  for (const ref of candidates) {
    if (
      (await runTool("git", cwd, ["rev-parse", "--verify", "-q", `refs/remotes/${ref}`])).code === 0
    )
      return { name: ref.slice(remote.length + 1), ref };
  }
  return null;
}

/** Counts `git status --porcelain=v1 -z` records by what a commit would do with them. */
export function countStatus(output: string) {
  const parts = output.split("\0");
  let staged = 0;
  let unstaged = 0;
  let conflicted = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index] ?? "";
    if (record.length < 3) continue;
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    // A rename or copy is followed by its source path as a separate record.
    if (x === "R" || x === "C") index += 1;
    if (x === "!") continue;
    if (x === "?") unstaged += 1;
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D"))
      conflicted += 1;
    else {
      if (x !== " ") staged += 1;
      if (y !== " ") unstaged += 1;
    }
  }
  return { staged, unstaged, conflicted };
}

export async function stageAll(cwd: string): Promise<GitActionResult> {
  const state = await readGitActionState(cwd);
  if (state.state !== "available") return state;
  if (state.conflicted > 0)
    return issue(
      "conflicts",
      "Resolve the merge conflicts first. Staging them would mark them resolved.",
    );
  const result = await runTool("git", cwd, ["add", "-A"]);
  return result.code === 0
    ? { state: "done" }
    : issue("stage-failed", explainGitFailure("staging", result.stderr));
}

export async function commitStaged(
  cwd: string,
  title: string,
  body: string,
): Promise<GitActionResult> {
  const state = await readGitActionState(cwd);
  if (state.state !== "available") return state;
  if (state.conflicted > 0)
    return issue("conflicts", "Resolve the merge conflicts before committing.");
  if (state.staged === 0)
    return issue("nothing-staged", "Nothing is staged. Stage the changes first, then commit.");
  const message = body.trim() ? `${title.trim()}\n\n${body.trim()}\n` : `${title.trim()}\n`;
  const result = await runTool("git", cwd, ["commit", "--cleanup=strip", "-F", "-"], {
    input: message,
  });
  return result.code === 0
    ? { state: "done" }
    : issue("commit-failed", explainGitFailure("commit", result.stderr || result.stdout));
}

/** Pushes the current branch. There is no force option anywhere in this module. */
export async function pushBranch(cwd: string): Promise<GitActionResult> {
  const state = await readGitActionState(cwd);
  if (state.state !== "available") return state;
  if (!state.branch) return issue("detached", "Check out a branch before pushing.");
  if (!state.remote)
    return issue(
      "no-remote",
      "This repository has no remote. Add one with `git remote add origin <url>`, then push.",
    );
  const args = state.upstream ? ["push"] : ["push", "--set-upstream", state.remote, "HEAD"];
  const result = await runTool("git", cwd, args, { timeoutMs: NETWORK_MS });
  return result.code === 0
    ? { state: "done" }
    : issue("push-failed", explainGitFailure("push", result.stderr));
}

/** `gh pr create` when gh is installed; otherwise the browser compare page for the caller to open. */
export async function createPullRequest(
  cwd: string,
  title: string,
  body: string,
): Promise<GitActionResult> {
  const state = await readGitActionState(cwd);
  if (state.state !== "available") return state;
  if (!state.branch || !state.upstream || state.ahead > 0)
    return issue("not-pushed", "Push the branch before creating a pull request.");
  if (state.branch === state.base)
    return issue("on-base", `You are on ${state.base}. Create a branch for your changes first.`);
  if (state.pullRequest)
    return { state: "pull-request", url: state.pullRequest.url, opened: "created" };
  if (state.ghAvailable) {
    const result = await runTool(
      "gh",
      cwd,
      [
        "pr",
        "create",
        "--title",
        title.replace(/\s+/g, " ").trim(),
        "--body-file",
        "-",
        ...(state.base ? ["--base", state.base] : []),
      ],
      { input: body, timeoutMs: NETWORK_MS },
    );
    if (result.code === 0) {
      const url = /https:\/\/\S+/.exec(result.stdout)?.[0];
      if (url) return { state: "pull-request", url, opened: "created" };
    }
    // Without gh access (or a GitHub remote it knows) the browser page still gets the user there.
    if (
      !/not signed in|gh auth login|authentication|known GitHub host|none of the git remotes/i.test(
        result.stderr,
      )
    )
      return issue("pr-failed", explainGitFailure("pull request", result.stderr));
  }
  if (!state.remote) return issue("no-remote", "This repository has no remote.");
  const remoteUrl = (await runTool("git", cwd, ["remote", "get-url", state.remote])).stdout.trim();
  const url = compareUrl(remoteUrl, state.base, state.branch);
  return url
    ? { state: "pull-request", url, opened: "compare" }
    : issue(
        "pr-unsupported-host",
        "The branch is pushed, but Pegasus can only open pull request pages for GitHub remotes. Open the PR on your Git host.",
      );
}

/** The GitHub page that starts a pull request for `branch`; null for other hosts. */
export function compareUrl(remoteUrl: string, base: string | null, branch: string): string | null {
  const match =
    /^(?:https?:\/\/(?:[^/@]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      remoteUrl.trim(),
    );
  if (!match) return null;
  const segments = (name: string) => name.split("/").map(encodeURIComponent).join("/");
  const range = base ? `${segments(base)}...${segments(branch)}` : segments(branch);
  return `https://github.com/${encodeURIComponent(match[1] ?? "")}/${encodeURIComponent(match[2] ?? "")}/compare/${range}?expand=1`;
}

/** The text a draft is written from: staged changes for a commit, the branch for a pull request. */
export async function readDraftSource(
  cwd: string,
  kind: "commit" | "pr",
): Promise<{ readonly summary: string; readonly diff: string } | ReviewIssue> {
  const state = await readGitActionState(cwd);
  if (state.state !== "available") return state;
  if (kind === "commit") {
    const [stat, diff] = await Promise.all([
      runTool("git", cwd, ["diff", "--cached", "--stat", "--no-color"]),
      runTool("git", cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", "-U2"]),
    ]);
    return { summary: stat.stdout, diff: diff.stdout };
  }
  const baseRef = state.base && state.remote ? `${state.remote}/${state.base}` : null;
  if (!baseRef) return { summary: "", diff: "" };
  const [log, stat, diff] = await Promise.all([
    runTool("git", cwd, ["log", "--format=%s", "--no-color", `${baseRef}..HEAD`]),
    runTool("git", cwd, ["diff", "--stat", "--no-color", `${baseRef}...HEAD`]),
    runTool("git", cwd, ["diff", "--no-color", "--no-ext-diff", "-U2", `${baseRef}...HEAD`]),
  ]);
  return { summary: `${log.stdout}\n${stat.stdout}`, diff: diff.stdout };
}
