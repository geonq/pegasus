import type { WebContents } from "electron";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { HostClient, HostEvent } from "@pi-gui/host-protocol";
import type {
  TerminalPanelSnapshot,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalSize,
} from "../../contracts/ipc";
import { desktopIpc } from "../../contracts/ipc";
import { appendTerminalReplay } from "../../contracts/terminal-model";

/**
 * Integrated terminals. The processes live in the Rust host (crates/pegasus-host: ConPTY on
 * Windows, openpty elsewhere), which batches their output; this service keeps the per-window tab
 * model, mirrors the replay for instant snapshots, and routes host events to the owning window.
 * A missing host is a visible terminal error, never a silent no-op.
 */

const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 };
/** Host requests are capped at 1 MiB; stay well below it. */
const MAX_WRITE_LENGTH = 128 * 1024;
const MAX_TERMINAL_SESSIONS_PER_ROOT = 8;

interface TerminalRoot {
  readonly rootKey: string;
  readonly workspaceRootKey: string;
  readonly workspaceId: string;
  readonly terminalScopeId: string;
  readonly cwd: string;
  activeSessionId: string | undefined;
  readonly sessionIds: string[];
}

interface TerminalSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly terminalScopeId: string;
  readonly rootKey: string;
  readonly cwd: string;
  readonly ownerWebContentsId: number;
  readonly webContents: WebContents;
  /** Host terminal id; a restart spawns under a fresh one so late events of the old process are ignored. */
  hostId: string | undefined;
  generation: number;
  shell: string;
  title: string;
  status: TerminalSessionStatus;
  replay: string;
  truncated: boolean;
  exitCode: number | undefined;
  signal: number | undefined;
  size: TerminalSize;
}

export interface TerminalServiceOptions {
  readonly getWorkspacePath: (workspaceId: string) => string | undefined;
  readonly getIntegratedTerminalShell: () => string | undefined;
  readonly connectHost: () => Promise<HostClient | undefined>;
  readonly onHostEvent: (listener: (event: HostEvent) => void) => () => void;
}

export class TerminalService {
  private readonly rootsByKey = new Map<string, TerminalRoot>();
  private readonly sessionsById = new Map<string, TerminalSession>();
  private readonly sessionsByHostId = new Map<string, TerminalSession>();
  private nextSessionNumber = 1;
  private readonly offHostEvent: () => void;

  constructor(private readonly options: TerminalServiceOptions) {
    this.offHostEvent = options.onHostEvent((event) => this.onHostEvent(event));
  }

  async ensurePanel(
    webContents: WebContents,
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot> {
    const root = this.ensureRoot(webContents, workspaceId, terminalScopeId);
    if (!root.activeSessionId || root.sessionIds.length === 0) {
      const session = this.createSessionForRoot(webContents, root, size);
      root.sessionIds.push(session.id);
      root.activeSessionId = session.id;
      await this.spawn(session);
    }
    return this.snapshotRoot(root);
  }

  async createSession(
    webContents: WebContents,
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot> {
    const root = this.ensureRoot(webContents, workspaceId, terminalScopeId);
    if (root.sessionIds.length >= MAX_TERMINAL_SESSIONS_PER_ROOT) {
      throw new Error(
        `A workspace can have up to ${MAX_TERMINAL_SESSIONS_PER_ROOT} terminal tabs.`,
      );
    }
    const session = this.createSessionForRoot(webContents, root, size);
    root.sessionIds.push(session.id);
    root.activeSessionId = session.id;
    await this.spawn(session);
    return this.snapshotRoot(root);
  }

  setActiveSession(
    webContents: WebContents,
    workspaceId: string,
    terminalScopeId: string,
    terminalId: string,
  ): TerminalPanelSnapshot {
    const session = this.requireOwnedSession(webContents, terminalId);
    if (session.workspaceId !== workspaceId || session.terminalScopeId !== terminalScopeId) {
      throw new Error(`Terminal session ${terminalId} does not belong to this thread`);
    }
    const root = this.requireRoot(session.rootKey);
    if (!root.sessionIds.includes(terminalId)) {
      throw new Error(`Unknown terminal session: ${terminalId}`);
    }
    root.activeSessionId = terminalId;
    return this.snapshotRoot(root);
  }

  write(webContents: WebContents, terminalId: string, data: string): void {
    const session = this.requireOwnedSession(webContents, terminalId);
    const hostId = session.hostId;
    if (typeof data !== "string" || data.length === 0 || !hostId || session.status !== "running") {
      return;
    }
    // Chunk large input (a big paste) instead of dropping it; never split a UTF-16 surrogate pair.
    const chunks: string[] = [];
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + MAX_WRITE_LENGTH, data.length);
      if (end < data.length) {
        const code = data.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }
      chunks.push(data.slice(offset, end));
      offset = end;
    }
    this.onHost(session, "write", async (host) => {
      for (const chunk of chunks) await host.call("terminal.write", { id: hostId, data: chunk });
    });
  }

