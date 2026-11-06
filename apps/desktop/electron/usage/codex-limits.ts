import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AccountLimits, UsageLimitWindow } from "../../contracts/usage";

const TIMEOUT_MS = 8_000;
const MAX_STDOUT_BYTES = 256 * 1024;
const CLIENT_INFO = { name: "Pegasus", version: "1.0.0" };

type JsonObject = Record<string, unknown>;

/** Fetches the installed Codex account's current limits through its read-only app-server method. */
export async function readCodexLiveLimits(owner?: string): Promise<AccountLimits | null> {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  try {
    const binary = await findManagedCodexBinary(home);
    if (!binary) return null;
    const response = await readRateLimitsInWorker(binary, home);
    return parseCodexLiveLimits(response, owner);
  } catch {
    // The saved-session snapshot remains available if the managed CLI or live endpoint is unavailable.
    return null;
  }
}

/** Parses only the provider's primary/secondary account windows; malformed values never become zero. */
export function parseCodexLiveLimits(
  value: unknown,
  owner?: string,
  asOf = Date.now(),
): AccountLimits | null {
  const response = asObject(value);
  const result = asObject(response?.result) ?? response;
  const rateLimits = asObject(result?.rateLimits);
  if (!rateLimits) return null;

  const windows = (["primary", "secondary"] as const)
    .flatMap((slot) => {
      const source = asObject(rateLimits[slot]);
      const usedPercent = source?.usedPercent;
      if (
        !source ||
        typeof usedPercent !== "number" ||
        !Number.isFinite(usedPercent) ||
        usedPercent < 0 ||
        usedPercent > 100
      ) {
        return [];
      }
      const duration = source.windowDurationMins;
      const minutes =
        typeof duration === "number" && Number.isFinite(duration) && duration > 0
          ? duration
          : undefined;
      const window: UsageLimitWindow = {
        label: windowLabel(minutes, slot),
        usedPercent,
        ...(parseReset(source.resetsAt) !== undefined
          ? { resetsAt: parseReset(source.resetsAt) }
          : {}),
      };
      return [{ minutes: minutes ?? Number.POSITIVE_INFINITY, window }];
    })
    .sort((left, right) => left.minutes - right.minutes)
    .map(({ window }) => window);

  if (windows.length === 0) return null;
  return {
    id: "openai",
    name: owner ? `ChatGPT · ${owner}` : "ChatGPT",
    windows,
    asOf,
    note: "Live Codex account limits",
  };
}

/**
 * Release folders are named "<version>-<target>", e.g. "0.163.0-x86_64-pc-windows-msvc" or
 * "0.163.0-aarch64-apple-darwin": the target follows the version rather than starting the name.
 */
export function isCodexReleaseFor(name: string, arch: string, platform: string): boolean {
  const archPart =
    arch === "x64" ? "(?:x86_64|x64)" : arch === "arm64" ? "(?:aarch64|arm64)" : null;
  const osPart =
    platform === "win32"
      ? "pc-windows-msvc"
      : platform === "darwin"
        ? "apple-darwin"
        : platform === "linux"
          ? "unknown-linux-(?:musl|gnu)"
          : null;
  if (!archPart || !osPart) return false;
  return new RegExp(`^\\d+\\.\\d+\\.\\d+-${archPart}-${osPart}$`).test(name);
}

async function findManagedCodexBinary(home: string): Promise<string | null> {
  const releaseRoot = join(home, "packages", "app-server-daemon", "releases");
  const releases = await readdir(releaseRoot, { withFileTypes: true }).catch(() => []);
  const candidates = releases
    .filter(
      (entry) =>
        entry.isDirectory() && isCodexReleaseFor(entry.name, process.arch, process.platform),
    )
    .map((entry) => ({ name: entry.name, version: releaseVersion(entry.name) }))
    .filter(
      (entry): entry is { name: string; version: readonly number[] } => entry.version !== null,
    )
    .sort((left, right) => compareVersions(right.version, left.version));
  const executable = process.platform === "win32" ? "codex.exe" : "codex";

  for (const release of candidates) {
    const path = join(releaseRoot, release.name, "bin", executable);
    if (
      await stat(path)
        .then((entry) => entry.isFile())
        .catch(() => false)
    )
      return path;
  }
  return null;
}

