import type { DesktopAppState, SelectedTranscriptRecord } from "../../contracts/desktop-state";
import type { TerminalDataEvent, TerminalErrorEvent, TerminalExitEvent } from "../../contracts/ipc";

/** Methods with safe, view-scoped public IPC handlers. Provider-secret methods stay excluded. */
export const REMOTE_DESKTOP_PI_METHODS = [
  "getState",
  "getAppVersion",
  "getSelectedTranscript",
  "getSignIns",
  "getAccountStates",
  "getAccountLimits",
  "getClaudeSlots",
  "getUsageReport",
  "loadWorkspaceRuntime",
  "setActiveView",
  "selectWorkspace",
  "selectSession",
  "createSession",
  "startThread",
  "archiveSession",
  "unarchiveSession",
  "listWorkspaceFolderRoots",
  "listWorkspaceFolders",
  "addWorkspaceFolder",
  "createWorkspaceFolder",
  "cancelCurrentRun",
  "setSessionModel",
  "setDefaultModel",
  "setSessionThinkingLevel",
  "setSessionPermission",
  "respondToHostUiRequest",
  "answerGenerativeUi",
  "setDefaultThinkingLevel",
  "setThreadGrouping",
  "listWorkspaceFiles",
  "readWorkspaceFile",
  "removeQueuedComposerMessage",
  "steerQueuedComposerMessage",
  // Review reads and stages the host checkout; reviewId calls are scoped by the broker.
  "getTurnChanges",
  "getReview",
  "getReviewFile",
  "setReviewFileReviewed",
  "changeReviewFileStage",
  // Terminals run on the host, owned by this device's hidden view, so one device only reaches its own.
  "ensureTerminalPanel",
  "createTerminalSession",
  "setActiveTerminalSession",
  "writeTerminal",
  "resizeTerminal",
  "restartTerminalSession",
  "closeTerminalSession",
  "setTerminalTitle",
] as const;

export type RemoteDesktopPiMethod = (typeof REMOTE_DESKTOP_PI_METHODS)[number];

export const REMOTE_DESKTOP_EVENTS = [
  "stateChanged",
  "selectedTranscriptChanged",
  "terminalData",
  "terminalExit",
  "terminalError",
] as const;
export type RemoteDesktopEventName = (typeof REMOTE_DESKTOP_EVENTS)[number];

export type RemoteDesktopEvent =
  | { readonly type: "stateChanged"; readonly state: DesktopAppState }
  | {
      readonly type: "selectedTranscriptChanged";
      readonly transcript: SelectedTranscriptRecord | null;
    }
  | { readonly type: "terminalData"; readonly event: TerminalDataEvent }
  | { readonly type: "terminalExit"; readonly event: TerminalExitEvent }
  | { readonly type: "terminalError"; readonly event: TerminalErrorEvent };

export interface RemoteBrokerRequest {
  readonly requestId: string;
  readonly method: RemoteDesktopPiMethod;
  readonly args: readonly unknown[];
}

export type RemoteBrokerResponse =
  | { readonly requestId: string; readonly ok: true; readonly value: unknown }
  | { readonly requestId: string; readonly ok: false; readonly error: string };

export interface RemoteBrokerRendererBridge {
  onRequest(listener: (request: RemoteBrokerRequest) => void): () => void;
  respond(response: RemoteBrokerResponse): void;
  publish(event: RemoteDesktopEvent): void;
  ready(): void;
}

export const remoteBrokerIpc = {
  request: "pi-gui:remote-broker:request",
  response: "pi-gui:remote-broker:response",
  event: "pi-gui:remote-broker:event",
  ready: "pi-gui:remote-broker:ready",
} as const;

export const remoteClientIpc = {
  invoke: "pi-gui:remote-client:invoke",
  stateChanged: "pi-gui:remote-client:state-changed",
  selectedTranscriptChanged: "pi-gui:remote-client:selected-transcript-changed",
  terminalEvent: "pi-gui:remote-client:terminal-event",
  getLocalPreferences: "pi-gui:remote-client:get-local-preferences",
  setLocalPreferences: "pi-gui:remote-client:set-local-preferences",
} as const;

/** Methods the main process answers itself; they never reach the hidden view's PiDesktopApi. */
export const REMOTE_DESKTOP_HOST_METHODS = ["sendText", "getActiveRuns"] as const;

export const REMOTE_DESKTOP_METHODS = [
  ...REMOTE_DESKTOP_PI_METHODS,
  ...REMOTE_DESKTOP_HOST_METHODS,
] as const;
export type RemoteDesktopMethod = (typeof REMOTE_DESKTOP_METHODS)[number];

const REMOTE_DESKTOP_PI_METHOD_SET = new Set<string>(REMOTE_DESKTOP_PI_METHODS);

export function isRemoteDesktopPiMethod(value: unknown): value is RemoteDesktopPiMethod {
  return typeof value === "string" && REMOTE_DESKTOP_PI_METHOD_SET.has(value);
}

const REMOTE_DESKTOP_METHOD_SET = new Set<string>(REMOTE_DESKTOP_METHODS);

export function isRemoteDesktopMethod(value: unknown): value is RemoteDesktopMethod {
  return typeof value === "string" && REMOTE_DESKTOP_METHOD_SET.has(value);
}

export function isRemoteDesktopEvent(value: unknown): value is RemoteDesktopEvent {
  if (!isRecord(value)) return false;
  if (value.type === "stateChanged") {
    return (
      isRecord(value.state) &&
      Array.isArray(value.state.workspaces) &&
      typeof value.state.revision === "number" &&
      Number.isSafeInteger(value.state.revision) &&
      value.state.revision >= 0
    );
  }
  if (value.type === "selectedTranscriptChanged") {
    return value.transcript === null || isSelectedTranscriptRecord(value.transcript);
  }
  if (
    value.type === "terminalData" ||
    value.type === "terminalExit" ||
    value.type === "terminalError"
  ) {
    return isTerminalEvent(value.type, value.event);
  }
  return false;
}

export function isRemoteBrokerResponse(value: unknown): value is RemoteBrokerResponse {
  return (
    isRecord(value) &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    value.requestId.length <= 80 &&
    (value.ok === true ||
      (value.ok === false && typeof value.error === "string" && value.error.length <= 1_024))
  );
}

export function isRemoteBrokerReady(value: unknown): value is { readonly ready: true } {
  return isRecord(value) && value.ready === true;
}

function isTerminalEvent(type: string, event: unknown): boolean {
  if (!isRecord(event) || typeof event.terminalId !== "string" || event.terminalId.length === 0) {
    return false;
  }
  if (type === "terminalData") return typeof event.data === "string";
  if (type === "terminalError") return typeof event.message === "string";
  return (
    (event.exitCode === undefined || typeof event.exitCode === "number") &&
    (event.signal === undefined || typeof event.signal === "number")
  );
}

function isSelectedTranscriptRecord(value: unknown): value is SelectedTranscriptRecord {
  return (
    isRecord(value) &&
    typeof value.workspaceId === "string" &&
    typeof value.sessionId === "string" &&
    Array.isArray(value.transcript)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
