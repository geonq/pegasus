import { BrowserWindow, type WebContents } from "electron";
import type { SessionRef } from "@pi-gui/session-driver";
import type {
  AppView,
  DesktopAppState,
  DesktopAppViewState,
  OrchestrationChildThread,
  SelectedTranscriptRecord,
} from "../../contracts/desktop-state";
import { desktopIpc } from "../../contracts/ipc";
import { SerializedActionQueue } from "./action-queue";
import { transcriptChange } from "../remote/remote-state-delta";

// A window shows a child thread by its title, status and the threads it links; its goal, transcript
// and evidence stay in main (orchestration reads them there). Sending them made every state publish
// carry ~0.5 MB for 25 finished subagents, about 14 times a second while a reply streamed.
const stateMetrics = new Map<number, { count: number; startedAt: number }>();
function recordStatePush(webContentsId: number, state: DesktopAppState): void {
  if (process.env.PI_STATE_METRICS !== "1") return;
  const started = performance.now();
  const bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
  const elapsed = performance.now() - started;
  const now = Date.now();
  const metric = stateMetrics.get(webContentsId) ?? { count: 0, startedAt: now };
  metric.count += 1;
  if (now - metric.startedAt >= 1_000) {
    console.info(
      `[state-metrics] window=${webContentsId} bytes=${bytes} stringifyMs=${elapsed.toFixed(3)} pushesPerSec=${((metric.count * 1000) / (now - metric.startedAt)).toFixed(2)}`,
    );
    stateMetrics.set(webContentsId, { count: 0, startedAt: now });
  } else {
    stateMetrics.set(webContentsId, metric);
  }
}

const windowChildren = new WeakMap<
  readonly OrchestrationChildThread[],
  readonly OrchestrationChildThread[]
>();

export function forWindow(state: DesktopAppState): DesktopAppState {
  const children = state.orchestrationChildren;
  let light = windowChildren.get(children);
  if (!light) {
    light = children.map((child) => ({
      ...child,
      // The role its prompt named ("[PI_CHILD_ROLE=reviewer]") is all the Agents panel needs of the goal.
      ...(childRole(child.goal) ? { role: childRole(child.goal) } : {}),
      goal: "",
      latestTranscript: "",
      transcript: [],
      evidence: [],
    }));
    windowChildren.set(children, light);
  }
  return { ...state, orchestrationChildren: light };
}

function childRole(goal: string): string | undefined {
  return /\[(?:PI|HERMES)_CHILD_ROLE=(\w+)\]/i.exec(goal)?.[1]?.toLowerCase();
}

interface WindowViewState {
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  readonly activeView: AppView;
  readonly sidebarCollapsed: boolean;
}

export interface WindowStateOwner {
  snapshot(): DesktopAppState;
  /**
   * The live state without a copy. State is replaced, never mutated, so reading it is safe; a
   * deep copy here ran on every streamed token and froze the main thread (and typing) on big states.
   */
  readState(): Readonly<DesktopAppState>;
  applyView(view: DesktopAppViewState): DesktopAppState;
  projectStateForView(
    view: DesktopAppViewState,
    state: DesktopAppState,
    previousView?: DesktopAppViewState,
  ): DesktopAppState;
  getState(): Promise<DesktopAppState>;
  getStateForView(view: DesktopAppViewState): Promise<DesktopAppState>;
  getSelectedTranscriptForView(view: DesktopAppViewState): Promise<SelectedTranscriptRecord | null>;
  subscribe(listener: (state: DesktopAppState) => void): () => void;
  subscribeToSelectedTranscript(listener: () => void): () => void;
  emit(): void;
  handleWindowActivation(): void;
}

export interface WindowOwnerOptions {
  readonly onActiveWindowChanged?: (window: BrowserWindow | null) => void;
  readonly onWindowClosed?: (window: BrowserWindow) => void;
}

export interface WindowActionOptions {
  readonly forceActiveWindow?: boolean;
}

function viewFromState(state: DesktopAppState): WindowViewState {
  return {
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    activeView: state.activeView,
    sidebarCollapsed: state.sidebarCollapsed,
  };
}

