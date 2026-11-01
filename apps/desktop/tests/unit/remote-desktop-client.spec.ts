import { expect, test } from "@playwright/test";
import type { PiDesktopApi } from "../../contracts/ipc";
import { createEmptyDesktopAppState } from "../../contracts/desktop-state";
import type { RemoteDesktopClientPreferences } from "../../electron/remote/remote-desktop-client-preferences";
import { createRemoteDesktopClientApi } from "../../electron/remote/remote-desktop-client-preload";
import { validateRemoteDesktopInvocation } from "../../electron/remote/remote-desktop-policy";
import {
  isRemoteDesktopMethod,
  isRemoteDesktopPiMethod,
} from "../../electron/remote/remote-desktop-protocol";
import type {
  RemoteDesktopEvent,
  RemoteDesktopMethod,
} from "../../electron/remote/remote-desktop-protocol";

test("remote client keeps Mac presentation and draft local while actions target the Windows backend", async () => {
  let preferences: RemoteDesktopClientPreferences = {
    enableTransparency: false,
    themeMode: "light",
    themePresetId: "default",
  };
  const invocations: Array<{ method: RemoteDesktopMethod; args: readonly unknown[] }> = [];
  let eventListener: ((event: RemoteDesktopEvent) => void) | undefined;
  const usageReport = {
    refreshedAt: 1_792_600_000_000,
    totals: { input: 12, output: 7, cacheRead: 5, cacheWrite: 2, cost: 0.001 },
    days: [],
    models: [],
    workspaces: [],
    threads: [],
    sessions: 1,
    unreadable: 0,
  };
  let hostState = {
    ...createEmptyDesktopAppState(),
    selectedWorkspaceId: "workspace",
    selectedSessionId: "thread",
    composerDraft: "Windows draft must stay private",
    enableTransparency: true,
    themeMode: "dark" as const,
  };
  const api = createRemoteDesktopClientApi(
    {
      getState: async () => createEmptyDesktopAppState(),
      updateComposerDraft: async () => createEmptyDesktopAppState(),
      persistComposerDraft: async () => undefined,
      submitComposer: async () => createEmptyDesktopAppState(),
      archiveSession: async () => createEmptyDesktopAppState(),
      unarchiveSession: async () => createEmptyDesktopAppState(),
      setThreadGrouping: async () => createEmptyDesktopAppState(),
      loadWorkspaceRuntime: async () => createEmptyDesktopAppState(),
      readClipboardImage: () => ({ kind: "none" }),
      getUsageReport: async () => usageReport,
      onStateChanged: () => () => undefined,
    } as unknown as PiDesktopApi,
    async (method, args) => {
      invocations.push({ method, args });
      if (method === "getState") return hostState;
      if (method === "getUsageReport") return usageReport;
      return { accepted: true };
    },
    (listener) => {
      eventListener = listener;
      return () => {
        eventListener = undefined;
      };
    },
    async () => preferences,
    async (patch) => {
      preferences = { ...preferences, ...patch };
      return preferences;
    },
  );

  expect(api.backend).toBe("windows");
  expect(Object.getPrototypeOf(api)).toBe(Object.prototype);
  expect(Object.prototype.hasOwnProperty.call(api, "backend")).toBe(true);
  const state = await api.getState();
  expect(state.themeMode).toBe("light");
  expect(state.enableTransparency).toBe(false);
  expect(state.composerDraft).toBe("");
  expect(state.composerAttachments).toEqual([]);

  await api.updateComposerDraft("Mac-only draft", {
    workspaceId: "workspace",
    sessionId: "thread",
  });
  expect((await api.getState()).composerDraft).toBe("Mac-only draft");
  await api.submitComposer("Send this to Windows");
  expect(invocations).toContainEqual({ method: "sendText", args: ["Send this to Windows"] });
  expect((await api.getState()).composerDraft).toBe("");

  // Drafts belong to their chat: the draft flushed for the chat being left (even text that was
  // just sent) never shows up in the chat opened next, and comes back when its chat reopens.
  await api.persistComposerDraft({ target: { workspaceId: "workspace", sessionId: "thread" }, draft: "Stay here" });
  hostState = { ...hostState, selectedSessionId: "other-thread" };
  expect((await api.getState()).composerDraft).toBe("");
  hostState = { ...hostState, selectedSessionId: "thread" };
  expect((await api.getState()).composerDraft).toBe("Stay here");
  await api.updateComposerDraft("", { workspaceId: "workspace", sessionId: "thread" });

  const archiveTarget = { workspaceId: "windows-workspace", sessionId: "thread-archive" };
  await api.archiveSession(archiveTarget);
  await api.unarchiveSession(archiveTarget);
  expect(invocations.slice(-2)).toEqual([
    { method: "archiveSession", args: [archiveTarget] },
    { method: "unarchiveSession", args: [archiveTarget] },
  ]);

  await api.setThreadGrouping("time");
  await api.loadWorkspaceRuntime("windows-workspace", { refresh: true });
  expect(invocations.slice(-2)).toEqual([
    { method: "setThreadGrouping", args: ["time"] },
    { method: "loadWorkspaceRuntime", args: ["windows-workspace", { refresh: true }] },
  ]);

  const stateChanges: string[] = [];
  api.onStateChanged((next) => stateChanges.push(`${next.themeMode}:${next.enableTransparency}`));
  eventListener?.({ type: "stateChanged", state: hostState });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(stateChanges).toEqual(["light:false"]);
  expect(api.readClipboardImage()).toEqual({ kind: "none" });
  await expect(api.getUsageReport()).resolves.toEqual(usageReport);
  expect(invocations[invocations.length - 1]).toEqual({
    method: "getUsageReport",
    args: [],
  });
});

