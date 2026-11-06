import { expect, test } from "@playwright/test";
import { createEmptyDesktopAppState, type WorkspaceRecord } from "../../contracts/desktop-state";
import {
  filterRemoteState,
  validateRemoteDesktopInvocation,
} from "../../electron/remote/remote-desktop-policy";

const allowedWorkspaceId = "D:\\Pi\\Alpha";
const deniedWorkspaceId = "D:\\Pi\\Private";
const workspaceScope = new Set([allowedWorkspaceId]);

test("remote method policy scopes workspaces and rejects unsafe public methods and fields", () => {
  expect(validateRemoteDesktopInvocation("getState", [], workspaceScope)).toEqual({
    method: "getState",
    args: [],
  });
  expect(validateRemoteDesktopInvocation("cancelCurrentRun", [], workspaceScope)).toEqual({
    method: "cancelCurrentRun",
    args: [],
  });
  expect(validateRemoteDesktopInvocation("getActiveRuns", [], workspaceScope)).toEqual({
    method: "getActiveRuns",
    args: [],
  });
  expect(() =>
    validateRemoteDesktopInvocation("getActiveRuns", [{ all: true }], workspaceScope),
  ).toThrow();
  expect(
    validateRemoteDesktopInvocation(
      "selectSession",
      [{ workspaceId: allowedWorkspaceId, sessionId: "thread-a" }],
      workspaceScope,
    ),
  ).toEqual({
    method: "selectSession",
    args: [{ workspaceId: allowedWorkspaceId, sessionId: "thread-a" }],
  });

  expect(() =>
    validateRemoteDesktopInvocation("selectWorkspace", [deniedWorkspaceId], workspaceScope),
  ).toThrow("not authorized");
  expect(() => validateRemoteDesktopInvocation("listCustomProviders", [], workspaceScope)).toThrow(
    "not allowed",
  );
  expect(() =>
    validateRemoteDesktopInvocation(
      "startThread",
      [
        {
          rootWorkspaceId: allowedWorkspaceId,
          environment: "local",
          attachments: [
            {
              id: "f",
              kind: "file",
              name: "x.txt",
              mimeType: "text/plain",
              fsPath: "D:\\outside.txt",
            },
          ],
        },
      ],
      workspaceScope,
    ),
  ).toThrow("Only images can be sent from a remote client");
  expect(() =>
    validateRemoteDesktopInvocation(
      "startThread",
      [{ rootWorkspaceId: allowedWorkspaceId, environment: "local", hostPath: "D:\\" }],
      workspaceScope,
    ),
  ).toThrow("invalid fields");
});

test("remote new chats accept the composer's empty attachment list and extension flags", () => {
  // Exactly what the Mac composer sends for a first prompt with nothing attached.
  expect(
    validateRemoteDesktopInvocation(
      "startThread",
      [
        {
          rootWorkspaceId: allowedWorkspaceId,
          environment: "local",
          prompt: "Reply with only the word ok.",
          attachments: [],
          provider: "openai",
          modelId: "gpt-6-luna",
          thinkingLevel: "max",
          extensionFlags: { plan: false, persona: "luna" },
        },
      ],
      workspaceScope,
    ),
  ).toEqual({
    method: "startThread",
    args: [
      {
        rootWorkspaceId: allowedWorkspaceId,
        environment: "local",
        prompt: "Reply with only the word ok.",
        provider: "openai",
        modelId: "gpt-6-luna",
        thinkingLevel: "max",
        extensionFlags: { plan: false, persona: "luna" },
      },
    ],
  });
  for (const extensionFlags of [{ plan: 1 }, { "": true }, { plan: "x".repeat(5000) }, []]) {
    expect(() =>
      validateRemoteDesktopInvocation(
        "startThread",
        [{ rootWorkspaceId: allowedWorkspaceId, environment: "local", extensionFlags }],
        workspaceScope,
      ),
    ).toThrow();
  }
  expect(() =>
    validateRemoteDesktopInvocation(
      "startThread",
      [{ rootWorkspaceId: allowedWorkspaceId, environment: "local", attachments: "none" }],
      workspaceScope,
    ),
  ).toThrow("attachments must be an array");
});

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("remote messages carry images as bytes and nothing else", () => {
  const image = { id: "i1", kind: "image", name: "shot.png", mimeType: "image/png", data: PNG_1PX };
  expect(
    validateRemoteDesktopInvocation(
      "sendText",
      ["", { attachments: [{ ...image, extra: 1 }] }],
      workspaceScope,
    ),
  ).toEqual({ method: "sendText", args: ["", { attachments: [image] }] });
  expect(
    validateRemoteDesktopInvocation(
      "startThread",
      [{ rootWorkspaceId: allowedWorkspaceId, environment: "local", attachments: [image] }],
      workspaceScope,
    ).args[0],
  ).toMatchObject({ attachments: [image] });
  // Empty text needs an image; an empty options record collapses to plain text.
  expect(() => validateRemoteDesktopInvocation("sendText", [" ", {}], workspaceScope)).toThrow(
    "cannot be empty",
  );
  expect(validateRemoteDesktopInvocation("sendText", ["hi", {}], workspaceScope).args).toEqual([
    "hi",
  ]);
  for (const bad of [
    { ...image, mimeType: "image/svg+xml" },
    { ...image, data: "<script>" },
    { ...image, data: "A".repeat(15 * 1024 * 1024) },
  ]) {
    expect(() =>
      validateRemoteDesktopInvocation("sendText", ["x", { attachments: [bad] }], workspaceScope),
    ).toThrow();
  }
  const many = Array.from({ length: 17 }, (_, index) => ({ ...image, id: `i${index}` }));
  expect(() =>
    validateRemoteDesktopInvocation("sendText", ["x", { attachments: many }], workspaceScope),
  ).toThrow("At most 16");
});

