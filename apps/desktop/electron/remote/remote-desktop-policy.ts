import type {
  AppView,
  ComposerImageAttachment,
  DesktopAppState,
  SelectedTranscriptRecord,
  StartThreadInput,
} from "../../contracts/desktop-state";
import type { WorkspaceFolderDevice } from "../../contracts/workspace-folders";
import { isSessionPermission, type SessionPermission } from "../../contracts/session-permission";
import { sessionKey, type HostUiResponse } from "@pi-gui/session-driver";
import {
  expectComposerAttachments,
  expectExtensionFlags,
  expectHostUiResponse,
} from "../ipc/request-validation";
import { SUPPORTED_COMPOSER_IMAGE_TYPES } from "../../contracts/composer-attachments";
import type { RemoteDesktopMethod, RemoteDesktopPiMethod } from "./remote-desktop-protocol";
import { isRemoteDesktopPiMethod } from "./remote-desktop-protocol";

const MAX_TEXT_BYTES = 128 * 1024;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_REMOTE_ATTACHMENTS = 16;
const IMAGE_MIME_TYPES = new Set<string>(SUPPORTED_COMPOSER_IMAGE_TYPES.map((type) => type.mimeType));

export interface RemoteSendTextOptions {
  readonly deliverAs?: "steer";
  readonly attachments?: readonly ComposerImageAttachment[];
}

export type RemoteDesktopInvocation =
  | {
      readonly method: "sendText";
      readonly args: readonly [string] | readonly [string, RemoteSendTextOptions];
    }
  | {
      readonly method: "removeQueuedComposerMessage" | "steerQueuedComposerMessage";
      readonly args: readonly [string];
    }
  | {
      readonly method: "getState" | "getAppVersion" | "getSelectedTranscript" | "cancelCurrentRun";
      readonly args: readonly [];
    }
  | {
      readonly method: "getSignIns" | "getAccountStates" | "getUsageReport";
      readonly args: readonly [];
    }
  | {
      readonly method: "getAccountLimits";
      readonly args: readonly [] | readonly [{ readonly cachedOnly?: boolean }];
    }
  | {
      readonly method: "loadWorkspaceRuntime";
      readonly args: readonly [string] | readonly [string, { readonly refresh?: boolean }];
    }
  | { readonly method: "setActiveView"; readonly args: readonly [AppView] }
  | { readonly method: "setThreadGrouping"; readonly args: readonly ["time" | "workspace"] }
  | { readonly method: "selectWorkspace"; readonly args: readonly [string] }
  | {
      readonly method: "selectSession";
      readonly args: readonly [{ readonly workspaceId: string; readonly sessionId: string }];
    }
  | {
      readonly method: "archiveSession" | "unarchiveSession";
      readonly args: readonly [{ readonly workspaceId: string; readonly sessionId: string }];
    }
  | {
      readonly method: "listWorkspaceFolderRoots";
      readonly args: readonly [WorkspaceFolderDevice];
    }
  | {
      readonly method: "listWorkspaceFolders";
      readonly args:
        readonly [WorkspaceFolderDevice, string] | readonly [WorkspaceFolderDevice, string, string];
    }
  | {
      readonly method: "addWorkspaceFolder";
      readonly args: readonly [WorkspaceFolderDevice, string, string];
    }
  | {
      readonly method: "createWorkspaceFolder";
      readonly args: readonly [WorkspaceFolderDevice, string, string, string];
    }
  | {
      readonly method: "createSession";
      readonly args: readonly [{ readonly workspaceId: string; readonly title?: string }];
    }
  | { readonly method: "startThread"; readonly args: readonly [StartThreadInput] }
  | {
      readonly method: "setSessionModel";
      readonly args: readonly [string, string, string, string];
    }
  | { readonly method: "setDefaultModel"; readonly args: readonly [string, string, string] }
  | {
      readonly method: "setSessionThinkingLevel";
      readonly args: readonly [string, string, string];
    }
  | {
      readonly method: "setSessionPermission";
      readonly args: readonly [string, string, SessionPermission];
    }
  | {
      readonly method: "respondToHostUiRequest";
      readonly args: readonly [string, string, HostUiResponse];
    }
  | {
      readonly method: "setDefaultThinkingLevel";
      readonly args: readonly [string] | readonly [string, string];
    }
  | {
      readonly method: "listWorkspaceFiles";
      readonly args: readonly [string] | readonly [string, { readonly force?: boolean }];
    }
  | { readonly method: "readWorkspaceFile"; readonly args: readonly [string, string] };