test("remote client sends usage metadata reads to Windows and returns their real results", async () => {
  const invocations: Array<{ method: RemoteDesktopMethod; args: readonly unknown[] }> = [];
  const signIns = [{ id: "openai", name: "OpenAI", state: "ok" as const }];
  const accountStates = [{ id: "claude-code-account-1", state: "ready" as const }];
  const accountLimits = [
    {
      id: "openai",
      name: "OpenAI",
      windows: [{ label: "Weekly", usedPercent: 12 }],
      asOf: 1_792_570_000_000,
    },
  ];
  const api = createRemoteDesktopClientApi(
    {
      getSignIns: async () => [],
      getAccountStates: async () => [],
      getAccountLimits: async () => [],
    } as unknown as PiDesktopApi,
    async (method, args) => {
      invocations.push({ method, args });
      if (method === "getSignIns") return signIns;
      if (method === "getAccountStates") return accountStates;
      if (method === "getAccountLimits") return accountLimits;
      return createEmptyDesktopAppState();
    },
    () => () => undefined,
    async () => ({ enableTransparency: false, themeMode: "light", themePresetId: "default" }),
    async () => ({ enableTransparency: false, themeMode: "light", themePresetId: "default" }),
  );

  await expect(api.getSignIns()).resolves.toEqual(signIns);
  await expect(api.getAccountStates()).resolves.toEqual(accountStates);
  await expect(api.getAccountLimits()).resolves.toEqual(accountLimits);
  await expect(api.getAccountLimits({ cachedOnly: true })).resolves.toEqual(accountLimits);
  expect(invocations).toEqual([
    { method: "getSignIns", args: [] },
    { method: "getAccountStates", args: [] },
    { method: "getAccountLimits", args: [] },
    { method: "getAccountLimits", args: [{ cachedOnly: true }] },
  ]);
});