function canPublishToWindow(window: BrowserWindow): boolean {
  return (
    !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed()
  );
}

export class WindowOwner {
  private readonly lastPublishedTranscript = new Map<number, SelectedTranscriptRecord | null>();
  private readonly transcriptSequences = new Map<number, number>();
  private readonly windows = new Set<BrowserWindow>();
  private readonly passiveRemoteViews = new Set<BrowserWindow>();
  /** webContents ids of passive remote views whose state publishing is paused. */
  private readonly pausedPassiveViews = new Set<number>();
  private readonly windowIds = new WeakMap<BrowserWindow, number>();
  private readonly views = new Map<number, WindowViewState>();
  private readonly stopPublishingState = new Map<number, () => void>();
  private readonly stopPublishingTranscript = new Map<number, () => void>();
  private readonly stopTrackingActivation = new Map<number, () => void>();
  private readonly actionQueue = new SerializedActionQueue();
  private activeWindow: BrowserWindow | null = null;
  private activeActionWebContentsId: number | undefined;
  private deferredActivationWebContentsId: number | undefined;
  private composerDraftPersistOriginWebContentsId: number | undefined;

  constructor(
    private readonly stateOwner: WindowStateOwner,
    private readonly options: WindowOwnerOptions = {},
  ) {}

  add(window: BrowserWindow, sourceView?: DesktopAppViewState): void {
    this.registerWindow(window, sourceView, false);
  }

  addPassiveRemoteView(window: BrowserWindow, sourceView?: DesktopAppViewState): void {
    this.registerWindow(window, sourceView, true);
  }

  private registerWindow(
    window: BrowserWindow,
    sourceView: DesktopAppViewState | undefined,
    passiveRemoteView: boolean,
  ): void {
    const webContentsId = window.webContents.id;
    this.windows.add(window);
    if (passiveRemoteView) {
      this.passiveRemoteViews.add(window);
    }
    this.windowIds.set(window, webContentsId);
    this.views.set(webContentsId, this.resolveView(sourceView));
    if (!passiveRemoteView) {
      this.setActiveWindow(window);
    }
    this.attachStatePublisher(window);
    if (!passiveRemoteView) {
      this.attachActivationTracking(window);
    }
  }

  remove(window: BrowserWindow): void {
    const webContentsId = this.windowIds.get(window);
    if (webContentsId === undefined) {
      return;
    }
    this.stopPublishingState.get(webContentsId)?.();
    this.stopPublishingState.delete(webContentsId);
    this.stopPublishingTranscript.get(webContentsId)?.();
    this.stopPublishingTranscript.delete(webContentsId);
    this.stopTrackingActivation.get(webContentsId)?.();
    this.stopTrackingActivation.delete(webContentsId);
    this.windows.delete(window);
    this.passiveRemoteViews.delete(window);
    this.pausedPassiveViews.delete(webContentsId);
    this.windowIds.delete(window);
    this.views.delete(webContentsId);
    this.lastPublishedTranscript.delete(webContentsId);

    if (this.activeWindow === window) {
      this.activeWindow =
        [...this.windows].find(
          (candidate) =>
            !this.passiveRemoteViews.has(candidate) &&
            !candidate.isDestroyed() &&
            !candidate.webContents.isDestroyed(),
        ) ?? null;
      if (this.activeWindow) {
        this.setActiveWindow(this.activeWindow);
        this.applyViewToStateOwner(this.activeWindow.webContents.id);
      } else {
        this.options.onActiveWindowChanged?.(null);
      }
    }
    this.options.onWindowClosed?.(window);
  }

  allWindows(): readonly BrowserWindow[] {
    return [...this.windows].filter((window) => !this.passiveRemoteViews.has(window));
  }

  size(): number {
    return this.windows.size - this.passiveRemoteViews.size;
  }

  active(): BrowserWindow | null {
    return this.activeWindow &&
      !this.passiveRemoteViews.has(this.activeWindow) &&
      canPublishToWindow(this.activeWindow)
      ? this.activeWindow
      : null;
  }

