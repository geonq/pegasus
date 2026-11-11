#!/usr/bin/env node
// Local release pipeline for Pegasus (GitHub Actions is deliberately off on geonq/pegasus).
// Usage: pnpm release [--version x.y.z] [--dry-run] [--allow-dirty] [--skip-mac] [--from <step>]
// Steps: preflight check bump host windows mac checksums notes publish
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hashFile } from "../apps/desktop/scripts/release-artifacts.mjs";
import { RELEASE_PACKAGE_PATHS, verifyReleaseVersions } from "./verify-release-version.mjs";

const execFileAsync = promisify(execFile);
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(repoDir, "apps", "desktop");
const REMOTE = "geonq";
const REPO = "geonq/pegasus";
const MAC_HOST = "georgdomke@100.71.145.90";
const MAC_REPO_URL = `ssh://${MAC_HOST}/Users/georgdomke/Pi/pi-gui-release-1.0.21`;
const STEPS = [
  "preflight",
  "check",
  "bump",
  "host",
  "windows",
  "mac",
  "checksums",
  "notes",
  "publish",
];
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const VERSION_LINE_RE = /^(\s*"version":\s*")[^"]+(")/m;

const { values: args } = parseArgs({
  options: {
    version: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "allow-dirty": { type: "boolean", default: false },
    "skip-mac": { type: "boolean", default: false },
    from: { type: "string", default: "preflight" },
  },
});
const dryRun = args["dry-run"];

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}
if (!STEPS.includes(args.from)) fail(`--from must be one of: ${STEPS.join(", ")}`);
if (args.version !== undefined && !VERSION_RE.test(args.version))
  fail("--version must look like x.y.z");
if (args["allow-dirty"] && !dryRun) fail("--allow-dirty is only allowed together with --dry-run");
const fromIndex = STEPS.indexOf(args.from);

// ---- process helpers (execFile style: no shell, so no injection through version or paths) ----

const pnpmCjs = path.join(repoDir, "node_modules", "pnpm", "bin", "pnpm.cjs");
const toolEnv = {
  ...process.env,
  // Nested `pnpm` calls inside package scripts resolve to the repo shim; non-ASCII-safe like package-windows.
  PATH: [
    path.join(repoDir, "tools"),
    path.join(repoDir, "node_modules", ".bin"),
    process.env.PATH ?? "",
  ].join(path.delimiter),
  COREPACK_ENABLE_STRICT: "0",
};
let logDir = "";

/** Runs a command, streams its output to a log file, and rejects with the log tail on failure. */
function run(command, commandArgs, { cwd = repoDir, log, input, env = toolEnv } = {}) {
  return new Promise((resolve, reject) => {
    const out = log ? createWriteStream(path.join(logDir, log), { flags: "a" }) : undefined;
    out?.write(`\n$ ${command} ${commandArgs.join(" ")}\n`);
    const child = spawn(command, commandArgs, { cwd, env, windowsHide: true });
    let tail = "";
    const keep = (chunk) => {
      out?.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      out?.end();
      if (code === 0) resolve(tail);
      else reject(new Error(`${command} ${commandArgs[0] ?? ""} exited ${code}\n${tail}`));
    });
    child.stdin.end(input ?? "");
  });
}
const pnpm = (pnpmArgs, options) => run(process.execPath, [pnpmCjs, ...pnpmArgs], options);

