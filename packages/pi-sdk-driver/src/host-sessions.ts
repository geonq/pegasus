import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { HostCallError, HostClient, hostEndpoint, type AttachOptions } from "@pi-gui/host-protocol";
import { EXTENSION_PIN_CUSTOM_TYPE } from "@pi-gui/session-driver";

/**
 * Session index and context reads through the Rust `pegasus-host` (crates/pegasus-host). The host
 * is shared by every window of the profile and outlives them. If it is missing, crashes, times out
 * or refuses a file, the caller gets pi's own SessionManager path and the reason is logged, so
 * behaviour never depends on it and no failure is silent.
 *
 * Env: PEGASUS_HOST=0 disables it; PEGASUS_HOST_PATH overrides the binary; PEGASUS_APP_VERSION
 * (set by Electron main) lets a newer app replace an older idle host; PEGASUS_HOST_IDLE_SECS
 * shortens the host's idle exit (tests).
 */

const RETRY_COOLDOWN_MS = 30_000;

function binaryName(): string {
  return process.platform === "win32" ? "pegasus-host.exe" : "pegasus-host";
}

/** Set by Electron only. */
function resourcesPath(): string | undefined {
  return "resourcesPath" in process && typeof process.resourcesPath === "string"
    ? process.resourcesPath
    : undefined;
}

function resolveBinary(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const resources = resourcesPath();
  const candidates = [
    process.env.PEGASUS_HOST_PATH,
    // Packaged app: electron-builder extraResources puts it next to app.asar.
    resources === undefined ? undefined : join(resources, "bin", binaryName()),
    // Dev checkout: packages/pi-sdk-driver/dist -> repo/crates/target/{release,debug}.
    join(here, "../../../crates/target/release", binaryName()),
    join(here, "../../../crates/target/debug", binaryName()),
  ];
  return candidates.find((p): p is string => p !== undefined && p !== "" && existsSync(p));
}

let attaching: Promise<HostClient | undefined> | undefined;
let client: HostClient | undefined;
let lastFailureAt = 0;
let loggedMissing = false;

function attachOptions(binary: string): AttachOptions {
  const agentDir = getAgentDir();
  const endpoint = hostEndpoint(agentDir);
  const appVersion = process.env.PEGASUS_APP_VERSION;
  const args = [
    "--endpoint",
    endpoint,
    "--sessions-root",
    join(agentDir, "sessions"),
    "--cache",
    join(agentDir, "pegasus-index-cache.json"),
    "--log-dir",
    join(agentDir, "logs"),
  ];
  const idle = process.env.PEGASUS_HOST_IDLE_SECS;
  if (idle) args.push("--idle-exit-secs", idle);
  return {
    endpoint,
    launch: { binary, args },
    client: "pi-sdk-driver",
    // Without an app version (dev, tests) any host version is accepted.
    appVersion: appVersion ?? "dev",
    replaceMismatched: appVersion !== undefined,
  };
}

async function host(): Promise<HostClient | undefined> {
  if (process.env.PEGASUS_HOST === "0") return undefined;
  if (client && !client.closed) return client;
  if (attaching) return attaching;
  if (Date.now() - lastFailureAt < RETRY_COOLDOWN_MS) return undefined;
  const binary = resolveBinary();
  if (!binary) {
    if (!loggedMissing) {
      loggedMissing = true;
      console.warn("[pegasus-host] binary not found; using pi's SessionManager for session reads");
    }
    return undefined;
  }
  attaching = HostClient.attach(attachOptions(binary))
    .then((c) => {
      client = c;
      return c;
    })
    .catch((error: unknown) => {
      lastFailureAt = Date.now();
      console.warn("[pegasus-host] attach failed; falling back to pi's reader:", error);
      return undefined;
    })
    .finally(() => {
      attaching = undefined;
    });
  return attaching;
}

/** Run `viaHost`; on any host failure log it and run `viaPi` (pi's own reader). */
async function withFallback<T>(
  what: string,
  viaHost: (c: HostClient) => Promise<T>,
  viaPi: () => Promise<T>,
): Promise<T> {
  const c = await host();
  if (!c) return viaPi();
  try {
    return await viaHost(c);
  } catch (error) {
    // A refused file (old schema) is routine; a lost host starts the retry cooldown.
    if (!(error instanceof HostCallError)) lastFailureAt = Date.now();
    console.warn(`[pegasus-host] ${what} failed, using SessionManager:`, error);
    return viaPi();
  }
}

/** pi's default session directory for a cwd (same encoding as SessionManager.list). */
function defaultSessionDir(cwd: string): string {
  const safe = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(getAgentDir(), "sessions", safe);
}

/** Drop-in for `SessionManager.list(cwd)`. `allMessagesText` is empty (only `firstMessage` is used). */
export function listSessionInfos(cwd: string): Promise<SessionInfo[]> {
  const dir = defaultSessionDir(cwd);
  return withFallback(
    "session list",
    async (c) => {
      if (!existsSync(dir)) return [];
      const { sessions } = await c.call("index.list", { dir });
      return sessions.map((s) => ({
        path: s.path,
        id: s.id,
        cwd: s.cwd,
        ...(s.name === null ? {} : { name: s.name }),
        ...(s.parentSessionPath === null ? {} : { parentSessionPath: s.parentSessionPath }),
        created: new Date(s.createdMs ?? Number.NaN),
        modified: new Date(s.modifiedMs),
        messageCount: s.messageCount,
        firstMessage: s.firstMessage,
        allMessagesText: "",
      }));
    },
    () => SessionManager.list(cwd),
  );
}

type TranscriptSource = Pick<SessionManager, "buildContextEntries" | "getBranch">;

/**
 * What `transcriptFromSession` needs from a closed session: the rendered context entries and the
 * pins on the branch. Read natively when the host can; otherwise pi opens (and parses) the file.
 */
export function openTranscriptSource(file: string): Promise<TranscriptSource> {
  return withFallback<TranscriptSource>(
    "transcript read",
    async (c) => {
      const ctx = await c.call("session.context", {
        path: file,
        pinType: EXTENSION_PIN_CUSTOM_TYPE,
      });
      return { buildContextEntries: () => [...ctx.entries], getBranch: () => [...ctx.pins] };
    },
    async () => SessionManager.open(file),
  );
}

/** Rows `start..start+count` of a session's rendered context, as pi wrote them. */
export async function sliceSessionRows(
  file: string,
  start: number,
  count: number,
): Promise<{ total: number; entries: readonly SessionEntry[] }> {
  const c = await host();
  if (!c) throw new Error("pegasus-host unavailable");
  return c.call("session.slice", { path: file, pinType: EXTENSION_PIN_CUSTOM_TYPE, start, count });
}

/** Drop this process's connection; the host keeps running for other clients until idle. */
export function closeHostConnection(): void {
  client?.close();
  client = undefined;
}

/** Ask the profile's host to exit now (tests, uninstall). Resolves when it accepted or was absent. */
export async function stopHost(): Promise<void> {
  const c = await host();
  if (c) await c.call("shutdown", { reason: "stopHost", force: true }).catch(() => undefined);
  closeHostConnection();
}
