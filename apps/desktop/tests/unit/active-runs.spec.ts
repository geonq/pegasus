import { expect, test } from "@playwright/test";
import {
  createEmptyDesktopAppState,
  type DesktopAppState,
  type SessionRecord,
  type WorkspaceRecord,
} from "../../contracts/desktop-state";
import { mapActiveRuns } from "../../electron/usage/active-runs";

const SECRET_TITLE = "Title: rotate the bank token";
const SECRET_PREVIEW = "Preview: here is my password hunter2";
const SECRET_STEP = "Running: cat C:\\Users\\domke\\secret.txt";
const SECRET_PATH = "D:\\Pi\\projects\\Private";

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    title: SECRET_TITLE,
    updatedAt: "2026-11-02T10:05:00.000Z",
    preview: SECRET_PREVIEW,
    status: "running",
    runningSince: "2026-11-02T10:00:00.000Z",
    hasUnseenUpdate: false,
    config: { provider: "claude-code-account-2", modelId: "claude-opus-5-5" },
    touchedFiles: [`${SECRET_PATH}\\notes.md`],
    ...overrides,
  };
}

function workspace(
  id: string,
  name: string,
  sessions: SessionRecord[],
  extra: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    id,
    name,
    path: SECRET_PATH,
    lastOpenedAt: "2026-11-02T09:00:00.000Z",
    kind: "primary",
    sessions,
    ...extra,
  };
}

function stateWith(
  workspaces: WorkspaceRecord[],
  extra: Partial<DesktopAppState> = {},
): DesktopAppState {
  return { ...createEmptyDesktopAppState(), workspaces, ...extra };
}

const names = new Map([["claude-code-account-2", "Claude 2"]]);

test("a plain running thread reports running with the account name and workspace name", () => {
  const runs = mapActiveRuns(stateWith([workspace("ws-1", "Seher", [session("t-1")])]), names);
  expect(runs).toEqual([
    {
      threadId: "t-1",
      provider: "claude-code-account-2",
      accountLabel: "Claude 2",
      model: "claude-opus-5-5",
      workspaceName: "Seher",
      status: "running",
      startedAt: "2026-11-02T10:00:00.000Z",
      lastEventAt: "2026-11-02T10:05:00.000Z",
    },
  ]);
});

test("a running tool reports tool, an open dialog reports waiting", () => {
  const state = stateWith(
    [
      workspace("ws-1", "Seher", [
        session("tool", { currentStep: SECRET_STEP }),
        session("ask", { currentStep: SECRET_STEP }),
      ]),
    ],
    {
      sessionExtensionUiBySession: {
        "ws-1:ask": {
          instanceId: "x",
          statuses: [],
          widgets: [],
          notices: [],
          pendingDialogs: [{ id: "d" } as never],
        },
      },
    },
  );
  expect(mapActiveRuns(state, names).map((run) => [run.threadId, run.status])).toEqual([
    ["tool", "tool"],
    ["ask", "waiting"],
  ]);
});

test("idle and failed threads are left out; no running threads gives an empty list", () => {
  const state = stateWith([
    workspace("ws-1", "Seher", [
      session("idle", { status: "idle" }),
      session("failed", { status: "failed" }),
    ]),
  ]);
  expect(mapActiveRuns(state, names)).toEqual([]);
  expect(mapActiveRuns(createEmptyDesktopAppState(), names)).toEqual([]);
});

test("a worktree reports its project's name; unknown accounts fall back to the provider id", () => {
  const state = stateWith([
    workspace("root", "Pegasus", []),
    workspace(
      "wt",
      "pegasus-wt-7f3a",
      [session("t", { config: { provider: "openai", modelId: "gpt" }, runningSince: undefined })],
      { kind: "worktree", rootWorkspaceId: "root" },
    ),
  ]);
  const [run] = mapActiveRuns(state, names);
  expect(run).toMatchObject({
    workspaceName: "Pegasus",
    accountLabel: "openai",
    startedAt: "2026-11-02T10:05:00.000Z",
    lastEventAt: "2026-11-02T10:05:00.000Z",
  });
});

test("no title, preview, tool label, touched file or path leaves through the result", () => {
  const state = stateWith([
    workspace("ws-1", "Seher", [session("a", { currentStep: SECRET_STEP }), session("b")]),
  ]);
  const runs = mapActiveRuns(state, names);
  const json = JSON.stringify(runs);
  for (const secret of [SECRET_TITLE, SECRET_PREVIEW, SECRET_STEP, SECRET_PATH, "notes.md"]) {
    expect(json).not.toContain(JSON.stringify(secret).slice(1, -1));
  }
  expect(Object.keys(runs[0]!).sort()).toEqual([
    "accountLabel",
    "lastEventAt",
    "model",
    "provider",
    "startedAt",
    "status",
    "threadId",
    "workspaceName",
  ]);
});