  foreground(): BrowserWindow | null {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (
      focusedWindow &&
      !this.passiveRemoteViews.has(focusedWindow) &&
      this.views.has(focusedWindow.webContents.id) &&
      canPublishToWindow(focusedWindow)
    ) {
      return focusedWindow;
    }
    if (
      this.activeWindow &&
      !this.passiveRemoteViews.has(this.activeWindow) &&
      canPublishToWindow(this.activeWindow)
    ) {
      return this.activeWindow;
    }
    return (
      [...this.windows].find(
        (window) => !this.passiveRemoteViews.has(window) && canPublishToWindow(window),
      ) ?? null
    );
  }

  foregroundView(): DesktopAppViewState | undefined {
    const window = this.foreground();
    return window ? this.viewForWindow(window) : undefined;
  }

  resolveDialogWindow(parentWindow?: BrowserWindow | null): BrowserWindow | undefined {
    if (
      parentWindow &&
      !this.passiveRemoteViews.has(parentWindow) &&
      canPublishToWindow(parentWindow)
    ) {
      return parentWindow;
    }
    return this.active() ?? undefined;
  }

  isPassiveRemoteView(window: BrowserWindow): boolean {
    return this.windows.has(window) && this.passiveRemoteViews.has(window);
  }

  isPassiveRemoteSender(sender: WebContents): boolean {
    const window = BrowserWindow.fromWebContents(sender);
    return Boolean(window && this.isPassiveRemoteView(window) && canPublishToWindow(window));
  }

  windowForSender(sender: WebContents): BrowserWindow {
    const window = BrowserWindow.fromWebContents(sender);
    if (!window || !this.windows.has(window) || !canPublishToWindow(window)) {
      throw new Error("IPC sender is not a registered pi-gui window");
    }
    return window;
  }

  viewForSender(sender: WebContents): DesktopAppViewState {
    const window = this.windowForSender(sender);
    return this.viewForWindow(window);
  }

  viewForWindow(window: BrowserWindow): DesktopAppViewState {
    return this.views.get(window.webContents.id) ?? viewFromState(this.stateOwner.readState());
  }

  targetForSender(sender: WebContents): SessionRef | undefined {
    const view = this.viewForSender(sender);
    return view.selectedWorkspaceId && view.selectedSessionId
      ? { workspaceId: view.selectedWorkspaceId, sessionId: view.selectedSessionId }
      : undefined;
  }

  async stateForWindow(window?: BrowserWindow | null): Promise<DesktopAppState> {
    if (window && canPublishToWindow(window)) {
      return forWindow(await this.stateOwner.getStateForView(this.viewForWindow(window)));
    }
    return forWindow(await this.stateOwner.getState());
  }

  isSessionVisibleInAnotherWindow(sessionRef: SessionRef): boolean {
    for (const window of this.windows) {
      if (
        this.passiveRemoteViews.has(window) ||
        !canPublishToWindow(window) ||
        window.isMinimized() ||
        !window.isVisible()
      ) {
        continue;
      }
      const webContentsId = window.webContents.id;
      if (webContentsId === this.activeActionWebContentsId) {
        continue;
      }
      const view = this.views.get(webContentsId);
      if (
        view?.activeView === "threads" &&
        view.selectedWorkspaceId === sessionRef.workspaceId &&
        view.selectedSessionId === sessionRef.sessionId
      ) {
        return true;
      }
    }
    return false;
  }

  activate(window: BrowserWindow): void {
    if (!this.windows.has(window) || this.passiveRemoteViews.has(window) || window.isDestroyed()) {
      return;
    }
    if (this.activeActionWebContentsId !== undefined) {
      this.deferredActivationWebContentsId = window.webContents.id;
      return;
    }
    this.applyActivation(window);
  }

  async runStateAction(
    window: BrowserWindow | null | undefined,
    action: () => Promise<DesktopAppState>,
    options: WindowActionOptions = {},
  ): Promise<DesktopAppState> {
    return this.enqueueAction(async () => {
      const context = this.beginAction(window, options);
      try {
        const state = await action();
        if (!context.window || context.webContentsId === undefined) {
          return state;
        }
        return this.finishStateAction(context.window, state);
      } finally {
        this.endAction(context.webContentsId, context.previousActionWebContentsId);
      }
    });
  }

