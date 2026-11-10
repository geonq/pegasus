import { execFile, spawn, exec } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import type { WorktreeSetupRecord } from "../../../contracts/desktop-state";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/** A pattern like `node_modules` would copy an entire dependency tree; fail loudly instead. */
const MAX_COPIED_FILES = 2_000;
const SETUP_TIMEOUT_MS = 10 * 60_000;

/**
 * What a repo asks of a new worktree. File formats match Orca's: `.worktreeinclude`
 * (gitignore-style patterns of ignored files to copy) and `orca.yaml`
 * (`scripts.setup`, `worktree.sharedDirectories`), so one repo works in both apps.
 */
export interface WorktreeSetupConfig {
  readonly include: readonly string[];
  readonly sharedDirectories: readonly string[];
  readonly setup: string | undefined;
}

export async function readWorktreeSetupConfig(repoRoot: string): Promise<WorktreeSetupConfig> {
  const includeText = await readOptional(join(repoRoot, ".worktreeinclude"));
  const yamlText = await readOptional(join(repoRoot, "orca.yaml"));
  const yaml: unknown = yamlText === undefined ? undefined : parseYaml(yamlText);
  const root = isRecord(yaml) ? yaml : {};
  const scripts = isRecord(root.scripts) ? root.scripts : {};
  const worktree = isRecord(root.worktree) ? root.worktree : {};
  const shared = Array.isArray(worktree.sharedDirectories) ? worktree.sharedDirectories : [];
  const setup = typeof scripts.setup === "string" ? scripts.setup.trim() : "";
  return {
    include: (includeText ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
    sharedDirectories: shared.filter((value): value is string => typeof value === "string"),
    setup: setup || undefined,
  };
}

export type SetupProgress = (record: WorktreeSetupRecord) => void;

/**
 * Make a fresh worktree usable: copy listed ignored files, link shared directories,
 * then run the repo's setup command if the user has approved that exact command.
 * Throws on failure; returns "needs-approval" when the command is waiting for consent.
 */
export async function prepareWorktree(input: {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly trustFilePath: string | undefined;
  readonly signal: AbortSignal;
  readonly progress: SetupProgress;
}): Promise<"done" | "needs-approval"> {
  const { repoRoot, worktreePath, signal, progress } = input;
  const config = await readWorktreeSetupConfig(repoRoot);

  if (config.include.length > 0) {
    progress({ state: "running", step: "Copying local files…" });
    await copyIncludedFiles(repoRoot, worktreePath, config.include);
  }
  for (const directory of config.sharedDirectories) {
    progress({ state: "running", step: `Linking ${directory}…` });
    await linkSharedDirectory(repoRoot, worktreePath, directory);
  }
  if (!config.setup) {
    return "done";
  }
  if (!(await isSetupTrusted(input.trustFilePath, repoRoot, config.setup))) {
    progress({ state: "needs-approval", command: config.setup });
    return "needs-approval";
  }
  // Line by line so a Windows shell and a POSIX shell both run the same file.
  for (const line of config.setup.split(/\r?\n/).filter((entry) => entry.trim())) {
    progress({ state: "running", step: `Running ${line.trim()}…` });
    try {
      await execAsync(line, {
        cwd: worktreePath,
        timeout: SETUP_TIMEOUT_MS,
        signal,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`\`${line.trim()}\` failed: ${tail(error)}`);
    }
  }
  return "done";
}

export async function trustSetupCommand(
  trustFilePath: string,
  repoRoot: string,
  command: string,
): Promise<void> {
  const hashes = await readTrusted(trustFilePath);
  hashes.add(setupHash(repoRoot, command));
  await mkdir(dirname(trustFilePath), { recursive: true });
  await writeFile(trustFilePath, JSON.stringify({ hashes: [...hashes] }), "utf8");
}

async function isSetupTrusted(
  trustFilePath: string | undefined,
  repoRoot: string,
  command: string,
): Promise<boolean> {
  return trustFilePath ? (await readTrusted(trustFilePath)).has(setupHash(repoRoot, command)) : false;
}

function setupHash(repoRoot: string, command: string): string {
  return createHash("sha256").update(`${repoRoot}\0${command}`).digest("hex");
}

async function readTrusted(trustFilePath: string): Promise<Set<string>> {
  const text = await readOptional(trustFilePath);
  if (text === undefined) {
    return new Set();
  }
  const parsed: unknown = JSON.parse(text);
  const hashes = isRecord(parsed) && Array.isArray(parsed.hashes) ? parsed.hashes : [];
  return new Set(hashes.filter((value): value is string => typeof value === "string"));
}

async function copyIncludedFiles(
  repoRoot: string,
  worktreePath: string,
  patterns: readonly string[],
): Promise<void> {
  // Git does the pattern matching: files that match `.worktreeinclude` AND are gitignored.
  const matched = splitNul(
    await gitOutput(repoRoot, ["ls-files", "-z", "-o", "-i", "--exclude-from=.worktreeinclude"]),
  );
  const candidates = matched.length > 0 ? await filterIgnored(repoRoot, matched) : [];
  if (candidates.length > MAX_COPIED_FILES) {
    throw new Error(
      `.worktreeinclude matches ${candidates.length} files (limit ${MAX_COPIED_FILES}). Narrow the patterns.`,
    );
  }
  const worktreeReal = await realpath(worktreePath);
  for (const relative of candidates) {
    if (isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      continue;
    }
    const source = join(repoRoot, relative);
    const stats = await lstat(source).catch(() => undefined);
    if (!stats?.isFile()) {
      continue; // symlinks and vanished files are never followed
    }
    const target = resolve(worktreeReal, relative);
    if (!target.startsWith(worktreeReal + sep)) {
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    // A tracked symlinked directory in the checkout must not redirect the copy outside it.
    if (!(await realpath(dirname(target))).startsWith(worktreeReal)) {
      continue;
    }
    await copyFile(source, target, constants.COPYFILE_EXCL).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    });
  }
}

async function linkSharedDirectory(
  repoRoot: string,
  worktreePath: string,
  directory: string,
): Promise<void> {
  const clean = directory.replace(/[\\/]+$/, "");
  if (!clean || isAbsolute(clean) || clean.split(/[\\/]/).includes("..") || clean === ".git") {
    throw new Error(`sharedDirectories entry "${directory}" must be a relative path inside the repo.`);
  }
  const source = join(repoRoot, clean);
  const target = join(worktreePath, clean);
  if (!(await lstat(source).catch(() => undefined))?.isDirectory()) {
    return; // nothing installed in the main checkout yet
  }
  if (await lstat(target).catch(() => undefined)) {
    return;
  }
  if ((await filterIgnored(repoRoot, [clean + "/"])).length === 0) {
    return; // tracked directories already come with the checkout (as in Orca)
  }
  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target, "junction");
}

async function filterIgnored(repoRoot: string, paths: readonly string[]): Promise<string[]> {
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn("git", ["-C", repoRoot, "check-ignore", "-z", "--stdin"], {
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.on("error", reject);
    // Exit 1 means none of the paths is ignored.
    child.on("close", (code) =>
      code === 0 || code === 1 ? resolveOutput(stdout) : reject(new Error(`git check-ignore exited ${code}`)),
    );
    child.stdin.end(paths.join("\0") + "\0");
  });
  return splitNul(output);
}

async function gitOutput(repoRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

function splitNul(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tail(error: unknown): string {
  const text =
    error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim()
      ? error.stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return text.trim().slice(-400);
}