test("remote folder adapters keep device identity on every Windows and Mac operation", async () => {
  const invocations: Array<{ method: RemoteDesktopMethod; args: readonly unknown[] }> = [];
  const listing = {
    rootId: "D:\\Pi\\projects",
    rootLabel: "Projects",
    relativePath: "",
    folders: [],
    truncated: false,
  };
  const api = createRemoteDesktopClientApi(
    { getState: async () => createEmptyDesktopAppState() } as unknown as PiDesktopApi,
    async (method, args) => {
      invocations.push({ method, args });
      if (method === "listWorkspaceFolderRoots") return [];
      if (method === "listWorkspaceFolders") return listing;
      if (method === "addWorkspaceFolder") return { device: "mac" };
      if (method === "createWorkspaceFolder") return { device: "mac", relativePath: "New" };
      return createEmptyDesktopAppState();
    },
    () => () => undefined,
    async () => ({ enableTransparency: false, themeMode: "light", themePresetId: "default" }),
    async () => ({ enableTransparency: false, themeMode: "light", themePresetId: "default" }),
  );

  const folders = api.workspaceFolders!;
  await folders.windows.listRoots();
  await folders.windows.list("D:\\Pi\\projects");
  await folders.windows.list("D:\\Pi\\projects", "NextSemis");
  await folders.windows.open("D:\\Pi\\projects", "NextSemis");
  await folders.mac!.listRoots();
  await folders.mac!.list("uniDocuments", "Courses");
  await folders.mac!.open("uniDocuments", "Courses");
  await folders.mac!.create("uniDocuments", "Courses", "New");

  expect(invocations).toEqual([
    { method: "listWorkspaceFolderRoots", args: ["windows"] },
    { method: "listWorkspaceFolders", args: ["windows", "D:\\Pi\\projects"] },
    { method: "listWorkspaceFolders", args: ["windows", "D:\\Pi\\projects", "NextSemis"] },
    { method: "addWorkspaceFolder", args: ["windows", "D:\\Pi\\projects", "NextSemis"] },
    { method: "listWorkspaceFolderRoots", args: ["mac"] },
    { method: "listWorkspaceFolders", args: ["mac", "uniDocuments", "Courses"] },
    { method: "addWorkspaceFolder", args: ["mac", "uniDocuments", "Courses"] },
    {
      method: "createWorkspaceFolder",
      args: ["mac", "uniDocuments", "Courses", "New"],
    },
  ]);
});

test("remote client routes active-view changes through the passive Windows view", async () => {
  const preferences: RemoteDesktopClientPreferences = {
    enableTransparency: false,
    themeMode: "light",
    themePresetId: "default",
  };
  const projectedState = {
    ...createEmptyDesktopAppState(),
    activeView: "skills" as const,
  };
  const invocations: Array<{ method: RemoteDesktopMethod; args: readonly unknown[] }> = [];
  let localSetActiveViewCalls = 0;
  const api = createRemoteDesktopClientApi(
    {
      setActiveView: async () => {
        localSetActiveViewCalls += 1;
        return createEmptyDesktopAppState();
      },
    } as unknown as PiDesktopApi,
    async (method, args) => {
      invocations.push({ method, args });
      return projectedState;
    },
    () => () => undefined,
    async () => preferences,
    async () => preferences,
  );

  expect(isRemoteDesktopPiMethod("setActiveView")).toBe(true);
  expect(isRemoteDesktopMethod("setActiveView")).toBe(true);
  expect(validateRemoteDesktopInvocation("setActiveView", ["skills"], new Set())).toEqual({
    method: "setActiveView",
    args: ["skills"],
  });
  expect(() => validateRemoteDesktopInvocation("setActiveView", ["providers"], new Set())).toThrow(
    "App view is invalid.",
  );
  await expect(api.setActiveView("skills")).resolves.toMatchObject({
    activeView: "skills",
    themeMode: "light",
  });
  expect(invocations).toEqual([{ method: "setActiveView", args: ["skills"] }]);
  expect(localSetActiveViewCalls).toBe(0);
});

