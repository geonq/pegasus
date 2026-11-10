import type { PiDesktopApi } from "../../contracts/ipc";
import {
  acceptComposerAttachments,
  SUPPORTED_COMPOSER_IMAGE_TYPES,
} from "../../contracts/composer-attachments";
import type {
  AppView,
  ComposerAttachment,
  ComposerImageAttachment,
  DesktopAppState,
  SelectedTranscriptRecord,
  ThreadGrouping,
} from "../../contracts/desktop-state";
import type {
  WorkspaceFolderAdapters,
  WorkspaceFolderCreateResult,
  WorkspaceFolderListing,
  WorkspaceFolderOpenResult,
  WorkspaceFolderRoot,
} from "../../contracts/workspace-folders";
import {
  decodeTaskWorkbenchTemplate,
  type SaveTaskWorkbenchTemplateInput,
  type TaskWorkbenchTemplate,
} from "../../contracts/workbench";
import {
  isRemoteDesktopMethod,
  remoteClientIpc,
  type RemoteDesktopEvent,
  type RemoteDesktopMethod,
} from "./remote-desktop-protocol";
import type {
  RemoteDesktopClientPreferences,
  RemoteDesktopClientPreferencesPatch,
} from "./remote-desktop-client-preferences";

type InvokeRemote = (method: RemoteDesktopMethod, args: readonly unknown[]) => Promise<unknown>;
type SubscribeRemote = (listener: (event: RemoteDesktopEvent) => void) => () => void;
type GetLocalPreferences = () => Promise<RemoteDesktopClientPreferences>;
type SetLocalPreferences = (
  patch: RemoteDesktopClientPreferencesPatch,
) => Promise<RemoteDesktopClientPreferences>;

const REMOTE_METHODS = new Set<PropertyKey>([
  "getState",
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
]);

/** Review and terminals act on the host checkout and shell, so they pass straight through. */
const PASS_THROUGH_METHODS = new Set<PropertyKey>([
  "getTurnChanges",
  "getReview",
  "getReviewFile",
  "setReviewFileReviewed",
  "changeReviewFileStage",
  "getGitActions",
  "getPullRequestFeedback",
  "draftGitText",
  "runGitAction",
  "sendReviewComments",
  "ensureTerminalPanel",
  "createTerminalSession",
  "setActiveTerminalSession",
  "writeTerminal",
  "resizeTerminal",
  "restartTerminalSession",
  "closeTerminalSession",
  "setTerminalTitle",
]);

const TERMINAL_EVENTS = new Map<PropertyKey, RemoteDesktopEvent["type"]>([
  ["onTerminalData", "terminalData"],
  ["onTerminalExit", "terminalExit"],
  ["onTerminalError", "terminalError"],
]);

const LOCAL_METHODS = new Set<PropertyKey>([
  "ping",
  "getThemeMode",
  "getResolvedTheme",
  "onThemeChanged",
  "onWindowFocused",
  "toggleWindowMaximize",
  "openExternal",
  "relaunchApplication",
  // Each app updates itself; the Mac reads its host's version in main, not through the renderer.
  "getAppVersion",
  "getUpdateStatus",
  "checkForAppUpdate",
  "installAppUpdate",
  "onUpdateStatus",
  "getPathForFile",
  "readClipboardImage",
  "onPendingComposerDraftFlush",
  "persistComposerDraft",
  "updateComposerDraft",
  // Focus decides which window's keyboard shortcuts yield to the terminal: this window's.
  "setTerminalFocused",
  "setSidePanelFocused",
]);