async function out(command, commandArgs, options = {}) {
  const { stdout } = await execFileAsync(command, commandArgs, {
    cwd: repoDir,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return stdout.trim();
}
const git = (...gitArgs) => out("git", gitArgs);

const formatDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

// ---- version handling ----

async function readVersion() {
  const packages = await Promise.all(
    RELEASE_PACKAGE_PATHS.map(async (file) => ({
      file,
      version: JSON.parse(await readFile(path.join(repoDir, file), "utf8")).version,
    })),
  );
  return verifyReleaseVersions(packages);
}

/** Rewrites only the version line, so concurrent edits by other agents to the same file survive. */
async function writeVersion(version) {
  for (const file of RELEASE_PACKAGE_PATHS) {
    const filePath = path.join(repoDir, file);
    const text = await readFile(filePath, "utf8");
    if (!VERSION_LINE_RE.test(text)) throw new Error(`No version field found in ${file}`);
    await writeFile(filePath, text.replace(VERSION_LINE_RE, `$1${version}$2`));
  }
}

async function resolveVersion(current) {
  if (args.version) return args.version;
  const subject = await git("log", "-1", "--format=%s");
  if (subject === `Pegasus ${current}` && !(await tagExists(`v${current}`))) return current; // bump already committed
  const [major, minor, patch] = current.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

async function tagExists(tag) {
  if ((await git("tag", "-l", tag)) !== "") return true;
  return (await git("ls-remote", "--tags", REMOTE, `refs/tags/${tag}`)) !== "";
}

// ---- pipeline ----

const ctx = {
  version: "",
  original: "",
  stage: "",
  assets: [],
  warnings: [],
  macUsed: false,
};
const timings = [];

const steps = {
  async preflight() {
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "main") throw new Error(`HEAD is on '${branch}', releases are cut from main.`);
    const dirty = await git("status", "--porcelain", "--untracked-files=no");
    if (dirty && !args["allow-dirty"]) {
      throw new Error(`Tracked files have uncommitted changes (commit or stash them):\n${dirty}`);
    }
    if (dirty) ctx.warnings.push("built from a dirty tree (--allow-dirty)");
    await git("fetch", REMOTE, "main");
    const remoteIsAncestor = await git(
      "merge-base",
      "--is-ancestor",
      `${REMOTE}/main`,
      "HEAD",
    ).then(
      () => true,
      () => false,
    );
    if (!remoteIsAncestor)
      throw new Error(`${REMOTE}/main has commits that are not in local main; reconcile first.`);
    if (await tagExists(`v${ctx.version}`)) {
      throw new Error(`Tag v${ctx.version} already exists (local or on ${REMOTE}).`);
    }
    await out("gh", ["auth", "status"]).catch(() => {
      throw new Error("gh is not logged in (gh auth login).");
    });
    console.log(
      `  version ${ctx.original} -> ${ctx.version}, HEAD ${await git("rev-parse", "--short", "HEAD")}`,
    );
  },

  async check() {
    await pnpm(["check"], { log: "check.log" });
  },

  async bump() {
    if (ctx.original === ctx.version) {
      console.log("  already at target version, nothing to bump");
      return;
    }
    await writeVersion(ctx.version);
    if (dryRun) {
      ctx.restoreVersion = true;
      console.log(
        "  dry run: package.json versions bumped for the build only, restored at exit; no commit",
      );
      return;
    }
    await git("commit", "--only", "-m", `Pegasus ${ctx.version}`, "--", ...RELEASE_PACKAGE_PATHS);
  },

  /** The Rust backend host is required: a failed build stops the release. */
  async host() {
    await run("cargo", ["build", "--release", "-p", "pegasus-host"], {
      cwd: path.join(repoDir, "crates"),
      log: "host.log",
      env: { ...toolEnv, PEGASUS_APP_VERSION: ctx.version },
    });
    await run("cargo", ["test", "--release", "-p", "pegasus-core", "-p", "pegasus-host"], {
      cwd: path.join(repoDir, "crates"),
      log: "host.log",
    });
  },

  async windows() {
    if ((await readVersion()) !== ctx.version)
      throw new Error(`package.json is not at ${ctx.version}; run the bump step.`);
    await pnpm(["--filter", "@pi-gui/desktop", "run", "package:win"], { log: "windows.log" });
    const release = path.join(desktopDir, "release");
    for (const kind of ["setup", "portable"]) {
      const name = `Pegasus-${ctx.version}-x64-${kind}.exe`;
      const size = (await stat(path.join(release, name)).catch(() => undefined))?.size ?? 0;
      if (size === 0) throw new Error(`Build did not produce ${name}`);
      await copyFile(path.join(release, name), path.join(ctx.stage, name));
      ctx.assets.push(name);
    }
  },

  async mac() {
    if (args["skip-mac"]) {
      ctx.warnings.push(
        "no macOS build (--skip-mac): Mac installs get no update from this release",
      );
      console.log("  skipped (--skip-mac)");
      return;
    }
    const sha = await git("rev-parse", "HEAD");
    const reachable = await run("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      MAC_HOST,
      "true",
    ]).then(
      () => true,
      () => false,
    );
    if (!reachable)
      throw new Error(
        `Mac (${MAC_HOST}) is unreachable. Rerun with --skip-mac to release without it.`,
      );
    await run("git", ["push", "--force", MAC_REPO_URL, `${sha}:refs/heads/windows-sync`], {
      log: "mac.log",
    });
    const zip = `Pegasus-${ctx.version}-arm64-mac.zip`;
    // Version and sha come from validated values; the script travels over stdin, not a shell argument.
    const script = `set -euo pipefail
export PATH="$HOME/Pi/pi-gui-attachments/node_modules/.bin:$HOME/Pi/pi-gui-attachments/apps/desktop/node_modules/.bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
export CSC_IDENTITY_AUTO_DISCOVERY=false
cd "$HOME/Pi/pi-gui-attachments"
before=$(git rev-parse HEAD)
git merge --ff-only windows-sync
test "$(git rev-parse HEAD)" = "${sha}"
if ! git diff --quiet "$before" HEAD -- pnpm-lock.yaml; then pnpm install --frozen-lockfile; fi
(cd crates && PEGASUS_APP_VERSION=${ctx.version} cargo build --release -p pegasus-host && cargo test --release -p pegasus-core -p pegasus-host)
cd apps/desktop
rm -rf release/mac-arm64
pnpm run build
electron-builder --mac --dir --publish never -c.mac.identity=null -c.mac.notarize=false -c.extraMetadata.version=${ctx.version}
app=release/mac-arm64/Pegasus.app
codesign --force --deep -s - "$app"
codesign --verify --deep --strict "$app"
test "$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")" = "${ctx.version}"
mkdir -p "$HOME/Pi/release-staging"
rm -f "$HOME/Pi/release-staging/${zip}"
ditto -c -k --sequesterRsrc --keepParent "$app" "$HOME/Pi/release-staging/${zip}"
`;
    await run("ssh", [MAC_HOST, "bash", "-s"], { log: "mac.log", input: script });
    await run("scp", [`${MAC_HOST}:Pi/release-staging/${zip}`, "."], {
      cwd: ctx.stage,
      log: "mac.log",
    });
    if (!((await stat(path.join(ctx.stage, zip)).catch(() => undefined))?.size > 0))
      throw new Error(`${zip} was not copied back from the Mac`);
    ctx.assets.push(zip);
    ctx.macUsed = true;
  },

  async checksums() {
    const lines = [];
    for (const name of ctx.assets) {
      lines.push(`${(await hashFile(path.join(ctx.stage, name))).sha256}  ${name}`);
    }
    await writeFile(path.join(ctx.stage, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
    console.log(lines.map((line) => `  ${line}`).join("\n"));
  },

  async notes() {
    const last = await git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD");
    const subjects = (await git("log", "--no-merges", "--format=%s", `${last}..HEAD`))
      .split("\n")
      .filter((subject) => subject && !/^Pegasus \d+\.\d+\.\d+$/.test(subject));
    // A written summary (docs/pegasus-<version>.md) leads when there is one; the commit list follows.
    const summary = await readFile(path.join(repoDir, "docs", `pegasus-${ctx.version}.md`), "utf8")
      .then((text) => `${text.trim()}\n\n`)
      .catch(() => `Pegasus ${ctx.version}\n\n`);
    const body = `${summary}Changes since ${last}:\n\n${subjects.map((s) => `- ${s}`).join("\n")}\n`;
    await writeFile(path.join(ctx.stage, "RELEASE_NOTES.md"), body);
    console.log(`  ${subjects.length} commits since ${last}`);
  },

  async publish() {
    const tag = `v${ctx.version}`;
    const files = [...ctx.assets, "SHA256SUMS.txt"].map((name) => path.join(ctx.stage, name));
    if (dryRun) {
      console.log(
        `  dry run: would push main, tag ${tag}, and attach:\n${files.map((f) => `    ${f}`).join("\n")}`,
      );
      return;
    }
    await git("tag", tag);
    await git("push", REMOTE, "main");
    await git("push", REMOTE, tag);
    await out("gh", [
      "release",
      "create",
      tag,
      "-R",
      REPO,
      "--verify-tag",
      "--title",
      `Pegasus ${ctx.version}`,
      "--notes-file",
      path.join(ctx.stage, "RELEASE_NOTES.md"),
      ...files,
    ]);
  },
};

async function main() {
  ctx.original = await readVersion();
  ctx.version = await resolveVersion(ctx.original);
  ctx.stage = path.join(repoDir, ".artifacts", "release", ctx.version);
  logDir = path.join(ctx.stage, "logs");
  await mkdir(logDir, { recursive: true });
  console.log(
    `Pegasus release ${ctx.version}${dryRun ? " (dry run)" : ""}, from step '${args.from}'`,
  );

  // Resuming: assets already staged by earlier steps are picked up again.
  for (const name of [
    `Pegasus-${ctx.version}-x64-setup.exe`,
    `Pegasus-${ctx.version}-x64-portable.exe`,
    `Pegasus-${ctx.version}-arm64-mac.zip`,
  ]) {
    if (
      await stat(path.join(ctx.stage, name)).then(
        () => true,
        () => false,
      )
    ) {
      if (STEPS.indexOf(name.endsWith("zip") ? "mac" : "windows") < fromIndex)
        ctx.assets.push(name);
    }
  }
  if (dryRun && ctx.original !== ctx.version && fromIndex > STEPS.indexOf("bump")) {
    await writeVersion(ctx.version);
    ctx.restoreVersion = true;
  }

  const restore = async () => {
    if (ctx.restoreVersion) {
      ctx.restoreVersion = false;
      await writeVersion(ctx.original);
      console.log(`  restored package.json versions to ${ctx.original}`);
    }
  };
  process.on("SIGINT", () => void restore().finally(() => process.exit(130)));

  try {
    for (const [index, name] of STEPS.entries()) {
      // preflight always runs (cheap, and a resume must still be on main with a sane remote).
      if (index < fromIndex && name !== "preflight") continue;
      console.log(`[${name}] start`);
      const started = Date.now();
      try {
        await steps[name]();
      } catch (error) {
        console.error(`[${name}] FAILED after ${formatDuration(Date.now() - started)}`);
        console.error(String(error.message ?? error));
        console.error(
          `Logs: ${logDir}\nResume with: pnpm release --from ${name}${args.version ? ` --version ${args.version}` : ""}${dryRun ? " --dry-run" : ""}`,
        );
        throw error;
      }
      const elapsed = Date.now() - started;
      timings.push([name, elapsed]);
      console.log(`[${name}] done in ${formatDuration(elapsed)}`);
    }
  } finally {
    await restore();
  }

  console.log("\nTimings");
  for (const [name, ms] of timings) console.log(`  ${name.padEnd(10)} ${formatDuration(ms)}`);
  console.log(
    `  ${"total".padEnd(10)} ${formatDuration(timings.reduce((sum, [, ms]) => sum + ms, 0))}`,
  );
  console.log(`\nArtifacts in ${ctx.stage}`);
  for (const name of [...ctx.assets, "SHA256SUMS.txt", "RELEASE_NOTES.md"])
    console.log(`  ${name}`);
  for (const warning of ctx.warnings) console.warn(`WARNING: ${warning}`);
  console.log(
    dryRun
      ? "\nDry run complete: nothing was committed, tagged, pushed or released."
      : `\nReleased v${ctx.version}`,
  );
}

await main().catch(() => process.exit(1));
