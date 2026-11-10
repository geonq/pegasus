import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { isMainFrameSender } from "../ipc/main-frame-ipc";
import type { DesktopAppViewState } from "../../contracts/desktop-state";
import type { ComposerImageAttachment, DesktopAppState } from "../../contracts/desktop-state";
import type {
  WorkspaceFolderAdapters,
  WorkspaceFolderDevice,
} from "../../contracts/workspace-folders";
import {
  isRemoteBrokerReady,
  isRemoteBrokerResponse,
  isRemoteDesktopEvent,
  remoteBrokerIpc,
  type RemoteBrokerRequest,
  type RemoteDesktopEvent,
  type RemoteDesktopPiMethod,
} from "./remote-desktop-protocol";
import {
  assertRemoteJsonSize,
  filterRemoteState,
  projectRemoteResult,
  validateRemoteDesktopInvocation,
  type RemoteDesktopInvocation,
} from "./remote-desktop-policy";
import type { WindowOwner } from "../windows/window-owner";
import { answerActiveRuns, type ActiveRun } from "../usage/active-runs";
import { createRemoteWorkspaceFolders } from "./remote-workspace-folders";
import { RemoteWorkspaceStateProjector } from "./remote-workspace-state-projector";

const MAX_PENDING_REQUESTS = 32;
const MAX_BRIDGE_BYTES = 24 * 1024 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const RENDERER_READY_TIMEOUT_MS = 15_000;
/** Reviews this device opened; older ones fall out so the set stays small. */
const MAX_KNOWN_REVIEWS = 256;

export interface RemoteDesktopBrokerOptions {
  /** Stable identifier from the authenticated device configuration; never a credential. */
  readonly clientId: string;
  /** Authenticated workspace scope for this one remote device. */
  readonly workspaceIds: readonly string[];
  /** Trusted host adapters; Windows roots' absolute paths stay in main-process scope. */
  readonly workspaceFolders: WorkspaceFolderAdapters;
  readonly windowsFolderRootPaths: ReadonlyMap<string, string>;
  /** Only configured project-create roots may grant registered future descendants. */
  readonly futureWorkspaceRootPaths?: ReadonlyMap<string, string>;
  readonly initialWorkspaceId?: string;
  readonly initialSessionId?: string;
  readonly preloadPath: string;
  readonly pageUrl: string;
  readonly windows: Pick<
    WindowOwner,
    | "addPassiveRemoteView"
    | "remove"
    | "viewForWindow"
    | "isPassiveRemoteSender"
    | "runStateResultAction"
    | "stateForWindow"
  >;
  /** Uses the host's background-instruction path for an existing thread. */
  readonly sendText: (input: {
    readonly clientId: string;
    readonly sessionRef: { readonly workspaceId: string; readonly sessionId: string };
    readonly text: string;
    /** A running chat takes it at its next turn instead of after the run. */
    readonly deliverAs?: "steer";
    /** Images the client read on its own machine, already checked by the remote policy. */
    readonly attachments?: readonly ComposerImageAttachment[];
  }) => Promise<void>;
  /** Running threads host-wide; answered only for the Seher server's client. */
  readonly getActiveRuns?: () => readonly ActiveRun[];
}

interface PendingRequest {
  readonly method: RemoteDesktopPiMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export type RemoteDesktopEventListener = (event: RemoteDesktopEvent) => void;

/**
 * One hidden passive app view for one authenticated remote device. Invoke only
 * the explicit public PiDesktopApi allowlist below; arbitrary Electron channel
 * names are never accepted here or by the renderer bridge.
 */
export class RemoteDesktopBroker {
  private readonly window: BrowserWindow;
  private readonly workspaceIds: Set<string>;
  private readonly folderRootIds: {
    readonly windows: Set<string>;
    readonly mac: Set<string>;
  };
  private readonly windowsWorkspaceFolders: ReturnType<typeof createRemoteWorkspaceFolders>;
  private readonly workspaceStateProjector: RemoteWorkspaceStateProjector;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<RemoteDesktopEventListener>();
  private readonly reviewIds = new Set<string>();
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private disposed = false;
  private readonly handleResponse = (event: IpcMainEvent, payload: unknown) => {
    if (!this.isBrokerMainFrame(event)) return;
    void this.receiveResponse(payload).catch(() => undefined);
  };
  private readonly handleEvent = (event: IpcMainEvent, payload: unknown) => {
    if (!this.isBrokerMainFrame(event) || !isRemoteDesktopEvent(payload)) return;
    this.receiveEvent(payload);
  };
  private readonly handleReady = (event: IpcMainEvent, payload: unknown) => {
    if (this.isBrokerMainFrame(event) && isRemoteBrokerReady(payload)) this.resolveReady();
  };

