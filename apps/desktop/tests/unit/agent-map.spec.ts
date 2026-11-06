import { expect, test } from "@playwright/test";
import { sessionAgentActivity } from "../../contracts/agent-activity";
import { createEmptyDesktopAppState, type DesktopAppState } from "../../contracts/desktop-state";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { validateRemoteDesktopInvocation } from "../../electron/remote/remote-desktop-policy";
import { agentAreas, agentCards } from "../../src/features/workbench/agents-panel";

const tool = (
  id: string,
  toolName: string,
  input: unknown,
  status: "running" | "success" | "error",
  label = id,
): TranscriptMessage => ({
  kind: "tool",
  id,
  callId: id,
  toolName,
  status,
  label,
  input,
  createdAt: "2026-11-02T12:00:00.000Z",
});

test("an agent's step is its running tool and its files are what it changed", () => {
  const transcript = [
    tool("a", "project_edit", { path: "src/app.ts" }, "success"),
    tool("b", "project_write", { path: String.raw`src\new.ts` }, "success"),
    tool("c", "project_edit", { path: "src/broken.ts" }, "error"),
    tool("d", "project_read", { path: "README.md" }, "success"),
    tool("e", "project_edit", { path: "src/app.ts" }, "success"),
    tool("f", "project_shell", { command: "npm test" }, "running", "Ran npm test"),
  ];
  expect(sessionAgentActivity(transcript, "running")).toEqual({
    currentStep: "Ran npm test",
    touchedFiles: ["src/app.ts", "src/new.ts"],
  });
  // A finished session has no current step.
  expect(sessionAgentActivity(transcript, "idle").currentStep).toBeUndefined();
});

test("the map nests agents under their chat and flags an area two agents changed", () => {
  const state: DesktopAppState = {
    ...createEmptyDesktopAppState(),
    workspaces: [
      {
        id: "w",
        name: "Pegasus",
        path: "D:/Pi/pi-gui",
        sessions: [
          {
            id: "lead",
            title: "Lead",
            status: "idle",
            updatedAt: "",
            preview: "",
            hasUnseenUpdate: false,
          },
          {
            id: "c1",
            title: "Docs",
            status: "running",
            updatedAt: "",
            preview: "",
            hasUnseenUpdate: false,
            touchedFiles: ["docs/a.md", "src/ui/x.ts"],
            config: { modelId: "gpt-6-luna" },
          },
          {
            id: "c2",
            title: "Tests",
            status: "running",
            updatedAt: "",
            preview: "",
            hasUnseenUpdate: false,
            touchedFiles: ["src/ui/y.ts"],
          },
          {
            id: "quiet",
            title: "Old chat",
            status: "idle",
            updatedAt: "",
            preview: "",
            hasUnseenUpdate: false,
          },
        ],
      } as never,
    ],
    orchestrationChildren: ["c1", "c2"].map((id) => ({
      id: `child-${id}`,
      parentWorkspaceId: "w",
      parentSessionId: "lead",
      childWorkspaceId: "w",
      childSessionId: id,
      title: id === "c1" ? "Docs" : "Tests",
      goal: "",
      role: id === "c1" ? "implementer" : "reviewer",
      status: "running" as const,
      latestTranscript: "",
      transcript: [],
      evidence: [],
      createdAt: "",
      updatedAt: "",
    })),
  };
  const cards = agentCards(state);
  expect(cards.map((card) => [card.key, card.parentKey, card.role, card.model])).toEqual([
    ["w/lead", undefined, undefined, undefined],
    ["w/c1", "w/lead", "implementer", "gpt-6-luna"],
    ["w/c2", "w/lead", "reviewer", undefined],
  ]);
  expect(
    agentAreas(cards).map(({ area, agents }) => [area, agents.map((agent) => agent.title)]),
  ).toEqual([
    ["src/ui", ["Docs", "Tests"]],
    ["docs", ["Docs"]],
  ]);
});

test("the Mac client may stop one of its allowed chats by name", () => {
  const scope = new Set(["w"]);
  expect(validateRemoteDesktopInvocation("cancelCurrentRun", [], scope).args).toEqual([]);
  expect(
    validateRemoteDesktopInvocation(
      "cancelCurrentRun",
      [{ workspaceId: "w", sessionId: "s" }],
      scope,
    ).args,
  ).toEqual([{ workspaceId: "w", sessionId: "s" }]);
  for (const args of [
    [{ workspaceId: "other", sessionId: "s" }],
    [{ workspaceId: "w", sessionId: "s", extra: 1 }],
    ["w"],
  ]) {
    expect(() => validateRemoteDesktopInvocation("cancelCurrentRun", args, scope)).toThrow();
  }
});