/** Reuse the existing typed PiDesktopApi surface while rejecting unimplemented cross-host calls. */
export function createRemoteDesktopClientApi(
  localApi: PiDesktopApi,
  invokeRemote: InvokeRemote,
  subscribeRemote: SubscribeRemote,
  getLocalPreferences: GetLocalPreferences,
  setLocalPreferences: SetLocalPreferences,
): PiDesktopApi {
  // Drafts stay on this client, one per chat like the host keeps them: the renderer flushes the
  // draft of the chat it leaves, and a single shared draft carried that text into the next chat.
  const localDrafts = new Map<string, string>();
  // Attachments stay here too: the host cannot read this machine's files, so images are sent as
  // bytes with the message.
  const localAttachments = new Map<string, readonly ComposerAttachment[]>();
  const draftKey = (target: { readonly workspaceId: string; readonly sessionId: string }) =>
    `${target.workspaceId}:${target.sessionId}`;
  const setLocalDraft = (
    target: { readonly workspaceId: string; readonly sessionId: string },
    draft: string,
  ) => {
    if (draft) localDrafts.set(draftKey(target), draft);
    else localDrafts.delete(draftKey(target));
  };
  const workbenchKey = (target: { readonly workspaceId: string; readonly sessionId: string }) =>
    `pegasus.workbench:${draftKey(target)}`;
  const localWorkbench = new Map<string, TaskWorkbenchTemplate>();
  const readLocalWorkbench = (target: {
    readonly workspaceId: string;
    readonly sessionId: string;
  }): TaskWorkbenchTemplate | null => {
    const key = workbenchKey(target);
    const kept = localWorkbench.get(key);
    if (kept) return kept;
    try {
      const raw = globalThis.localStorage?.getItem(key);
      return raw ? decodeTaskWorkbenchTemplate(JSON.parse(raw)) : null;
    } catch {
      // An unreadable saved layout starts fresh instead of blocking the panel.
      return null;
    }
  };
  const writeLocalWorkbench = (
    target: { readonly workspaceId: string; readonly sessionId: string },
    template: TaskWorkbenchTemplate,
  ) => {
    const key = workbenchKey(target);
    localWorkbench.set(key, template);
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(template));
    } catch {
      // Storage full or unavailable: the layout still holds for this run.
    }
  };
  const selectedTarget = (state: DesktopAppState) => ({
    workspaceId: state.selectedWorkspaceId,
    sessionId: state.selectedSessionId,
  });
  let lastState: DesktopAppState | null = null;
  let localPreferences: RemoteDesktopClientPreferences | undefined;
  const preferencesReady = getLocalPreferences().then((preferences) => {
    localPreferences = preferences;
    return preferences;
  });
  const overlayDraft = (state: DesktopAppState): DesktopAppState => ({
    ...state,
    composerDraft: localDrafts.get(draftKey(selectedTarget(state))) ?? "",
    composerDraftSyncSource: "state",
    composerAttachments: localAttachments.get(draftKey(selectedTarget(state))) ?? [],
    editingQueuedMessageId: undefined,
  });
  const addLocalAttachments = async (
    incoming: readonly ComposerAttachment[],
  ): Promise<DesktopAppState> => {
    const state = lastState ?? (await getState());
    const key = draftKey(selectedTarget(state));
    const existing = localAttachments.get(key) ?? [];
    const result = incoming.every((attachment) => attachment.kind === "image")
      ? acceptComposerAttachments(existing, incoming)
      : { ok: false as const, error: new Error("Only images can be sent to the Windows host.") };
    if (!result.ok) return { ...state, lastError: result.error.message };
    if (incoming.length > 0) localAttachments.set(key, [...existing, ...result.attachments]);
    lastState = overlayDraft(state);
    return lastState;
  };
  const overlayLocalPreferences = async (state: DesktopAppState) => {
    const preferences = localPreferences ?? (await preferencesReady);
    return overlayDraft({ ...state, ...preferences });
  };
  const getState = async (): Promise<DesktopAppState> => {
    const [state] = await Promise.all([invokeRemote("getState", []), preferencesReady]);
    lastState = await overlayLocalPreferences(state as DesktopAppState);
    return lastState;
  };
  const runState = async (
    method: RemoteDesktopMethod,
    args: readonly unknown[],
  ): Promise<DesktopAppState> => {
    const [state] = await Promise.all([invokeRemote(method, args), preferencesReady]);
    lastState = await overlayLocalPreferences(state as DesktopAppState);
    return lastState;
  };
  const updatePreferences = async (
    patch: RemoteDesktopClientPreferencesPatch,
  ): Promise<DesktopAppState> => {
    localPreferences = await setLocalPreferences(patch);
    if (!lastState) return getState();
    lastState = overlayDraft({ ...lastState, ...localPreferences });
    return lastState;
  };
  const remoteApi = new Proxy(localApi as PiDesktopApi & { [key: string]: unknown }, {
    get(target, property, receiver) {
      if (property === "backend") return "windows";
      if (property === "onStateChanged") {
        return (listener: (state: DesktopAppState) => void) =>
          subscribeRemote((event) => {
            if (event.type === "stateChanged") {
              void overlayLocalPreferences(event.state)
                .then((state) => {
                  lastState = state;
                  listener(state);
                })
                .catch(() => undefined);
            }
          });
      }
      if (property === "onSelectedTranscriptChanged") {
        return (listener: (record: SelectedTranscriptRecord | null) => void) =>
          subscribeRemote((event) => {
            if (event.type === "selectedTranscriptChanged") listener(event.transcript);
          });
      }
      if (PASS_THROUGH_METHODS.has(property)) {
        return (...args: unknown[]) => {
          // JSON turns a trailing undefined into null, which the host rejects as an argument.
          while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
          return invokeRemote(property as RemoteDesktopMethod, args);
        };
      }
      const terminalEvent = TERMINAL_EVENTS.get(property);
      if (terminalEvent) {
        return (listener: (event: unknown) => void) =>
          subscribeRemote((event) => {
            if (event.type === terminalEvent)
              listener((event as { readonly event: unknown }).event);
          });
      }
      if (REMOTE_METHODS.has(property)) {
        switch (property) {
          case "getState":
            return getState;
          case "getSelectedTranscript":
            return () => invokeRemote("getSelectedTranscript", []);
          case "getSignIns":
            return () => invokeRemote("getSignIns", []);
          case "getAccountStates":
            return () => invokeRemote("getAccountStates", []);
          case "getAccountLimits":
            return (options?: { readonly cachedOnly?: boolean }) =>
              invokeRemote("getAccountLimits", options === undefined ? [] : [options]);
          case "getClaudeSlots":
            return () => invokeRemote("getClaudeSlots", []);
          case "getUsageReport":
            return () => invokeRemote("getUsageReport", []);
          case "selectWorkspace":
            return (workspaceId: string) => runState("selectWorkspace", [workspaceId]);
          case "selectSession":
            return (target: unknown) => runState("selectSession", [target]);
          case "createSession":
            return (input: unknown) => runState("createSession", [input]);
          case "startThread":
            return (input: unknown) => runState("startThread", [input]);
          case "archiveSession":
          case "unarchiveSession":
            return (target: unknown) => runState(property, [target]);
          case "cancelCurrentRun":
            return (target?: unknown) =>
              runState("cancelCurrentRun", target === undefined ? [] : [target]);
          case "setSessionModel":
            return (...args: unknown[]) => runState("setSessionModel", args);
          case "setDefaultModel":
            return (...args: unknown[]) => runState("setDefaultModel", args);
          case "setSessionThinkingLevel":
            return (...args: unknown[]) => runState("setSessionThinkingLevel", args);
          case "setSessionPermission":
            return (...args: unknown[]) => runState("setSessionPermission", args);
          case "respondToHostUiRequest":
            return (...args: unknown[]) => runState("respondToHostUiRequest", args);
          case "answerGenerativeUi":
            return (...args: unknown[]) => runState("answerGenerativeUi", args);
          case "setDefaultThinkingLevel":
            return (...args: unknown[]) => runState("setDefaultThinkingLevel", args);
          case "setThreadGrouping":
            return (grouping: ThreadGrouping) => runState("setThreadGrouping", [grouping]);
          case "loadWorkspaceRuntime":
            return (workspaceId: string, options?: { readonly refresh?: boolean }) =>
              runState(
                "loadWorkspaceRuntime",
                options === undefined ? [workspaceId] : [workspaceId, options],
              );
          case "setActiveView":
            return (view: AppView) => runState("setActiveView", [view]);
          case "listWorkspaceFiles":
            return (...args: unknown[]) => invokeRemote("listWorkspaceFiles", args);
          case "readWorkspaceFile":
            return (...args: unknown[]) => invokeRemote("readWorkspaceFile", args);
          case "removeQueuedComposerMessage":
          case "steerQueuedComposerMessage":
            return (messageId: string) => runState(property, [messageId]);
        }
      }
      if (property === "submitComposer") {
        return async (text: string, options?: { readonly deliverAs?: "steer" | "followUp" }) => {
          const key = lastState ? draftKey(selectedTarget(lastState)) : undefined;
          const attachments = key ? (localAttachments.get(key) ?? []) : [];
          const sendOptions = {
            ...(options?.deliverAs === "steer" ? { deliverAs: "steer" as const } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          };
          await invokeRemote(
            "sendText",
            Object.keys(sendOptions).length > 0 ? [text, sendOptions] : [text],
          );
          if (lastState) setLocalDraft(selectedTarget(lastState), "");
          if (key) localAttachments.delete(key);
          return getState();
        };
      }
      if (property === "addComposerAttachments") {
        return (attachments: readonly ComposerAttachment[]) => addLocalAttachments(attachments);
      }
      if (property === "pickComposerAttachments") {
        return async () => addLocalAttachments(await pickLocalImages());
      }
      if (property === "removeComposerAttachment") {
        return async (attachmentId: string) => {
          const state = lastState ?? (await getState());
          const key = draftKey(selectedTarget(state));
          const next = (localAttachments.get(key) ?? []).filter(
            (attachment) => attachment.id !== attachmentId,
          );
          if (next.length > 0) localAttachments.set(key, next);
          else localAttachments.delete(key);
          lastState = overlayDraft(state);
          return lastState;
        };
      }
      // This client keeps its draft locally, so editing a queued message brings its text back to
      // the composer and takes it out of the queue; sending it again queues or sends it as usual.
      if (property === "editQueuedComposerMessage") {
        return async (messageId: string) => {
          const queued = lastState?.queuedComposerMessages.find(
            (message) => message.id === messageId,
          );
          if (!queued) return getState();
          await invokeRemote("removeQueuedComposerMessage", [messageId]);
          if (lastState) setLocalDraft(selectedTarget(lastState), queued.text);
          const state = await getState();
          lastState = overlayDraft({
            ...state,
            composerDraftSyncNonce: state.composerDraftSyncNonce + 1,
          });
          return lastState;
        };
      }
      // Tool tabs are this window's layout, so this client keeps them itself, like drafts. Without
      // this the side panel failed every restore on the Mac and stayed stuck on an error.
      if (property === "getTaskWorkbenchTemplate") {
        return async (target: { readonly workspaceId: string; readonly sessionId: string }) =>
          readLocalWorkbench(target);
      }
      if (property === "saveTaskWorkbenchTemplate") {
        return async (input: SaveTaskWorkbenchTemplateInput) => {
          writeLocalWorkbench(input.target, decodeTaskWorkbenchTemplate(input.template));
        };
      }
      if (property === "cancelQueuedComposerEdit") {
        return async () => (lastState ? lastState : getState());
      }
      if (property === "setEnableTransparency") {
        return (enabled: boolean) => updatePreferences({ enableTransparency: enabled });
      }
      if (property === "setThemeMode") {
        return (themeMode: RemoteDesktopClientPreferences["themeMode"]) =>
          updatePreferences({ themeMode });
      }
      if (property === "setThemePresetId") {
        return (themePresetId: RemoteDesktopClientPreferences["themePresetId"]) =>
          updatePreferences({ themePresetId });
      }
      if (property === "updateComposerDraft") {
        return async (
          draft: string,
          target?: { readonly workspaceId: string; readonly sessionId: string },
        ) => {
          const owner = target ?? (lastState ? selectedTarget(lastState) : undefined);
          if (owner) setLocalDraft(owner, draft);
          if (!lastState) return getState();
          lastState = overlayDraft({
            ...lastState,
            composerDraftSyncNonce: lastState.composerDraftSyncNonce + 1,
          });
          return lastState;
        };
      }
      if (property === "persistComposerDraft") {
        return async (input: {
          readonly target: { readonly workspaceId: string; readonly sessionId: string };
          readonly draft: string;
        }) => {
          setLocalDraft(input.target, input.draft);
        };
      }
      if (LOCAL_METHODS.has(property)) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        return value.bind(target) as (...args: unknown[]) => unknown;
      }
      if (typeof property === "string" && property.startsWith("on")) {
        return () => () => undefined;
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return async () => {
        throw new Error(
          `The ${String(property)} capability is not available in remote desktop mode.`,
        );
      };
    },
  });
  const workspaceFolders: WorkspaceFolderAdapters = {
    windows: createRemoteWorkspaceFolderAdapter("windows", invokeRemote, overlayLocalPreferences),
    mac: createRemoteWorkspaceFolderAdapter("mac", invokeRemote, overlayLocalPreferences),
  };
  return { ...remoteApi, backend: "windows", workspaceFolders };
}