  resize(webContents: WebContents, terminalId: string, size: TerminalSize): void {
    const session = this.requireOwnedSession(webContents, terminalId);
    const normalizedSize = normalizeSize(size);
    session.size = normalizedSize;
    const hostId = session.hostId;
    if (!hostId || session.status !== "running") return;
    this.onHost(session, "resize", (host) =>
      host.call("terminal.resize", { id: hostId, ...normalizedSize }),
    );
  }

  async restart(
    webContents: WebContents,
    terminalId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot> {
    const session = this.requireOwnedSession(webContents, terminalId);
    this.killHostTerminal(session);
    session.shell = this.resolveShell();
    session.title = this.defaultTitle(session);
    session.status = "running";
    session.replay = "";
    session.truncated = false;
    session.exitCode = undefined;
    session.signal = undefined;
    session.size = normalizeSize(size ?? session.size);
    await this.spawn(session);
    return this.snapshotRoot(this.requireRoot(session.rootKey));
  }

  close(webContents: WebContents, terminalId: string): TerminalPanelSnapshot | null {
    const session = this.requireOwnedSession(webContents, terminalId);
    const root = this.requireRoot(session.rootKey);
    this.killHostTerminal(session);
    this.sessionsById.delete(session.id);

    const index = root.sessionIds.indexOf(session.id);
    if (index >= 0) {
      root.sessionIds.splice(index, 1);
    }

    if (root.sessionIds.length === 0) {
      this.rootsByKey.delete(root.rootKey);
      return null;
    }

    if (root.activeSessionId === session.id) {
      const nextIndex = Math.min(index, root.sessionIds.length - 1);
      root.activeSessionId = root.sessionIds[nextIndex];
    }
    return this.snapshotRoot(root);
  }

  setTitle(webContents: WebContents, terminalId: string, title: string): void {
    const session = this.requireOwnedSession(webContents, terminalId);
    const normalizedTitle = title.trim();
    session.title =
      normalizedTitle.length > 0 ? normalizedTitle.slice(0, 80) : this.defaultTitle(session);
  }

  retainWorkspacePaths(workspacePaths: readonly string[]): void {
    const retained = new Set(
      workspacePaths.map((workspacePath) => normalizeRootKey(workspacePath)),
    );
    for (const [rootKey, root] of this.rootsByKey) {
      if (!retained.has(root.workspaceRootKey)) {
        for (const sessionId of root.sessionIds) {
          const session = this.sessionsById.get(sessionId);
          if (session) {
            this.killHostTerminal(session);
            this.sessionsById.delete(session.id);
          }
        }
        this.rootsByKey.delete(rootKey);
      }
    }
  }

  disposeWebContents(webContentsId: number): void {
    const rootKeysToDelete = new Set<string>();
    for (const [sessionId, session] of this.sessionsById) {
      if (session.ownerWebContentsId !== webContentsId) {
        continue;
      }
      this.killHostTerminal(session);
      this.sessionsById.delete(sessionId);
      rootKeysToDelete.add(session.rootKey);
    }
    for (const rootKey of rootKeysToDelete) {
      this.rootsByKey.delete(rootKey);
    }
  }

  dispose(): void {
    for (const session of this.sessionsById.values()) {
      this.killHostTerminal(session);
    }
    this.sessionsById.clear();
    this.rootsByKey.clear();
    this.offHostEvent();
  }

  private onHostEvent(event: HostEvent): void {
    if (event.event === "shuttingDown") return;
    const session = this.sessionsByHostId.get(event.data.id);
    if (!session) return;
    if (event.event === "terminalData") {
      const next = appendTerminalReplay(session.replay, event.data.data, session.truncated);
      session.replay = next.replay;
      session.truncated = next.truncated;
      this.sendToOwner(session, desktopIpc.terminalData, {
        terminalId: session.id,
        data: event.data.data,
      });
      return;
    }
    session.status = "exited";
    session.exitCode = event.data.exitCode ?? undefined;
    session.signal = undefined;
    this.sessionsByHostId.delete(event.data.id);
    // The process is gone; forget it in the host too (its replay is mirrored here).
    const hostId = event.data.id;
    session.hostId = undefined;
    this.onHost(session, "forget", (host) => host.call("terminal.kill", { id: hostId }));
    this.sendToOwner(session, desktopIpc.terminalExit, {
      terminalId: session.id,
      exitCode: session.exitCode ?? 0,
    });
  }

  private async spawn(session: TerminalSession): Promise<void> {
    session.generation += 1;
    const hostId = `${session.id}.${session.generation}`;
    try {
      const host = await this.options.connectHost();
      if (!host) throw new Error("The Pegasus host is not running; see the host log.");
      this.sessionsByHostId.set(hostId, session);
      session.hostId = hostId;
      await host.call("terminal.spawn", {
        id: hostId,
        shell: session.shell,
        args: [],
        cwd: session.cwd,
        env: buildTerminalEnv(),
        cols: session.size.cols,
        rows: session.size.rows,
        tag: JSON.stringify({ workspaceId: session.workspaceId, scope: session.terminalScopeId }),
      });
    } catch (error) {
      this.sessionsByHostId.delete(hostId);
      session.hostId = undefined;
      session.status = "error";
      const message = error instanceof Error ? error.message : String(error);
      const next = appendTerminalReplay(session.replay, `${message}\r\n`, session.truncated);
      session.replay = next.replay;
      session.truncated = next.truncated;
      this.sendToOwner(session, desktopIpc.terminalError, { terminalId: session.id, message });
    }
  }

  /** Fire-and-forget form of `withHost` for input paths (write, resize, close). */
  private onHost(
    session: TerminalSession,
    what: string,
    run: (host: HostClient) => Promise<unknown>,
  ): void {
    this.withHost(session, what, run).catch((error: unknown) => {
      console.warn(`[terminal] ${session.id} ${what}:`, error);
    });
  }

  /** Runs a host call for a session; a failure is shown in that terminal and logged. */
  private async withHost(
    session: TerminalSession,
    what: string,
    run: (host: HostClient) => Promise<unknown>,
  ): Promise<void> {
    try {
      const host = await this.options.connectHost();
      if (!host) throw new Error("The Pegasus host is not running; see the host log.");
      await run(host);
    } catch (error) {
      const message = `terminal ${what} failed: ${error instanceof Error ? error.message : String(error)}`;
      console.warn(`[terminal] ${session.id} ${message}`);
      this.sendToOwner(session, desktopIpc.terminalError, { terminalId: session.id, message });
    }
  }

  private killHostTerminal(session: TerminalSession): void {
    const hostId = session.hostId;
    session.hostId = undefined;
    if (!hostId) return;
    this.sessionsByHostId.delete(hostId);
    this.onHost(session, "close", (host) => host.call("terminal.kill", { id: hostId }));
  }

  private ensureRoot(
    webContents: WebContents,
    workspaceId: string,
    terminalScopeId: string,
  ): TerminalRoot {
    const normalizedScopeId = terminalScopeId.trim();
    if (!normalizedScopeId) {
      throw new Error("Terminal scope is required");
    }
    const workspacePath = this.options.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    ensureDirectory(workspacePath);
    const workspaceRootKey = normalizeRootKey(workspacePath);
    const rootKey = `${webContents.id}\0${workspaceRootKey}\0${normalizedScopeId}`;
    const existingRoot = this.rootsByKey.get(rootKey);
    if (existingRoot) {
      return existingRoot;
    }
    const root: TerminalRoot = {
      rootKey,
      workspaceRootKey,
      workspaceId,
      terminalScopeId: normalizedScopeId,
      cwd: workspaceRootKey,
      activeSessionId: undefined,
      sessionIds: [],
    };
    this.rootsByKey.set(rootKey, root);
    return root;
  }

  private createSessionForRoot(
    webContents: WebContents,
    root: TerminalRoot,
    size?: Partial<TerminalSize>,
  ): TerminalSession {
    const session: TerminalSession = {
      id: `terminal-${Date.now().toString(36)}-${this.nextSessionNumber++}`,
      workspaceId: root.workspaceId,
      terminalScopeId: root.terminalScopeId,
      rootKey: root.rootKey,
      cwd: root.cwd,
      ownerWebContentsId: webContents.id,
      webContents,
      hostId: undefined,
      generation: 0,
      shell: this.resolveShell(),
      title: "",
      status: "running",
      replay: "",
      truncated: false,
      exitCode: undefined,
      signal: undefined,
      size: normalizeSize(size),
    };
    session.title = this.defaultTitle(session);
    this.sessionsById.set(session.id, session);
    return session;
  }

  private sendToOwner(session: TerminalSession, channel: string, payload: unknown): void {
    const webContents = session.webContents;
    if (webContents.id === session.ownerWebContentsId && !webContents.isDestroyed()) {
      webContents.send(channel, payload);
    }
  }

  private requireOwnedSession(webContents: WebContents, terminalId: string): TerminalSession {
    const session = this.sessionsById.get(terminalId);
    if (!session || session.ownerWebContentsId !== webContents.id) {
      throw new Error(`Unknown terminal session: ${terminalId}`);
    }
    return session;
  }

  private requireRoot(rootKey: string): TerminalRoot {
    const root = this.rootsByKey.get(rootKey);
    if (!root) {
      throw new Error(`Unknown terminal root: ${rootKey}`);
    }
    return root;
  }

  private snapshotRoot(root: TerminalRoot): TerminalPanelSnapshot {
    const sessions = root.sessionIds
      .map((sessionId) => this.sessionsById.get(sessionId))
      .filter((session): session is TerminalSession => Boolean(session));
    const activeSessionId =
      root.activeSessionId && sessions.some((session) => session.id === root.activeSessionId)
        ? root.activeSessionId
        : (sessions[0]?.id ?? "");
    return {
      workspaceId: root.workspaceId,
      rootKey: root.rootKey,
      activeSessionId,
      sessions: sessions.map((session) => this.snapshotSession(session)),
    };
  }

  private snapshotSession(session: TerminalSession): TerminalSessionSnapshot {
    return {
      id: session.id,
      workspaceId: session.workspaceId,
      cwd: session.cwd,
      shell: session.shell,
      title: session.title,
      status: session.status,
      replay: session.replay,
      truncated: session.truncated,
      exitCode: session.exitCode,
      signal: session.signal,
    };
  }

  private defaultTitle(session: TerminalSession): string {
    return `Terminal ${session.id.split("-").at(-1) ?? ""}`.trim();
  }

  private resolveShell(): string {
    const configuredShell = this.options.getIntegratedTerminalShell()?.trim();
    const shellPath = configuredShell || process.env.SHELL || defaultShellForPlatform();
    if (process.platform !== "win32" && !path.isAbsolute(shellPath)) {
      throw new Error(`Integrated terminal shell must be an absolute path: ${shellPath}`);
    }
    ensureExecutable(shellPath);
    return shellPath;
  }
}

function normalizeSize(size?: Partial<TerminalSize>): TerminalSize {
  return {
    cols: clampInteger(size?.cols, DEFAULT_TERMINAL_SIZE.cols, 10, 500),
    rows: clampInteger(size?.rows, DEFAULT_TERMINAL_SIZE.rows, 4, 200),
  };
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function normalizeRootKey(workspacePath: string): string {
  try {
    return realpathSync.native(workspacePath);
  } catch {
    return path.resolve(workspacePath);
  }
}

function ensureDirectory(directoryPath: string): void {
  const stats = statSync(directoryPath);
  if (!stats.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${directoryPath}`);
  }
}

function ensureExecutable(shellPath: string): void {
  if (process.platform === "win32") {
    return;
  }
  accessSync(shellPath, constants.X_OK);
}

function defaultShellForPlatform(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec || "cmd.exe";
  }
  if (process.platform === "darwin") {
    return "/bin/zsh";
  }
  return "/bin/bash";
}

function buildTerminalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.TERM = "xterm-256color";
  // xterm.js renders 24-bit colour; CLIs (Claude Code, etc.) only emit it when told.
  env.COLORTERM = "truecolor";
  // Inherited NO_COLOR / FORCE_COLOR (FORCE_COLOR=1 caps Node CLIs at 16 colours, =0 disables
  // colour) must not leak from whatever launched Pegasus; the pty is a real colour terminal.
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  delete env.TERMINFO;
  delete env.TERMINFO_DIRS;
  // Host variables of this process must not leak into user shells.
  delete env.PEGASUS_HOST_PATH;
  delete env.PEGASUS_HOST_IDLE_SECS;
  return env;
}