test("remote usage reads allow only the documented cachedOnly metadata option", () => {
  for (const method of ["getSignIns", "getAccountStates", "getUsageReport"] as const) {
    expect(validateRemoteDesktopInvocation(method, [], workspaceScope)).toEqual({
      method,
      args: [],
    });
    expect(() => validateRemoteDesktopInvocation(method, [true], workspaceScope)).toThrow(
      "Expected 0 remote method argument",
    );
  }

  expect(validateRemoteDesktopInvocation("getAccountLimits", [], workspaceScope)).toEqual({
    method: "getAccountLimits",
    args: [],
  });
  expect(
    validateRemoteDesktopInvocation("getAccountLimits", [{ cachedOnly: true }], workspaceScope),
  ).toEqual({ method: "getAccountLimits", args: [{ cachedOnly: true }] });
  expect(
    validateRemoteDesktopInvocation("getAccountLimits", [{ cachedOnly: false }], workspaceScope),
  ).toEqual({ method: "getAccountLimits", args: [{ cachedOnly: false }] });
  for (const args of [
    [null],
    [{ cachedOnly: "yes" }],
    [{ cachedOnly: true, provider: "secret" }],
    [{}, {}],
  ]) {
    expect(() =>
      validateRemoteDesktopInvocation("getAccountLimits", args, workspaceScope),
    ).toThrow();
  }
});

test("remote folder policy keeps Windows and Mac roots separate", () => {
  const folderRoots = {
    windows: new Set(["D:\\Pi\\projects"]),
    mac: new Set(["uniDocuments", "uniVault"]),
  };
  expect(
    validateRemoteDesktopInvocation(
      "listWorkspaceFolderRoots",
      ["mac"],
      workspaceScope,
      folderRoots,
    ),
  ).toEqual({ method: "listWorkspaceFolderRoots", args: ["mac"] });
  expect(
    validateRemoteDesktopInvocation(
      "listWorkspaceFolders",
      ["windows", "D:\\Pi\\projects"],
      workspaceScope,
      folderRoots,
    ),
  ).toEqual({ method: "listWorkspaceFolders", args: ["windows", "D:\\Pi\\projects"] });
  expect(
    validateRemoteDesktopInvocation(
      "listWorkspaceFolders",
      ["windows", "D:\\Pi\\projects", "NextSemis"],
      workspaceScope,
      folderRoots,
    ),
  ).toEqual({
    method: "listWorkspaceFolders",
    args: ["windows", "D:\\Pi\\projects", "NextSemis"],
  });
  expect(() =>
    validateRemoteDesktopInvocation(
      "listWorkspaceFolders",
      ["mac", "D:\\Pi\\projects"],
      workspaceScope,
      folderRoots,
    ),
  ).toThrow("not authorized");
  expect(() =>
    validateRemoteDesktopInvocation(
      "addWorkspaceFolder",
      ["other", "D:\\Pi\\projects", "NextSemis"],
      workspaceScope,
      folderRoots,
    ),
  ).toThrow("Folder device is invalid");
});