function createRemoteWorkspaceFolderAdapter(
  device: "windows" | "mac",
  invokeRemote: InvokeRemote,
  overlayState: (state: DesktopAppState) => Promise<DesktopAppState>,
): NonNullable<PiDesktopApi["workspaceFolders"]>["windows"] {
  return {
    async listRoots() {
      return (await invokeRemote("listWorkspaceFolderRoots", [
        device,
      ])) as readonly WorkspaceFolderRoot[];
    },
    async list(rootId, relativePath) {
      const args = relativePath === undefined ? [device, rootId] : [device, rootId, relativePath];
      return (await invokeRemote("listWorkspaceFolders", args)) as WorkspaceFolderListing;
    },
    async open(rootId, relativePath) {
      const result = (await invokeRemote("addWorkspaceFolder", [device, rootId, relativePath])) as
        WorkspaceFolderOpenResult | undefined;
      if (result?.device === "windows") {
        return { ...result, state: await overlayState(result.state) };
      }
      return result as WorkspaceFolderOpenResult;
    },
    async create(rootId, parentRelativePath, name) {
      const result = (await invokeRemote("createWorkspaceFolder", [
        device,
        rootId,
        parentRelativePath,
        name,
      ])) as WorkspaceFolderCreateResult;
      if (result.device === "windows") {
        return { ...result, state: await overlayState(result.state) };
      }
      return result;
    },
  };
}

