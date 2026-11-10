import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HostClient, hostEndpoint, type AttachOptions } from "./index.js";
import type { HostEvent } from "./generated.js";

/**
 * The process-wide connection to this profile's `pegasus-host`: finds the binary (override,
 * packaged, or newest dev build), starts the host when none runs, and reconnects when the profile
 * changes. Electron main, the agent driver and tests all go through here, so one process never
 * holds two connections to one host.
 *
 * Env: PEGASUS_HOST=0 disables it; PEGASUS_HOST_PATH overrides the binary; PEGASUS_APP_VERSION
 * (set by a packaged app) lets a newer app replace an older idle host; PEGASUS_HOST_IDLE_SECS
 * shortens the host's idle exit (tests).
 */

const RETRY_COOLDOWN_MS = 30_000;

/** pi's agent dir: PI_CODING_AGENT_DIR or ~/.pi/agent. The driver installs pi's own resolver. */
let agentDirOf = (): string => {
  const dir = process.env.PI_CODING_AGENT_DIR;
  return dir ? resolve(dir.replace(/^~(?=$|[/\\])/, homedir())) : join(homedir(), ".pi", "agent");
};

export function setAgentDirResolver(resolver: () => string): void {
  agentDirOf = resolver;
}

function binaryName(): string {
  return process.platform === "win32" ? "pegasus-host.exe" : "pegasus-host";
}

/** Set by Electron only. */
function resourcesPath(): string | undefined {
  return "resourcesPath" in process && typeof process.resourcesPath === "string"
    ? process.resourcesPath
    : undefined;
}

/**
 * Dev checkout: walk up from the working directory to the repo's crates/target. Electron dev runs,
 * test runners and package scripts all start inside the repo; packaged apps use resourcesPath.
 */
function devBinaries(): string[] {
  const found: string[] = [];
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    for (const profile of ["release", "debug"]) {
      found.push(join(dir, "crates", "target", profile, binaryName()));
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

function resolveBinary(agentDir: string): string | undefined {
  const override = process.env.PEGASUS_HOST_PATH;
  if (override && existsSync(override)) return override;
  // Packaged app: electron-builder extraResources puts it next to app.asar.
  const resources = resourcesPath();
  const bundled = resources === undefined ? undefined : join(resources, "bin", binaryName());
  if (bundled && existsSync(bundled)) return runnableCopy(bundled, agentDir);
  // Dev: the most recently built of release/debug, so a stale release build never shadows new code.
  return devBinaries()
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/**
 * The host outlives the app, and Windows cannot replace a running .exe, so a packaged app runs the
 * host from a per-version copy in the profile; the installer is then always free to replace the
 * bundled binary. Older copies are removed when no host runs from them (a locked file stays).
 */
function runnableCopy(bundled: string, agentDir: string): string {
  const version = process.env.PEGASUS_APP_VERSION;
  if (!version || !/^[\w.+-]+$/.test(version)) return bundled;
  const root = join(agentDir, "host-bin");
  const target = join(root, version, binaryName());
  try {
    if (!existsSync(target) || statSync(target).size !== statSync(bundled).size) {
      mkdirSync(dirname(target), { recursive: true });
      const partial = `${target}.partial`;
      copyFileSync(bundled, partial);
      renameSync(partial, target);
    }
    for (const entry of readdirSync(root)) {
      if (entry === version) continue;
      try {
        rmSync(join(root, entry), { recursive: true, force: true });
      } catch {
        // Still running from that copy; the next start cleans it up.
      }
    }
    return target;
  } catch (error) {
    console.warn(
      "[pegasus-host] could not stage a runnable copy; running the bundled binary:",
      error,
    );
    return bundled;
  }
}

function attachOptions(binary: string, agentDir: string): AttachOptions {
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
    client: "pegasus",
    // Without an app version (dev, tests) any host version is accepted.
    appVersion: appVersion ?? "dev",
    replaceMismatched: appVersion !== undefined,
  };
}

let attaching: Promise<HostClient | undefined> | undefined;
let client: { readonly agentDir: string; readonly host: HostClient } | undefined;
let lastFailureAt = 0;
let loggedMissing = false;
const eventListeners = new Set<(event: HostEvent) => void>();

/**
 * The profile's host, attached on demand. `retryNow` skips the cooldown after a failed attach
 * (features that need the host, such as terminals, try every time; accelerators back off).
 * Resolves undefined, with the reason logged, when the host is disabled or cannot start.
 */
export async function sharedHost(retryNow = false): Promise<HostClient | undefined> {
  if (process.env.PEGASUS_HOST === "0") return undefined;
  const agentDir = agentDirOf();
  if (client && !client.host.closed && client.agentDir === agentDir) return client.host;
  if (client && client.agentDir !== agentDir) closeSharedHost();
  if (attaching) return attaching;
  if (!retryNow && Date.now() - lastFailureAt < RETRY_COOLDOWN_MS) return undefined;
  const binary = resolveBinary(agentDir);
  if (!binary) {
    if (!loggedMissing) {
      loggedMissing = true;
      console.warn("[pegasus-host] binary not found; build crates/pegasus-host");
    }
    return undefined;
  }
  attaching = HostClient.attach(attachOptions(binary, agentDir))
    .then((host) => {
      client = { agentDir, host };
      for (const listener of eventListeners) host.onEvent(listener);
      return host;
    })
    .catch((error: unknown) => {
      lastFailureAt = Date.now();
      console.warn("[pegasus-host] attach failed:", error);
      return undefined;
    })
    .finally(() => {
      attaching = undefined;
    });
  return attaching;
}

/** A host call failed in transport (not a typed refusal): back off before the next attach. */
export function noteHostFailure(): void {
  lastFailureAt = Date.now();
}

/** Receive host events on this and every later connection (reconnects included). */
export function onSharedHostEvent(listener: (event: HostEvent) => void): () => void {
  eventListeners.add(listener);
  const off = client && !client.host.closed ? client.host.onEvent(listener) : undefined;
  return () => {
    eventListeners.delete(listener);
    off?.();
  };
}

/** Drop this process's connection; the host keeps running for other clients until idle. */
export function closeSharedHost(): void {
  client?.host.close();
  client = undefined;
}

/** Ask the profile's host to exit now (tests, uninstall). Resolves once it accepted or was absent. */
export async function stopSharedHost(): Promise<void> {
  const host = await sharedHost(true);
  if (host) await host.call("shutdown", { reason: "stop", force: true }).catch(() => undefined);
  closeSharedHost();
}