test("remote archive actions authorize the workspace and validate the exact session target", () => {
  for (const method of ["archiveSession", "unarchiveSession"] as const) {
    expect(
      validateRemoteDesktopInvocation(
        method,
        [{ workspaceId: allowedWorkspaceId, sessionId: "thread-a" }],
        workspaceScope,
      ),
    ).toEqual({
      method,
      args: [{ workspaceId: allowedWorkspaceId, sessionId: "thread-a" }],
    });

    expect(() =>
      validateRemoteDesktopInvocation(
        method,
        [{ workspaceId: deniedWorkspaceId, sessionId: "private-thread" }],
        workspaceScope,
      ),
    ).toThrow("not authorized");
    expect(() =>
      validateRemoteDesktopInvocation(
        method,
        [{ workspaceId: allowedWorkspaceId, sessionId: "thread-a", force: true }],
        workspaceScope,
      ),
    ).toThrow("invalid fields");
    expect(() =>
      validateRemoteDesktopInvocation(
        method,
        [{ workspaceId: allowedWorkspaceId, sessionId: "" }],
        workspaceScope,
      ),
    ).toThrow("sessionId must be a non-empty string");
  }
});

test("remote permission changes and dialog answers stay inside authorized chats", () => {
  expect(
    validateRemoteDesktopInvocation(
      "setSessionPermission",
      [allowedWorkspaceId, "thread-a", "ask"],
      workspaceScope,
    ),
  ).toEqual({ method: "setSessionPermission", args: [allowedWorkspaceId, "thread-a", "ask"] });
  expect(() =>
    validateRemoteDesktopInvocation(
      "setSessionPermission",
      [allowedWorkspaceId, "thread-a", "implementer"],
      workspaceScope,
    ),
  ).toThrow("permission is not supported");

  const answer = { requestId: "dialog-1", confirmed: true };
  expect(
    validateRemoteDesktopInvocation(
      "respondToHostUiRequest",
      [allowedWorkspaceId, "thread-a", answer],
      workspaceScope,
    ),
  ).toEqual({ method: "respondToHostUiRequest", args: [allowedWorkspaceId, "thread-a", answer] });
  expect(() =>
    validateRemoteDesktopInvocation(
      "respondToHostUiRequest",
      [deniedWorkspaceId, "private-thread", answer],
      workspaceScope,
    ),
  ).toThrow("not authorized");
  expect(() =>
    validateRemoteDesktopInvocation(
      "respondToHostUiRequest",
      [allowedWorkspaceId, "thread-a", { requestId: "dialog-1", confirmed: true, value: "x" }],
      workspaceScope,
    ),
  ).toThrow("exactly one");
});

test("remote state projection removes unauthorized projects and their selection", () => {
  const workspace = (id: string): WorkspaceRecord => ({
    id,
    name: id,
    path: id,
    lastOpenedAt: "2026-10-21T00:00:00.000Z",
    kind: "primary",
    sessions: [
      {
        id: `thread-${id}`,
        title: `Thread ${id}`,
        updatedAt: "2026-10-21T00:00:00.000Z",
        preview: "",
        status: "idle",
        hasUnseenUpdate: false,
      },
    ],
  });
  const allowed = workspace(allowedWorkspaceId);
  const denied = workspace(deniedWorkspaceId);
  const state = {
    ...createEmptyDesktopAppState(),
    workspaces: [allowed, denied],
    selectedWorkspaceId: denied.id,
    selectedSessionId: denied.sessions[0]!.id,
    workspaceDescriptions: { [allowed.id]: "Allowed", [denied.id]: "Private" },
    workspaceOrder: [denied.id, allowed.id],
  };

  const projected = filterRemoteState(state, workspaceScope);

  expect(projected.workspaces.map((entry) => entry.id)).toEqual([allowedWorkspaceId]);
  expect(projected.selectedWorkspaceId).toBe(allowedWorkspaceId);
  expect(projected.selectedSessionId).toBe("");
  expect(projected.workspaceDescriptions).toEqual({ [allowedWorkspaceId]: "Allowed" });
  expect(projected.workspaceOrder).toEqual([allowedWorkspaceId]);
});