/** The host's file dialog would browse the host's disk, so the picker runs on this machine. */
function pickLocalImages(): Promise<ComposerImageAttachment[]> {
  // The preload runs in the page, but this tsconfig keeps DOM types out of electron/.
  const page = globalThis as unknown as {
    readonly document: {
      createElement(tag: "input"): {
        type: string;
        multiple: boolean;
        accept: string;
        readonly files: ArrayLike<File> | null;
        addEventListener(type: "change" | "cancel", listener: () => void, options: object): void;
        click(): void;
      };
    };
  };
  return new Promise((resolve, reject) => {
    const input = page.document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = SUPPORTED_COMPOSER_IMAGE_TYPES.map((type) => type.mimeType).join(",");
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.addEventListener(
      "change",
      () => {
        void Promise.all(Array.from(input.files ?? [], readImageFile)).then(resolve, reject);
      },
      { once: true },
    );
    input.click();
  });
}

async function readImageFile(file: File): Promise<ComposerImageAttachment> {
  return {
    id: crypto.randomUUID(),
    kind: "image",
    name: file.name,
    mimeType: file.type,
    data: Buffer.from(await file.arrayBuffer()).toString("base64"),
  };
}

export function remoteClientInvocationFromIpc(value: unknown): {
  readonly method: RemoteDesktopMethod;
  readonly args: readonly unknown[];
} {
  if (!isRecord(value) || typeof value.method !== "string" || !Array.isArray(value.args)) {
    throw new TypeError("Remote desktop invocation is invalid.");
  }
  const method = value.method as RemoteDesktopMethod;
  if (!isRemoteDesktopMethod(method)) {
    throw new TypeError("Remote desktop method is not available.");
  }
  return { method, args: value.args };
}

export const remoteDesktopClientPreloadChannels = {
  invoke: remoteClientIpc.invoke,
  stateChanged: remoteClientIpc.stateChanged,
  selectedTranscriptChanged: remoteClientIpc.selectedTranscriptChanged,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