test("queued messages can be steered, removed and edited from the Mac, and a new message can steer", async () => {
  const preferences: RemoteDesktopClientPreferences = {
    enableTransparency: false,
    themeMode: "light",
    themePresetId: "default",
  };
  const queued = {
    id: "q1",
    mode: "followUp" as const,
    text: "also add captions",
    attachments: [],
    createdAt: "",
    updatedAt: "",
  };
  let hostQueue = [queued];
  const invocations: Array<{ method: RemoteDesktopMethod; args: readonly unknown[] }> = [];
  const api = createRemoteDesktopClientApi(
    Object.fromEntries(
      [
        "getState",
        "submitComposer",
        "editQueuedComposerMessage",
        "cancelQueuedComposerEdit",
        "removeQueuedComposerMessage",
        "steerQueuedComposerMessage",
      ].map((name) => [name, async () => createEmptyDesktopAppState()]),
    ) as unknown as PiDesktopApi,
    async (method, args) => {
      invocations.push({ method, args });
      if (method === "removeQueuedComposerMessage") hostQueue = [];
      return { ...createEmptyDesktopAppState(), queuedComposerMessages: hostQueue };
    },
    () => () => undefined,
    async () => preferences,
    async () => preferences,
  );
  await api.getState();

  await api.steerQueuedComposerMessage("q1");
  await api.submitComposer("stop and use Opus", { deliverAs: "steer" });
  const edited = await api.editQueuedComposerMessage("q1");
  // Editing brings the text back into the Mac's own composer and takes it out of the host queue.
  expect(edited.composerDraft).toBe("also add captions");
  expect(edited.queuedComposerMessages).toEqual([]);
  await expect(api.cancelQueuedComposerEdit()).resolves.toBeTruthy();
  expect(
    invocations
      .filter((entry) => entry.method !== "getState")
      .map((entry) => [entry.method, ...entry.args]),
  ).toEqual([
    ["steerQueuedComposerMessage", "q1"],
    ["sendText", "stop and use Opus", { deliverAs: "steer" }],
    ["removeQueuedComposerMessage", "q1"],
  ]);
  // Each one passes the host's policy, which still refuses anything else.
  for (const { method, args } of invocations) {
    expect(() => validateRemoteDesktopInvocation(method, args, new Set())).not.toThrow();
  }
  expect(() =>
    validateRemoteDesktopInvocation("sendText", ["x", { deliverAs: "now" }], new Set()),
  ).toThrow();
  expect(() =>
    validateRemoteDesktopInvocation("removeQueuedComposerMessage", [42], new Set()),
  ).toThrow();
});

test("remote client keeps image attachments per chat and sends them with the message", async () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const image = { id: "i1", kind: "image" as const, name: "shot.png", mimeType: "image/png", data: png };
  const invocations: Array<{ method: RemoteDesktopMethod; args: readonly unknown[] }> = [];
  let hostState = {
    ...createEmptyDesktopAppState(),
    selectedWorkspaceId: "workspace",
    selectedSessionId: "thread",
  };
  const preferences: RemoteDesktopClientPreferences = {
    enableTransparency: false,
    themeMode: "light",
    themePresetId: "default",
  };
  const unused = async () => createEmptyDesktopAppState();
  const api = createRemoteDesktopClientApi(
    // The client spreads the local API, so it needs these names, never these bodies.
    {
      getState: unused,
      addComposerAttachments: unused,
      removeComposerAttachment: unused,
      submitComposer: unused,
    } as unknown as PiDesktopApi,
    async (method, args) => {
      invocations.push({ method, args });
      return method === "getState" ? hostState : { accepted: true };
    },
    () => () => undefined,
    async () => preferences,
    async () => preferences,
  );
  await api.getState();

  expect((await api.addComposerAttachments([image])).composerAttachments).toEqual([image]);
  // A file path from this Mac means nothing on Windows, so it is refused with a visible error.
  const refused = await api.addComposerAttachments([
    { id: "f", kind: "file", name: "a.txt", mimeType: "text/plain", fsPath: "/Users/me/a.txt" },
  ]);
  expect(refused.lastError).toContain("Only images");
  expect(refused.composerAttachments).toEqual([image]);

  hostState = { ...hostState, selectedSessionId: "other-thread" };
  expect((await api.getState()).composerAttachments).toEqual([]);
  hostState = { ...hostState, selectedSessionId: "thread" };
  expect((await api.getState()).composerAttachments).toEqual([image]);

  await api.addComposerAttachments([{ ...image, id: "i2" }]);
  expect((await api.removeComposerAttachment("i2")).composerAttachments).toEqual([image]);

  const sent = await api.submitComposer("");
  expect(sent.composerAttachments).toEqual([]);
  const send = invocations.find((entry) => entry.method === "sendText");
  expect(send?.args).toEqual(["", { attachments: [image] }]);
  expect(() =>
    validateRemoteDesktopInvocation("sendText", send?.args ?? [], new Set(["workspace"])),
  ).not.toThrow();
});
