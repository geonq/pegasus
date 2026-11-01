import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createSessionViaIpc,
  emitTestSessionEvents,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("shows model thinking as quiet collapsed rows between tool calls and expands on click", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-thinking");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const initial = await getDesktopState(window);
    const workspaceId = initial.selectedWorkspaceId ?? initial.workspaces[0]?.id;
    if (!workspaceId) throw new Error("No workspace available");
    await createSessionViaIpc(window, workspaceId, "Thinking session");

    const state = await getDesktopState(window);
    const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
    const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
    if (!workspace || !session) throw new Error("Expected a selected session");
    const sessionRef: SessionRef = { workspaceId: workspace.id, sessionId: session.id };
    const runId = `thinking-run-${Date.now()}`;
    const at = (offset: number) => new Date(Date.now() + offset).toISOString();

    const events: SessionDriverEvent[] = [
      {
        type: "sessionUpdated",
        sessionRef,
        timestamp: at(0),
        runId,
        snapshot: {
          ref: sessionRef,
          workspace: {
            workspaceId: workspace.id,
            path: workspace.path,
            displayName: workspace.name,
          },
          title: session.title,
          status: "running",
          updatedAt: at(0),
          preview: "thinking",
          runningRunId: runId,
        },
      },
      { type: "assistantThinkingDelta", sessionRef, timestamp: at(1), runId, text: "Plan: read " },
      { type: "assistantThinkingDelta", sessionRef, timestamp: at(2), runId, text: "the config." },
      {
        type: "toolStarted",
        sessionRef,
        timestamp: at(3),
        runId,
        toolName: "read",
        callId: "call-1",
        input: { path: "config.json" },
      },
      { type: "assistantThinkingDelta", sessionRef, timestamp: at(4), runId, text: "   " },
      {
        type: "assistantThinkingDelta",
        sessionRef,
        timestamp: at(5),
        runId,
        text: "Config read, now answer.",
      },
      { type: "assistantDelta", sessionRef, timestamp: at(6), runId, text: "All done." },
    ];
    await emitTestSessionEvents(harness, events);

    const rows = window.getByTestId("timeline-thinking");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Thought");
    await expect(rows.first().getByTestId("timeline-thinking-body")).toHaveCount(0);
    await expect(rows.first().getByRole("button")).toHaveAttribute("aria-expanded", "false");
    await expect(window.getByText("Plan: read the config.")).toHaveCount(0);

    await rows.first().getByRole("button").click();
    await expect(rows.first().getByTestId("timeline-thinking-body")).toHaveText(
      "Plan: read the config.",
    );
    await expect(rows.nth(1).getByTestId("timeline-thinking-body")).toHaveCount(0);

    await rows.first().getByRole("button").click();
    await expect(rows.first().getByTestId("timeline-thinking-body")).toHaveCount(0);

    await rows.nth(1).getByRole("button").click();
    await expect(rows.nth(1).getByTestId("timeline-thinking-body")).toHaveText(
      "Config read, now answer.",
    );
    await expect(window.getByText("All done.")).toBeVisible();
  } finally {
    await harness.close();
  }
});