/** Validate and normalize the external method envelope before it reaches preload IPC. */
export function validateRemoteDesktopInvocation(
  method: unknown,
  rawArgs: unknown,
  workspaceIds: ReadonlySet<string>,
  folderRootIds: Readonly<{
    readonly windows: ReadonlySet<string>;
    readonly mac: ReadonlySet<string>;
  }> = { windows: workspaceIds, mac: new Set() },
): RemoteDesktopInvocation {
  if (typeof method !== "string" || (!isRemoteDesktopPiMethod(method) && method !== "sendText")) {
    throw new TypeError("Remote method is not allowed.");
  }
  if (!Array.isArray(rawArgs) || rawArgs.length > 5) {
    throw new TypeError("Remote method arguments are invalid.");
  }
  const args = rawArgs as readonly unknown[];
  const allowedMethod = method as RemoteDesktopMethod;
  switch (allowedMethod) {
    case "getState":
    case "getAppVersion":
    case "getSelectedTranscript":
    case "cancelCurrentRun": {
      expectArgs(args, 0);
      return { method: allowedMethod, args: [] };
    }
    case "getSignIns":
    case "getAccountStates":
    case "getUsageReport": {
      expectArgs(args, 0);
      return { method: allowedMethod, args: [] };
    }
    case "getAccountLimits": {
      if (args.length === 0) return { method: allowedMethod, args: [] };
      expectArgs(args, 1);
      const options = expectRecord(args[0], ["cachedOnly"]);
      if (options.cachedOnly !== undefined && typeof options.cachedOnly !== "boolean") {
        throw new TypeError("cachedOnly must be a boolean.");
      }
      return {
        method: allowedMethod,
        args: options.cachedOnly === undefined ? [] : [{ cachedOnly: options.cachedOnly }],
      };
    }
    case "listWorkspaceFolderRoots": {
      expectArgs(args, 1);
      return { method: allowedMethod, args: [expectFolderDevice(args[0])] };
    }
    case "sendText": {
      if (args.length !== 1 && args.length !== 2) {
        throw new TypeError("sendText expects the text and an optional delivery.");
      }
      if (typeof args[0] !== "string" || Buffer.byteLength(args[0], "utf8") > MAX_TEXT_BYTES) {
        throw new TypeError(`text must be a string of at most ${MAX_TEXT_BYTES} bytes.`);
      }
      const text = args[0];
      const options = args.length === 1 ? {} : expectRecord(args[1], ["deliverAs", "attachments"]);
      // Steering reaches a running chat's next turn; anything else stays a follow-up.
      if (options.deliverAs !== undefined && options.deliverAs !== "steer") {
        throw new TypeError("Delivery must be steer.");
      }
      const attachments =
        options.attachments === undefined ? [] : expectRemoteImages(options.attachments);
      if (!text.trim() && attachments.length === 0) {
        throw new TypeError("Message text cannot be empty.");
      }
      const safeOptions: RemoteSendTextOptions = {
        ...(options.deliverAs === "steer" ? { deliverAs: "steer" as const } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      return {
        method: allowedMethod,
        args: Object.keys(safeOptions).length === 0 ? [text] : [text, safeOptions],
      };
    }
    case "removeQueuedComposerMessage":
    case "steerQueuedComposerMessage": {
      expectArgs(args, 1);
      // The host applies it to the chat open in this client's own view, as it does for sendText.
      return { method: allowedMethod, args: [expectString(args[0], "messageId", 256)] };
    }
    case "loadWorkspaceRuntime": {
      if (args.length !== 1 && args.length !== 2) {
        throw new TypeError("loadWorkspaceRuntime expects one or two arguments.");
      }
      const workspaceId = expectAuthorizedWorkspace(args[0], workspaceIds);
      if (args.length === 1) return { method: allowedMethod, args: [workspaceId] };
      const options = expectRecord(args[1], ["refresh"]);
      if (options.refresh !== undefined && typeof options.refresh !== "boolean") {
        throw new TypeError("refresh must be a boolean.");
      }
      return options.refresh === undefined
        ? { method: allowedMethod, args: [workspaceId] }
        : { method: allowedMethod, args: [workspaceId, { refresh: options.refresh }] };
    }
    case "setActiveView": {
      expectArgs(args, 1);
      return { method: allowedMethod, args: [expectAppView(args[0])] };
    }
    case "setThreadGrouping": {
      expectArgs(args, 1);
      if (args[0] !== "time" && args[0] !== "workspace") {
        throw new TypeError("Thread grouping is invalid.");
      }
      return { method: allowedMethod, args: [args[0]] };
    }
    case "selectWorkspace": {
      expectArgs(args, 1);
      return { method: allowedMethod, args: [expectAuthorizedWorkspace(args[0], workspaceIds)] };
    }
    case "selectSession": {
      expectArgs(args, 1);
      const target = expectRecord(args[0], ["workspaceId", "sessionId"]);
      return {
        method: allowedMethod,
        args: [
          {
            workspaceId: expectAuthorizedWorkspace(target.workspaceId, workspaceIds),
            sessionId: expectString(target.sessionId, "sessionId", 256),
          },
        ],
      };
    }
    case "archiveSession":
    case "unarchiveSession": {
      expectArgs(args, 1);
      return {
        method: allowedMethod,
        args: [expectAuthorizedWorkspaceSessionTarget(args[0], workspaceIds)],
      };
    }
    case "listWorkspaceFolders": {
      if (args.length !== 2 && args.length !== 3) {
        throw new TypeError("listWorkspaceFolders expects two or three arguments.");
      }
      const device = expectFolderDevice(args[0]);
      const rootId = expectAuthorizedWorkspace(args[1], folderRootIds[device]);
      const relativePath =
        args[2] === undefined ? undefined : expectRelativePath(args[2], "relativePath");
      return {
        method: allowedMethod,
        args: relativePath === undefined ? [device, rootId] : [device, rootId, relativePath],
      };
    }
    case "addWorkspaceFolder": {
      expectArgs(args, 3);
      const device = expectFolderDevice(args[0]);
      return {
        method: allowedMethod,
        args: [
          device,
          expectAuthorizedWorkspace(args[1], folderRootIds[device]),
          expectRelativePath(args[2], "relativePath"),
        ],
      };
    }
    case "createWorkspaceFolder": {
      expectArgs(args, 4);
      const device = expectFolderDevice(args[0]);
      return {
        method: allowedMethod,
        args: [
          device,
          expectAuthorizedWorkspace(args[1], folderRootIds[device]),
          expectRelativePath(args[2], "parentRelativePath"),
          expectString(args[3], "name", 255),
        ],
      };
    }
    case "createSession": {
      expectArgs(args, 1);
      const input = expectRecord(args[0], ["workspaceId", "title"]);
      const title = input.title === undefined ? undefined : expectString(input.title, "title", 500);
      return {
        method: allowedMethod,
        args: [
          {
            workspaceId: expectAuthorizedWorkspace(input.workspaceId, workspaceIds),
            ...(title === undefined ? {} : { title }),
          },
        ],
      };
    }
    case "startThread": {
      expectArgs(args, 1);
      const input = expectRecord(args[0], [
        "rootWorkspaceId",
        "environment",
        "prompt",
        "provider",
        "modelId",
        "thinkingLevel",
        "attachments",
        "extensionFlags",
      ]);
      if (input.environment !== "local" && input.environment !== "worktree") {
        throw new TypeError("Thread environment is invalid.");
      }
      const attachments =
        input.attachments === undefined ? [] : expectRemoteImages(input.attachments);
      const extensionFlags =
        input.extensionFlags === undefined
          ? undefined
          : expectExtensionFlags(input.extensionFlags, "extensionFlags");
      if (
        extensionFlags &&
        Object.entries(extensionFlags).some(
          ([name, value]) =>
            name.length > 128 || (typeof value === "string" && value.length > 4096),
        )
      ) {
        throw new TypeError("Extension flags are too long.");
      }
      const prompt = optionalString(input.prompt, "prompt", MAX_TEXT_BYTES);
      const provider = optionalString(input.provider, "provider", 256);
      const modelId = optionalString(input.modelId, "modelId", 256);
      const thinkingLevel =
        input.thinkingLevel === undefined ? undefined : expectThinkingLevel(input.thinkingLevel);
      const safeInput: StartThreadInput = {
        rootWorkspaceId: expectAuthorizedWorkspace(input.rootWorkspaceId, workspaceIds),
        environment: input.environment,
        ...(prompt === undefined ? {} : { prompt }),
        ...(provider === undefined ? {} : { provider }),
        ...(modelId === undefined ? {} : { modelId }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        ...(extensionFlags === undefined ? {} : { extensionFlags }),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      return { method: allowedMethod, args: [safeInput] };
    }
    case "setSessionModel": {
      expectArgs(args, 4);
      return {
        method: allowedMethod,
        args: [
          expectAuthorizedWorkspace(args[0], workspaceIds),
          expectString(args[1], "sessionId", 256),
          expectString(args[2], "provider", 256),
          expectString(args[3], "modelId", 256),
        ],
      };
    }
    case "setDefaultModel": {
      expectArgs(args, 3);
      return {
        method: allowedMethod,
        args: [
          expectAuthorizedWorkspace(args[0], workspaceIds),
          expectString(args[1], "provider", 256),
          expectString(args[2], "modelId", 256),
        ],
      };
    }
    case "setSessionThinkingLevel": {
      expectArgs(args, 3);
      return {
        method: allowedMethod,
        args: [
          expectAuthorizedWorkspace(args[0], workspaceIds),
          expectString(args[1], "sessionId", 256),
          expectThinkingLevel(args[2]),
        ],
      };
    }
    case "setSessionPermission": {
      expectArgs(args, 3);
      if (!isSessionPermission(args[2])) throw new TypeError("permission is not supported.");
      return {
        method: allowedMethod,
        args: [
          expectAuthorizedWorkspace(args[0], workspaceIds),
          expectString(args[1], "sessionId", 256),
          args[2],
        ],
      };
    }
    case "respondToHostUiRequest": {
      // Answers a pending approval or input dialog in an authorized chat.
      expectArgs(args, 3);
      return {
        method: allowedMethod,
        args: [
          expectAuthorizedWorkspace(args[0], workspaceIds),
          expectString(args[1], "sessionId", 256),
          expectHostUiResponse(args[2]),
        ],
      };
    }
    case "setDefaultThinkingLevel": {
      if (args.length !== 1 && args.length !== 2) {
        throw new TypeError("setDefaultThinkingLevel expects one or two arguments.");
      }
      const workspaceId = expectAuthorizedWorkspace(args[0], workspaceIds);
      return args.length === 1
        ? { method: allowedMethod, args: [workspaceId] }
        : { method: allowedMethod, args: [workspaceId, expectThinkingLevel(args[1])] };
    }
    case "listWorkspaceFiles": {
      if (args.length !== 1 && args.length !== 2) {
        throw new TypeError("listWorkspaceFiles expects one or two arguments.");
      }
      const options = args[1] === undefined ? {} : expectRecord(args[1], ["force"]);
      if (options.force !== undefined && typeof options.force !== "boolean") {
        throw new TypeError("force must be a boolean.");
      }
      return {
        method: allowedMethod,
        args:
          args.length === 1 || options.force === undefined
            ? [expectAuthorizedWorkspace(args[0], workspaceIds)]
            : [expectAuthorizedWorkspace(args[0], workspaceIds), { force: options.force }],
      };
    }
    case "readWorkspaceFile": {
      expectArgs(args, 2);
      return {
        method: allowedMethod,
        args: [
          expectAuthorizedWorkspace(args[0], workspaceIds),
          expectString(args[1], "filePath", 4_096),
        ],
      };
    }
  }
}

export function filterRemoteState(
  state: DesktopAppState,
  workspaceIds: ReadonlySet<string>,
): DesktopAppState {
  const workspaces = state.workspaces.filter((workspace) => workspaceIds.has(workspace.id));
  // The same key the store uses for every per-session record (workspaceId:sessionId).
  const allowedSessionKeys = new Set(
    workspaces.flatMap((workspace) =>
      workspace.sessions.map((session) =>
        sessionKey({ workspaceId: workspace.id, sessionId: session.id }),
      ),
    ),
  );
  const allowedSessionIds = new Set(
    workspaces.flatMap((workspace) => workspace.sessions.map((session) => session.id)),
  );
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const selectedSessionId = selectedWorkspace?.sessions.some(
    (session) => session.id === state.selectedSessionId,
  )
    ? state.selectedSessionId
    : "";
  const paths = new Set(workspaces.map((workspace) => workspace.path));

  return {
    ...state,
    // Remote clients have an independent draft. Never copy a local user's
    // in-progress composer text or host-local attachment paths across devices.
    composerDraft: "",
    composerDraftSyncSource: "state",
    composerDraftSyncNonce: 0,
    composerAttachments: [],
    editingQueuedMessageId: undefined,
    workspaces,
    selectedWorkspaceId: selectedWorkspace?.id ?? workspaces[0]?.id ?? "",
    selectedSessionId,
    worktreesByWorkspace: filterRecord(state.worktreesByWorkspace, (key) => workspaceIds.has(key)),
    runtimeByWorkspace: filterRecord(state.runtimeByWorkspace, (key) => workspaceIds.has(key)),
    sessionCommandsBySession: filterRecord(state.sessionCommandsBySession, (key) =>
      allowedSessionKeys.has(key),
    ),
    sessionUsageBySession: filterRecord(state.sessionUsageBySession, (key) =>
      allowedSessionKeys.has(key),
    ),
    sessionExtensionUiBySession: filterRecord(state.sessionExtensionUiBySession, (key) =>
      allowedSessionKeys.has(key),
    ),
    extensionCommandCompatibilityByWorkspace: filterRecord(
      state.extensionCommandCompatibilityByWorkspace,
      (key) => workspaceIds.has(key),
    ),
    extensionFlagsByWorkspace: filterRecord(state.extensionFlagsByWorkspace, (key) =>
      workspaceIds.has(key),
    ),
    extensionFlagsBySession: filterRecord(state.extensionFlagsBySession, (key) =>
      allowedSessionKeys.has(key),
    ),
    orchestrationChildren: state.orchestrationChildren.filter(
      (child) =>
        workspaceIds.has(child.parentWorkspaceId) && workspaceIds.has(child.childWorkspaceId),
    ),
    scheduledTasks: state.scheduledTasks
      .filter((task) => workspaceIds.has(task.target.workspaceId))
      .map((task) => ({
        ...task,
        runs: task.runs.filter((run) => workspaceIds.has(run.workspaceId)),
      })),
    startupDiagnostics: state.startupDiagnostics.filter(
      (diagnostic) =>
        diagnostic.scope !== "workspace" ||
        (diagnostic.workspacePath !== undefined && paths.has(diagnostic.workspacePath)),
    ),
    lastViewedAtBySession: filterRecord(state.lastViewedAtBySession, (key) =>
      allowedSessionKeys.has(key),
    ),
    lastInteractedAtBySession: filterRecord(state.lastInteractedAtBySession, (key) =>
      allowedSessionKeys.has(key),
    ),
    pinnedAtBySession: filterRecord(state.pinnedAtBySession, (key) => allowedSessionKeys.has(key)),
    pinnedSessionOrder: state.pinnedSessionOrder.filter((sessionId) =>
      allowedSessionIds.has(sessionId),
    ),
    workspaceOrder: state.workspaceOrder.filter((workspaceId) => workspaceIds.has(workspaceId)),
    workspaceDescriptions: filterRecord(state.workspaceDescriptions, (key) =>
      workspaceIds.has(key),
    ),
    collapsedWorkspaceIds: state.collapsedWorkspaceIds.filter((workspaceId) =>
      workspaceIds.has(workspaceId),
    ),
  };
}

export function projectRemoteResult(
  method: RemoteDesktopPiMethod,
  result: unknown,
  workspaceIds: ReadonlySet<string>,
): unknown {
  if (method === "getSelectedTranscript") {
    const transcript = isSelectedTranscript(result) ? result : null;
    return transcript && workspaceIds.has(transcript.workspaceId) ? transcript : null;
  }
  if (isDesktopAppState(result)) return filterRemoteState(result, workspaceIds);
  return result;
}

export function assertRemoteJsonSize(value: unknown, maxBytes: number, label: string): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} is not JSON-safe.`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new TypeError(`${label} exceeds the size limit.`);
  }
}

function isDesktopAppState(value: unknown): value is DesktopAppState {
  return (
    isRecord(value) &&
    Array.isArray(value.workspaces) &&
    typeof value.selectedWorkspaceId === "string"
  );
}

function isSelectedTranscript(value: unknown): value is SelectedTranscriptRecord {
  return (
    isRecord(value) &&
    typeof value.workspaceId === "string" &&
    typeof value.sessionId === "string" &&
    Array.isArray(value.transcript)
  );
}

function filterRecord<T>(
  record: Readonly<Record<string, T>>,
  keep: (key: string) => boolean,
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => keep(key)));
}

function expectArgs(args: readonly unknown[], count: number): void {
  if (args.length !== count) throw new TypeError(`Expected ${count} remote method argument(s).`);
}

function expectAuthorizedWorkspace(value: unknown, workspaceIds: ReadonlySet<string>): string {
  const workspaceId = expectString(value, "workspaceId", 1_024);
  if (!workspaceIds.has(workspaceId))
    throw new Error("Workspace is not authorized for this device.");
  return workspaceId;
}

function expectAuthorizedWorkspaceSessionTarget(
  value: unknown,
  workspaceIds: ReadonlySet<string>,
): { readonly workspaceId: string; readonly sessionId: string } {
  const target = expectRecord(value, ["workspaceId", "sessionId"]);
  return {
    workspaceId: expectAuthorizedWorkspace(target.workspaceId, workspaceIds),
    sessionId: expectString(target.sessionId, "sessionId", 256),
  };
}

/** A client's files live on its own disk, so only images travel, as bytes, never as paths. */
function expectRemoteImages(value: unknown): readonly ComposerImageAttachment[] {
  if (Array.isArray(value) && value.length > MAX_REMOTE_ATTACHMENTS) {
    throw new TypeError(`At most ${MAX_REMOTE_ATTACHMENTS} attachments can be sent at once.`);
  }
  // Also enforces the per-image and total byte limits.
  return expectComposerAttachments(value).map((attachment) => {
    if (attachment.kind !== "image") {
      throw new TypeError("Only images can be sent from a remote client.");
    }
    if (!IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      throw new TypeError("Image type is not supported.");
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(attachment.data)) {
      throw new TypeError("Image data must be base64.");
    }
    if (attachment.id.length > 256 || attachment.name.length > 512) {
      throw new TypeError("Image name is too long.");
    }
    return {
      id: attachment.id,
      kind: "image",
      name: attachment.name,
      mimeType: attachment.mimeType,
      data: attachment.data,
    };
  });
}

function expectString(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxLength
  ) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maxLength} bytes.`);
  }
  return value;
}

function expectRelativePath(value: unknown, name: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new TypeError(`${name} must be a relative path of at most 4,096 bytes.`);
  }
  return value;
}

function expectFolderDevice(value: unknown): WorkspaceFolderDevice {
  if (value !== "windows" && value !== "mac") {
    throw new TypeError("Folder device is invalid.");
  }
  return value;
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : expectString(value, name, maxLength);
}

const APP_VIEWS = new Set<AppView>([
  "threads",
  "new-thread",
  "scheduled",
  "usage",
  "skills",
  "extensions",
  "settings",
]);

function expectAppView(value: unknown): AppView {
  if (typeof value !== "string" || !APP_VIEWS.has(value as AppView)) {
    throw new TypeError("App view is invalid.");
  }
  return value as AppView;
}

function expectThinkingLevel(value: unknown): string {
  if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
    throw new TypeError("Thinking level is invalid.");
  }
  return value;
}

function expectRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new TypeError("Remote method object contains invalid fields.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