test("remote state projection keeps per-session records of authorized threads", () => {
  const thread = (workspaceId: string): WorkspaceRecord => ({
    id: workspaceId,
    name: workspaceId,
    path: workspaceId,
    lastOpenedAt: "2026-10-21T00:00:00.000Z",
    kind: "primary",
    sessions: [
      {
        id: "thread-1",
        title: "Thread",
        updatedAt: "2026-10-21T00:00:00.000Z",
        preview: "",
        status: "idle",
        hasUnseenUpdate: false,
      },
    ],
  });
  const allowedKey = `${allowedWorkspaceId}:thread-1`;
  const deniedKey = `${deniedWorkspaceId}:thread-1`;
  const ui = {
    instanceId: "ui",
    statuses: [{ key: "pi-mode", text: "reviewer" }],
    widgets: [],
    pendingDialogs: [],
    notices: [],
  };
  const projected = filterRemoteState(
    {
      ...createEmptyDesktopAppState(),
      workspaces: [thread(allowedWorkspaceId), thread(deniedWorkspaceId)],
      sessionExtensionUiBySession: { [allowedKey]: ui, [deniedKey]: ui },
      pinnedAtBySession: { [allowedKey]: "2026-10-21T00:00:00.000Z" },
    },
    workspaceScope,
  );

  // The Mac client reads a chat's mode, usage and pins from these records.
  expect(Object.keys(projected.sessionExtensionUiBySession)).toEqual([allowedKey]);
  expect(Object.keys(projected.pinnedAtBySession)).toEqual([allowedKey]);
});

test("remote workspace runtime loads and thread grouping validate exact scoped arguments", () => {
  expect(
    validateRemoteDesktopInvocation("loadWorkspaceRuntime", [allowedWorkspaceId], workspaceScope),
  ).toEqual({ method: "loadWorkspaceRuntime", args: [allowedWorkspaceId] });
  expect(
    validateRemoteDesktopInvocation(
      "loadWorkspaceRuntime",
      [allowedWorkspaceId, { refresh: true }],
      workspaceScope,
    ),
  ).toEqual({
    method: "loadWorkspaceRuntime",
    args: [allowedWorkspaceId, { refresh: true }],
  });
  expect(
    validateRemoteDesktopInvocation(
      "loadWorkspaceRuntime",
      [allowedWorkspaceId, {}],
      workspaceScope,
    ),
  ).toEqual({ method: "loadWorkspaceRuntime", args: [allowedWorkspaceId] });
  expect(() =>
    validateRemoteDesktopInvocation("loadWorkspaceRuntime", [deniedWorkspaceId], workspaceScope),
  ).toThrow("not authorized");
  for (const args of [
    [],
    [allowedWorkspaceId, { refresh: "yes" }],
    [allowedWorkspaceId, { refresh: false, provider: "secret" }],
    [allowedWorkspaceId, {}, {}],
  ]) {
    expect(() =>
      validateRemoteDesktopInvocation("loadWorkspaceRuntime", args, workspaceScope),
    ).toThrow();
  }

  for (const grouping of ["time", "workspace"] as const) {
    expect(
      validateRemoteDesktopInvocation("setThreadGrouping", [grouping], workspaceScope),
    ).toEqual({
      method: "setThreadGrouping",
      args: [grouping],
    });
  }
  expect(() =>
    validateRemoteDesktopInvocation("setThreadGrouping", ["invalid"], workspaceScope),
  ).toThrow("Thread grouping is invalid");
});

test("remote review and terminal calls stay inside authorized workspaces", () => {
  const target = { workspaceId: allowedWorkspaceId, sessionId: "thread-a" };
  expect(
    validateRemoteDesktopInvocation(
      "getReview",
      [{ target, checkoutId: "c", scope: { kind: "uncommitted" } }],
      workspaceScope,
    ).args,
  ).toEqual([{ target, checkoutId: "c", scope: { kind: "uncommitted" } }]);
  expect(() =>
    validateRemoteDesktopInvocation(
      "getReview",
      [
        {
          target: { workspaceId: deniedWorkspaceId, sessionId: "x" },
          checkoutId: "c",
          scope: { kind: "uncommitted" },
        },
      ],
      workspaceScope,
    ),
  ).toThrow("not authorized");
  expect(
    validateRemoteDesktopInvocation(
      "ensureTerminalPanel",
      [allowedWorkspaceId, "scope", { cols: 80, rows: 24 }],
      workspaceScope,
    ).args,
  ).toEqual([allowedWorkspaceId, "scope", { cols: 80, rows: 24 }]);
  expect(() =>
    validateRemoteDesktopInvocation(
      "ensureTerminalPanel",
      [deniedWorkspaceId, "scope"],
      workspaceScope,
    ),
  ).toThrow("not authorized");
  expect(() =>
    validateRemoteDesktopInvocation("resizeTerminal", ["t1", { cols: 80 }], workspaceScope),
  ).toThrow("rows");
  expect(() =>
    validateRemoteDesktopInvocation("setTerminalFocused", [true], workspaceScope),
  ).toThrow("not allowed");
});