function releaseVersion(name: string): readonly number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)-/.exec(name);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function windowLabel(minutes: number | undefined, slot: "primary" | "secondary"): string {
  if (minutes === undefined) return slot === "primary" ? "Primary" : "Secondary";
  if (minutes === 10_080) return "Weekly";
  if (minutes === 300) return "5-hour";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
  return `${Math.round(minutes / 60)}-hour`;
}

function parseReset(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value < 1_000_000_000_000
        ? value * 1_000
        : value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * readRateLimits in codex-limits-worker.js (built next to main.js), so spawning codex.exe never blocks
 * the main thread. The bundler moves this module into out/main/chunks/ (main and the worker share it),
 * so the worker is looked up one level up as well; only unbundled test runs read in-process.
 */
function readRateLimitsInWorker(binary: string, home: string): Promise<unknown> {
  const script = [__dirname, join(__dirname, "..")]
    .map((directory) => join(directory, "codex-limits-worker.js"))
    .find((candidate) => existsSync(candidate));
  if (!script) return readRateLimits(binary, home);
  return new Promise((resolve, reject) => {
    const worker = new Worker(script, { workerData: { binary, home } });
    let replied = false;
    worker.once("message", (result: { readonly value?: unknown; readonly error?: string }) => {
      replied = true;
      void worker.terminate().catch((error: unknown) => {
        console.error("[codex-limits] worker termination failed", error);
      });
      if (result.error !== undefined) reject(new Error(result.error));
      else resolve(result.value);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!replied) reject(new Error(`codex limits worker exited (${code})`));
    });
  });
}

export function readRateLimits(binary: string, home: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["app-server"], {
      cwd: home,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const decoder = new StringDecoder("utf8");
    const pending = new Map<
      number,
      { readonly resolve: (message: JsonObject) => void; readonly reject: (error: Error) => void }
    >();
    let nextId = 1;
    let receivedBytes = 0;
    let output = "";
    let finished = false;
    const timeout = setTimeout(() => fail(new Error("timeout")), TIMEOUT_MS);
    timeout.unref?.();

    const stop = () => {
      clearTimeout(timeout);
      try {
        child.stdin.end();
        child.kill();
      } catch {
        // The process may have exited between the response and cleanup.
      }
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      stop();
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      reject(error);
    };
    const finish = (value: unknown) => {
      if (finished) return;
      finished = true;
      stop();
      resolve(value);
    };

    child.once("error", () => fail(new Error("start failed")));
    child.once("close", () => {
      if (!finished) fail(new Error("process exited before the quota response"));
    });
    child.stdin.once("error", () => fail(new Error("stdin failed")));
    child.stdout.once("error", () => fail(new Error("stdout failed")));
    child.stdout.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_STDOUT_BYTES) {
        fail(new Error("output limit exceeded"));
        return;
      }
      output += decoder.write(chunk);
      let newline = output.indexOf("\n");
      while (newline >= 0) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        newline = output.indexOf("\n");
        if (!line) continue;
        let message: JsonObject;
        try {
          message = JSON.parse(line) as JsonObject;
        } catch {
          fail(new Error("invalid protocol response"));
          return;
        }
        const id = message.id;
        if (typeof id !== "number") continue;
        const waiter = pending.get(id);
        if (waiter) {
          pending.delete(id);
          waiter.resolve(message);
        }
      }
    });

    const request = (method: string, params: JsonObject): Promise<JsonObject> => {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        try {
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
            if (error && pending.has(id)) {
              pending.delete(id);
              rejectRequest(new Error("request write failed"));
            }
          });
        } catch {
          pending.delete(id);
          rejectRequest(new Error("request write failed"));
        }
      });
    };

    void (async () => {
      const initialized = await request("initialize", { clientInfo: CLIENT_INFO });
      if (initialized.error) throw new Error("initialization rejected");
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const response = await request("account/rateLimits/read", {});
      if (response.error) throw new Error("quota read rejected");
      finish(response.result);
    })().catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error("quota read failed"));
    });
  });
}