  async runStateResultAction<T extends { readonly state: DesktopAppState }>(
    window: BrowserWindow | null | undefined,
    action: () => Promise<T>,
    options: WindowActionOptions = {},
  ): Promise<T> {
    return this.enqueueAction(async () => {
      const context = this.beginAction(window, options);
      try {
        const result = await action();
        if (!context.window || context.webContentsId === undefined) {
          return result;
        }
        const state = this.finishStateAction(context.window, result.state);
        return { ...result, state };
      } finally {
        this.endAction(context.webContentsId, context.previousActionWebContentsId);
      }
    });
  }

  async runUnscopedStateAction(
    window: BrowserWindow | null | undefined,
    action: () => Promise<DesktopAppState>,
  ): Promise<DesktopAppState> {
    const state = await action();
    if (!window || !canPublishToWindow(window)) {
      return state;
    }
    return this.projectAndRemember(window.webContents.id, state);
  }

  async runImmediateStateAction(
    window: BrowserWindow | null | undefined,
    action: () => Promise<DesktopAppState>,
  ): Promise<DesktopAppState> {
    const state = await action();
    if (!window || !canPublishToWindow(window)) {
      return state;
    }
    const projected = this.projectAndRemember(window.webContents.id, state);
    recordStatePush(window.webContents.id, projected);
    window.webContents.send(desktopIpc.stateChanged, projected);
    this.publishTranscriptSoon(window);
    return projected;
  }

  async withComposerDraftPersistOrigin<T>(
    sender: WebContents,
    action: () => Promise<T>,
  ): Promise<T> {
    const previousOrigin = this.composerDraftPersistOriginWebContentsId;
    this.composerDraftPersistOriginWebContentsId = this.windowForSender(sender).webContents.id;
    try {
      return await action();
    } finally {
      this.composerDraftPersistOriginWebContentsId = previousOrigin;
    }
  }

  private resolveView(sourceView?: DesktopAppViewState): WindowViewState {
    const state = this.stateOwner.readState();
    return viewFromState(
      this.stateOwner.projectStateForView({ ...viewFromState(state), ...sourceView }, state),
    );
  }

  private projectState(
    webContentsId: number,
    state: DesktopAppState = this.stateOwner.readState(),
    view: WindowViewState = this.views.get(webContentsId) ?? viewFromState(state),
    previousView: WindowViewState | undefined = this.views.get(webContentsId),
  ): DesktopAppState {
    const projected = forWindow(this.stateOwner.projectStateForView(view, state, previousView));
    if (
      projected.composerDraftSyncSource === "persist" &&
      this.composerDraftPersistOriginWebContentsId !== undefined &&
      webContentsId !== this.composerDraftPersistOriginWebContentsId
    ) {
      return { ...projected, composerDraftSyncSource: "remote-persist" };
    }
    return projected;
  }

  private projectAndRemember(webContentsId: number, state: DesktopAppState): DesktopAppState {
    const projected = this.projectState(webContentsId, state);
    this.views.set(webContentsId, viewFromState(projected));
    return projected;
  }

  private publishState(
    window: BrowserWindow,
    state: DesktopAppState = this.stateOwner.readState(),
  ): void {
    if (!canPublishToWindow(window)) {
      return;
    }
    const webContentsId = window.webContents.id;
    const view =
      webContentsId === this.activeActionWebContentsId
        ? viewFromState(state)
        : (this.views.get(webContentsId) ?? viewFromState(state));
    const projected = this.projectState(webContentsId, state, view);
    this.views.set(webContentsId, viewFromState(projected));
    recordStatePush(window.webContents.id, projected);
    window.webContents.send(desktopIpc.stateChanged, projected);
  }

