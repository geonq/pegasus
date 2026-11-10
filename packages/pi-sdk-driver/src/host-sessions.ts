import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  getAgentDir,
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { HostCallError, type HostClient } from "@pi-gui/host-protocol";
import { noteHostFailure, setAgentDirResolver, sharedHost } from "@pi-gui/host-protocol/shared";
import { EXTENSION_PIN_CUSTOM_TYPE } from "@pi-gui/session-driver";

/**
 * Session index and context reads through the Rust `pegasus-host` (crates/pegasus-host), via the
 * process-wide connection in @pi-gui/host-protocol/shared. If the host is missing, crashes, times
 * out or refuses a file, the caller gets pi's own SessionManager path and the reason is logged, so
 * behaviour never depends on it and no failure is silent.
 */

// The host's profile is pi's agent dir, exactly as pi resolves it.
setAgentDirResolver(getAgentDir);

/** Run `viaHost`; on any host failure log it and run `viaPi` (pi's own reader). */
async function withFallback<T>(
  what: string,
  viaHost: (c: HostClient) => Promise<T>,
  viaPi: () => Promise<T>,
): Promise<T> {
  const c = await sharedHost();
  if (!c) return viaPi();
  try {
    return await viaHost(c);
  } catch (error) {
    // A refused file (old schema) is routine; a lost host starts the retry cooldown.
    if (!(error instanceof HostCallError)) noteHostFailure();
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
  const c = await sharedHost();
  if (!c) throw new Error("pegasus-host unavailable");
  return c.call("session.slice", { path: file, pinType: EXTENSION_PIN_CUSTOM_TYPE, start, count });
}

export {
  closeSharedHost as closeHostConnection,
  stopSharedHost as stopHost,
} from "@pi-gui/host-protocol/shared";