  private constructor(private readonly options: RemoteDesktopBrokerOptions) {
    this.workspaceIds = new Set(options.workspaceIds);
    this.workspaceStateProjector = new RemoteWorkspaceStateProjector(
      this.workspaceIds,
      options.futureWorkspaceRootPaths ?? new Map(),
    );
    this.folderRootIds = {
      windows: new Set(options.windowsFolderRootPaths.keys()),
      mac: new Set(),
    };
    this.windowsWorkspaceFolders = createRemoteWorkspaceFolders(options.windowsFolderRootPaths);
    const initialWorkspaceId = this.workspaceIds.has(options.initialWorkspaceId ?? "")
      ? options.initialWorkspaceId!
      : options.workspaceIds[0]!;
    const sourceView: DesktopAppViewState = {
      selectedWorkspaceId: initialWorkspaceId,
      selectedSessionId:
        options.initialWorkspaceId === initialWorkspaceId ? options.initialSessionId : undefined,
      activeView: "threads",
    };
    this.window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      focusable: false,
      skipTaskbar: true,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        partition: `remote-broker-${randomUUID()}`,
      },
    });
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    options.windows.addPassiveRemoteView(this.window, sourceView);
    this.window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => {
        callback(false);
      },
    );
    this.window.webContents.session.setPermissionCheckHandler(() => false);
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("will-navigate", (event, url) => {
      if (!isSameBrokerUrl(url, options.pageUrl)) event.preventDefault();
    });
    this.window.webContents.on("will-redirect", (event, url) => {
      if (!isSameBrokerUrl(url, options.pageUrl)) event.preventDefault();
    });
    this.window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    this.window.on("closed", () => this.dispose(false));
    this.window.webContents.once("destroyed", () => this.dispose(false));
    this.window.webContents.on("render-process-gone", () =>
      this.rejectAll("Remote broker renderer exited."),
    );
    ipcMain.on(remoteBrokerIpc.response, this.handleResponse);
    ipcMain.on(remoteBrokerIpc.event, this.handleEvent);
    ipcMain.on(remoteBrokerIpc.ready, this.handleReady);
  }

  static async create(options: RemoteDesktopBrokerOptions): Promise<RemoteDesktopBroker> {
    const workspaceIds = [...new Set(options.workspaceIds.filter(isNonEmptyString))];
    if (!isNonEmptyString(options.clientId)) throw new TypeError("Remote client ID is required.");
    if (workspaceIds.length === 0)
      throw new TypeError("At least one workspace must be authorized.");
    if (!isNonEmptyString(options.preloadPath) || !isNonEmptyString(options.pageUrl)) {
      throw new TypeError("Remote broker preload and page paths are required.");
    }
    if (!isLocalBrokerPageUrl(options.pageUrl)) {
      throw new TypeError("Remote broker page must use a local app URL.");
    }
    for (const [rootId, rootPath] of options.futureWorkspaceRootPaths ?? []) {
      if (options.windowsFolderRootPaths.get(rootId) !== rootPath) {
        throw new TypeError("Future workspace grants must use a trusted Windows folder root.");
      }
    }
    const broker = new RemoteDesktopBroker({ ...options, workspaceIds });
    try {
      const macRoots = (await options.workspaceFolders.mac?.listRoots()) ?? [];
      const macRootIds = new Set(macRoots.map((root) => root.id));
      if (macRootIds.size !== macRoots.length) {
        throw new TypeError("Mac folder root IDs must be unique.");
      }
      for (const rootId of macRootIds) broker.folderRootIds.mac.add(rootId);
      await broker.window.loadURL(options.pageUrl);
      await broker.waitUntilReady();
      return broker;
    } catch (error) {
      broker.dispose(true);
      throw error;
    }
  }

  subscribe(listener: RemoteDesktopEventListener): () => void {
    if (this.disposed) throw new Error("Remote broker is closed.");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async invoke(method: unknown, args: unknown): Promise<unknown> {
    const invocation = validateRemoteDesktopInvocation(
      method,
      args,
      this.workspaceIds,
      this.folderRootIds,
    );
    switch (invocation.method) {
      case "listWorkspaceFolderRoots": {
        return this.folderAdapter(invocation.args[0]).listRoots();
      }
      case "listWorkspaceFolders": {
        const [device, rootId, relativePath = ""] = invocation.args;
        this.assertFolderRoot(device, rootId);
        return this.folderAdapter(device).list(rootId, relativePath);
      }
      case "addWorkspaceFolder": {
        const [device, rootId, relativePath] = invocation.args;
        return this.openWorkspaceFolder(device, rootId, relativePath);
      }
      case "createWorkspaceFolder": {
        const [device, rootId, parentRelativePath, name] = invocation.args;
        return this.createWorkspaceFolder(device, rootId, parentRelativePath, name);
      }
    }
    if (invocation.method === "getActiveRuns") {
      return answerActiveRuns(this.options.clientId, this.options.getActiveRuns);
    }
    if (invocation.method === "sendText") {
      const view = this.options.windows.viewForWindow(this.window);
      const sessionRef = {
        workspaceId: view.selectedWorkspaceId ?? "",
        sessionId: view.selectedSessionId ?? "",
      };
      if (!this.workspaceIds.has(sessionRef.workspaceId) || !sessionRef.sessionId) {
        throw new Error("Select an authorized thread before sending a message.");
      }
      await this.options.sendText({
        clientId: this.options.clientId,
        sessionRef,
        text: invocation.args[0],
        ...invocation.args[1],
      });
      return { accepted: true };
    }

    if (
      (invocation.method === "getReviewFile" ||
        invocation.method === "setReviewFileReviewed" ||
        invocation.method === "changeReviewFileStage" ||
        invocation.method === "getGitActions" ||
        invocation.method === "getPullRequestFeedback" ||
        invocation.method === "draftGitText" ||
        invocation.method === "runGitAction") &&
      !this.reviewIds.has(invocation.args[0].reviewId)
    ) {
      // Review IDs are host-wide; a device may only reach reviews of its own authorized workspaces.
      throw new Error("This review is not available to this device.");
    }

    await this.waitUntilReady();
    if (this.disposed || this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      throw new Error("Remote broker is closed.");
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new Error("Remote broker is busy; retry the request shortly.");
    }

    const requestId = randomUUID();
    const request: RemoteBrokerRequest = {
      requestId,
      method: invocation.method,
      args: invocation.args,
    };
    assertRemoteJsonSize(request, MAX_BRIDGE_BYTES, "Remote broker request");
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Remote broker request timed out."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { method: invocation.method, resolve, reject, timeout });
      this.window.webContents.send(remoteBrokerIpc.request, request);
    });
  }

  private async openWorkspaceFolder(
    device: WorkspaceFolderDevice,
    rootId: string,
    relativePath: string,
  ): Promise<unknown> {
    this.assertFolderRoot(device, rootId);
    const adapter = this.folderAdapter(device);
    if (device === "mac") {
      const { opened, state } = await this.options.windows.runStateResultAction(
        this.window,
        async () => {
          const result = await adapter.open(rootId, relativePath);
          if (result.device !== "mac") throw new Error("Mac folder adapter result is invalid.");
          return {
            opened: result,
            state: result.state ?? (await this.options.windows.stateForWindow(this.window)),
          };
        },
      );
      if (opened.state && opened.workspaceId) {
        // The host folder service registered this Mac project inside its trusted stand-in root.
        this.workspaceIds.add(opened.workspaceId);
        return { ...opened, state: filterRemoteState(state, this.workspaceIds) };
      }
      if (opened.workspaceId && !this.workspaceIds.has(opened.workspaceId)) {
        throw new Error("This Mac folder is not mapped to an authorized workspace.");
      }
      return opened;
    }
    const result = await this.options.windows.runStateResultAction(this.window, async () => {
      const opened = await adapter.open(rootId, relativePath);
      if (opened.device !== "windows") throw new Error("Windows folder adapter result is invalid.");
      return opened;
    });
    const selected = result.state.workspaces.find(
      (workspace) => workspace.id === result.workspaceId,
    );
    if (!selected || !(await this.windowsWorkspaceFolders.contains(rootId, selected.path, true))) {
      throw new Error("The registered Windows workspace is outside its authorized root.");
    }
    this.workspaceIds.add(selected.id);
    return { ...result, state: filterRemoteState(result.state, this.workspaceIds) };
  }

  private async createWorkspaceFolder(
    device: WorkspaceFolderDevice,
    rootId: string,
    parentRelativePath: string,
    name: string,
  ): Promise<unknown> {
    this.assertFolderRoot(device, rootId);
    const adapter = this.folderAdapter(device);
    if (device === "mac") {
      const result = await adapter.create(rootId, parentRelativePath, name);
      if (result.device !== "mac") throw new Error("Mac folder adapter result is invalid.");
      return result;
    }
    const result = await this.options.windows.runStateResultAction(this.window, async () => {
      const created = await adapter.create(rootId, parentRelativePath, name);
      if (created.device !== "windows")
        throw new Error("Windows folder adapter result is invalid.");
      return created;
    });
    const selected = result.state.workspaces.find(
      (workspace) => workspace.id === result.workspaceId,
    );
    if (!selected || !(await this.windowsWorkspaceFolders.contains(rootId, selected.path, true))) {
      throw new Error("The created Windows workspace is outside its authorized root.");
    }
    this.workspaceIds.add(selected.id);
    return { ...result, state: filterRemoteState(result.state, this.workspaceIds) };
  }

  private folderAdapter(device: WorkspaceFolderDevice) {
    const adapter = this.options.workspaceFolders[device];
    if (!adapter) throw new Error(`The ${device} folder browser is unavailable.`);
    return adapter;
  }

  private assertFolderRoot(device: WorkspaceFolderDevice, rootId: string): void {
    if (!this.folderRootIds[device].has(rootId)) {
      throw new Error(`The ${device} folder root is not authorized.`);
    }
  }

  close(): void {
    this.dispose(true);
  }

  private async waitUntilReady(): Promise<void> {
    if (this.disposed) throw new Error("Remote broker is closed.");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Remote broker renderer did not become ready.")),
            RENDERER_READY_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private isBrokerMainFrame(event: IpcMainEvent): boolean {
    return (
      !this.disposed &&
      isMainFrameSender(event, this.window.webContents) &&
      this.options.windows.isPassiveRemoteSender(event.sender)
    );
  }

  private async receiveResponse(value: unknown): Promise<void> {
    if (!isRemoteBrokerResponse(value)) return;
    const pending = this.pending.get(value.requestId);
    if (!pending) return;
    this.pending.delete(value.requestId);
    clearTimeout(pending.timeout);
    if (!value.ok) {
      pending.reject(new Error(value.error));
      return;
    }
    try {
      // Calls with no result (terminal writes, resizes) come back undefined, which is not JSON.
      const raw = value.value === undefined ? null : value.value;
      const result = isDesktopAppState(raw)
        ? await this.workspaceStateProjector.projectResponse(raw)
        : projectRemoteResult(pending.method, raw, this.workspaceIds);
      assertRemoteJsonSize(result, MAX_BRIDGE_BYTES, "Remote broker result");
      if (pending.method === "getReview") this.rememberReview(result);
      pending.resolve(result);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error("Invalid remote broker result."));
    }
  }

  private rememberReview(result: unknown): void {
    if (typeof result !== "object" || result === null) return;
    const { state, reviewId } = result as { state?: unknown; reviewId?: unknown };
    if (state !== "available" || typeof reviewId !== "string") return;
    this.reviewIds.delete(reviewId);
    this.reviewIds.add(reviewId);
    if (this.reviewIds.size > MAX_KNOWN_REVIEWS) {
      this.reviewIds.delete(this.reviewIds.values().next().value!);
    }
  }

  private receiveEvent(event: RemoteDesktopEvent): void {
    if (event.type === "stateChanged") {
      try {
        void this.workspaceStateProjector
          .enqueueEvent(event.state, (state) => this.publishEvent({ ...event, state }))
          .catch(() => undefined);
      } catch {
        // Invalid revisions and filesystem failures must not break the passive view event loop.
      }
      return;
    }
    if (event.type !== "selectedTranscriptChanged") {
      // The host sends terminal output only to the view that owns the terminal: this device's.
      this.publishEvent(event);
      return;
    }
    const allowed = {
      ...event,
      transcript:
        event.transcript && this.workspaceIds.has(event.transcript.workspaceId)
          ? event.transcript
          : null,
    };
    this.publishEvent(allowed);
  }

  private publishEvent(allowed: RemoteDesktopEvent): void {
    try {
      assertRemoteJsonSize(allowed, MAX_BRIDGE_BYTES, "Remote broker event");
    } catch {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(allowed);
      } catch {
        // An individual SSE subscriber must not break the shared broker event loop.
      }
    }
  }

  private rejectAll(message: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pending.delete(requestId);
    }
  }

  private dispose(destroyWindow: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    ipcMain.removeListener(remoteBrokerIpc.response, this.handleResponse);
    ipcMain.removeListener(remoteBrokerIpc.event, this.handleEvent);
    ipcMain.removeListener(remoteBrokerIpc.ready, this.handleReady);
    this.rejectAll("Remote broker is closed.");
    this.listeners.clear();
    this.options.windows.remove(this.window);
    if (destroyWindow && !this.window.isDestroyed()) this.window.destroy();
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDesktopAppState(value: unknown): value is DesktopAppState {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { workspaces?: unknown }).workspaces) &&
    Number.isSafeInteger((value as { revision?: unknown }).revision) &&
    (value as { revision: number }).revision >= 0
  );
}

function isLocalBrokerPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "file:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

function isSameBrokerUrl(candidate: string, expected: string): boolean {
  try {
    return new URL(candidate).href === new URL(expected).href;
  } catch {
    return false;
  }
}