  private async publishTranscript(window: BrowserWindow): Promise<void> {
    if (!canPublishToWindow(window)) {
      return;
    }
    const webContentsId = window.webContents.id;
    const payload = await this.stateOwner.getSelectedTranscriptForView(this.viewForWindow(window));
    if (!canPublishToWindow(window)) {
      return;
    }
    const projected = this.projectState(webContentsId);
    if (payload) {
      if (
        projected.selectedWorkspaceId !== payload.workspaceId ||
        projected.selectedSessionId !== payload.sessionId
      ) {
        return;
      }
    } else if (projected.selectedSessionId) {
      return;
    }
    // Transcript arrays are replaced on writes, so identity detects changes
    // without serializing unchanged transcripts for unrelated session events.
    const previous = this.lastPublishedTranscript.get(webContentsId);
    if (payload) {
      if (
        previous &&
        previous.workspaceId === payload.workspaceId &&
        previous.sessionId === payload.sessionId &&
        previous.transcript === payload.transcript &&
        previous.schemaInfo === payload.schemaInfo
      ) {
        return;
      }
    } else if (previous === null) {
      return;
    }
    this.lastPublishedTranscript.set(webContentsId, payload);
    // A streamed token changes one row: send that row, not the whole transcript. Anything a delta
    // cannot carry (another session, schema info, a reordered row) goes out as the full record.
    const sequence = (this.transcriptSequences.get(webContentsId) ?? 0) + 1;
    const change =
      previous && payload && previous.schemaInfo === payload.schemaInfo
        ? transcriptChange(previous, payload, sequence)
        : "full";
    if (change === "none") return;
    if (change === "full") {
      // A full record restarts the window's delta sequence.
      this.transcriptSequences.set(webContentsId, 0);
      window.webContents.send(desktopIpc.selectedTranscriptChanged, payload);
      return;
    }
    this.transcriptSequences.set(webContentsId, sequence);
    window.webContents.send(desktopIpc.sessionTranscriptDelta, change);
  }

  private publishTranscriptSoon(window: BrowserWindow): void {
    void this.publishTranscript(window).catch((error: unknown) => {
      console.error("[window-owner] failed to publish selected transcript", error);
    });
  }

  private setActiveWindow(window: BrowserWindow): void {
    if (window.isDestroyed() || this.passiveRemoteViews.has(window)) {
      return;
    }
    this.activeWindow = window;
    this.options.onActiveWindowChanged?.(window);
  }

  private applyViewToStateOwner(webContentsId: number): void {
    const view = this.views.get(webContentsId) ?? viewFromState(this.stateOwner.readState());
    this.stateOwner.applyView(view);
  }

  private applyActivation(window: BrowserWindow): void {
    this.setActiveWindow(window);
    this.applyViewToStateOwner(window.webContents.id);
    this.stateOwner.handleWindowActivation();
    this.views.set(window.webContents.id, viewFromState(this.stateOwner.readState()));
  }

  private applyDeferredActivation(): boolean {
    const webContentsId = this.deferredActivationWebContentsId;
    this.deferredActivationWebContentsId = undefined;
    if (webContentsId === undefined) {
      return false;
    }
    const window = [...this.windows].find(
      (candidate) => !candidate.isDestroyed() && candidate.webContents.id === webContentsId,
    );
    if (!window || !canPublishToWindow(window)) {
      return false;
    }
    this.applyActivation(window);
    return true;
  }

  private restoreForegroundUnlessSender(senderWebContentsId: number | undefined): void {
    const foregroundWindow = this.foreground();
    if (!foregroundWindow || foregroundWindow.webContents.id === senderWebContentsId) {
      return;
    }
    this.applyViewToStateOwner(foregroundWindow.webContents.id);
    this.stateOwner.emit();
  }

  private enqueueAction<T>(action: () => Promise<T>): Promise<T> {
    return this.actionQueue.run(action);
  }

  private beginAction(window: BrowserWindow | null | undefined, options: WindowActionOptions) {
    const liveWindow = window && !window.isDestroyed() ? window : undefined;
    const webContentsId = liveWindow?.webContents.id;
    const foregroundWindow = this.foreground();
    const senderIsForeground = Boolean(
      liveWindow && foregroundWindow?.webContents.id === liveWindow.webContents.id,
    );
    const windowIsFocused =
      Boolean(liveWindow?.isFocused()) || senderIsForeground || options.forceActiveWindow === true;
    if (liveWindow && webContentsId !== undefined) {
      if (windowIsFocused && !this.passiveRemoteViews.has(liveWindow)) {
        this.setActiveWindow(liveWindow);
      }
      this.applyViewToStateOwner(webContentsId);
    }
    const previousActionWebContentsId = this.activeActionWebContentsId;
    this.activeActionWebContentsId = webContentsId;
    return { window: liveWindow, webContentsId, previousActionWebContentsId };
  }

  private finishStateAction(window: BrowserWindow, state: DesktopAppState): DesktopAppState {
    const webContentsId = window.webContents.id;
    const previousView = this.views.get(webContentsId);
    const projected = this.projectState(webContentsId, state, viewFromState(state), previousView);
    this.views.set(webContentsId, viewFromState(projected));
    this.publishState(window, projected);
    this.publishTranscriptSoon(window);
    return projected;
  }

  private endAction(
    senderWebContentsId: number | undefined,
    previousActionWebContentsId: number | undefined,
  ): void {
    this.activeActionWebContentsId = previousActionWebContentsId;
    if (!this.applyDeferredActivation()) {
      this.restoreForegroundUnlessSender(senderWebContentsId);
    }
  }

  private startPublishingTo(window: BrowserWindow): void {
    const webContentsId = window.webContents.id;
    this.lastPublishedTranscript.delete(webContentsId);
    this.transcriptSequences.delete(webContentsId);
    this.stopPublishingState.get(webContentsId)?.();
    this.stopPublishingTranscript.get(webContentsId)?.();
    this.stopPublishingState.set(
      webContentsId,
      this.stateOwner.subscribe((state) => {
        this.publishState(window, state);
        this.publishTranscriptSoon(window);
      }),
    );
    this.stopPublishingTranscript.set(
      webContentsId,
      this.stateOwner.subscribeToSelectedTranscript(() => this.publishTranscriptSoon(window)),
    );
  }

  private stopPublishingTo(webContentsId: number): void {
    this.stopPublishingState.get(webContentsId)?.();
    this.stopPublishingState.delete(webContentsId);
    this.stopPublishingTranscript.get(webContentsId)?.();
    this.stopPublishingTranscript.delete(webContentsId);
  }

  /**
   * A passive remote view (a hidden broker page) needs state only while a remote device listens.
   * Each published state is serialized once per window, so idle broker pages tripled the work of
   * every state change. Resuming publishes the current state and transcript right away.
   */
  setPassiveViewPublishing(window: BrowserWindow, publishing: boolean): void {
    if (!this.passiveRemoteViews.has(window) || !canPublishToWindow(window)) return;
    const webContentsId = window.webContents.id;
    if (!publishing) {
      this.pausedPassiveViews.add(webContentsId);
      this.stopPublishingTo(webContentsId);
      return;
    }
    if (!this.pausedPassiveViews.delete(webContentsId)) return;
    this.startPublishingTo(window);
    this.publishState(window);
    this.publishTranscriptSoon(window);
  }

  private attachStatePublisher(window: BrowserWindow): void {
    const webContentsId = window.webContents.id;
    this.startPublishingTo(window);
    let recovering = false;
    window.webContents.on("render-process-gone", () => {
      recovering = true;
      this.stopPublishingTo(webContentsId);
    });
    window.webContents.on("did-finish-load", () => {
      if (!recovering) {
        return;
      }
      recovering = false;
      if (this.pausedPassiveViews.has(webContentsId)) return;
      this.startPublishingTo(window);
      this.publishState(window);
      this.publishTranscriptSoon(window);
    });
  }

  private attachActivationTracking(window: BrowserWindow): void {
    const webContentsId = window.webContents.id;
    this.stopTrackingActivation.get(webContentsId)?.();
    const handleActivation = () => this.activate(window);
    const notifyFocused = () => {
      if (!window.isDestroyed()) window.webContents.send(desktopIpc.windowFocused);
    };
    const stop = () => {
      window.off("focus", notifyFocused);
      window.off("focus", handleActivation);
      window.off("show", handleActivation);
      window.off("restore", handleActivation);
    };
    window.on("focus", handleActivation);
    window.on("focus", notifyFocused);
    window.on("show", handleActivation);
    window.on("restore", handleActivation);
    this.stopTrackingActivation.set(webContentsId, stop);
  }
}
