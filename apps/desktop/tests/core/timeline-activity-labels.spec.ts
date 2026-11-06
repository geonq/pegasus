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

test("a turn's rows read as sentences and its thinking says how long it took", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-activity-labels");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const initial = await getDesktopState(window);
    const workspaceId = initial.selectedWorkspaceId ?? initial.workspaces[0]?.id;
    if (!workspaceId) throw new Error("No workspace available");
    await createSessionViaIpc(window, workspaceId, "Labels session");
    const state = await getDesktopState(window);
    const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
    const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
    if (!workspace || !session) throw new Error("Expected a selected session");
    const sessionRef: SessionRef = { workspaceId: workspace.id, sessionId: session.id };
    const runId = `labels-run-${Date.now()}`;
    const now = () => new Date().toISOString();

    await emitTestSessionEvents(harness, [
      {
        type: "sessionUpdated",
        sessionRef,
        timestamp: now(),
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
          updatedAt: now(),
          preview: "labels",
          runningRunId: runId,
        },
      },
      { type: "assistantThinkingDelta", sessionRef, timestamp: now(), runId, text: "Check git." },
    ]);
    const thinking = window.getByTestId("timeline-thinking");
    await expect(thinking).toHaveText("Thinking…");

    // The model thinks for over a second before its first tool call.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const tool = (callId: string, toolName: string, input: unknown): SessionDriverEvent => ({
      type: "toolStarted",
      sessionRef,
      timestamp: now(),
      runId,
      toolName,
      callId,
      input,
    });
    await emitTestSessionEvents(harness, [
      tool("c1", "project_shell", { command: "git status --short\ngit log -3" }),
      tool("c2", "project_read", { path: "shots/frame-001.png" }),
      tool("c3", "project_edit", { path: "src/app.ts", edits: [] }),
      tool("c4", "mcp__github__get_issue", { number: 7 }),
    ]);
    await expect(thinking).toHaveText(/^Thought for [12]s$/);
    const timeline = window.getByTestId("transcript");
    for (const label of [
      "Ran git status --short",
      "Looked at image frame-001.png",
      "Edited src/app.ts",
      "Get issue",
    ]) {
      await expect(timeline.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(timeline).not.toContainText("project_");
    await expect(timeline).not.toContainText("mcp__");

    // Finished reads and searches in a row fold into one row that opens to the calls.
    const done = (callId: string): SessionDriverEvent => ({
      type: "toolFinished",
      sessionRef,
      timestamp: now(),
      callId,
      success: true,
    });
    await emitTestSessionEvents(harness, [
      tool("c5", "project_read", { path: "README.md" }),
      done("c5"),
      tool("c6", "grep", { pattern: "render_ui" }),
      done("c6"),
      tool("c7", "project_read", { path: "AGENTS.md" }),
      done("c7"),
    ]);
    const group = window.getByTestId("timeline-tool-group");
    await expect(group).toHaveText("Explored 2 files, 1 search");
    await expect(timeline.getByText("Read README.md", { exact: true })).toHaveCount(0);
    await group.getByRole("button").click();
    await expect(group.getByText("Read README.md", { exact: true })).toBeVisible();
    await expect(group.getByText("Searched for render_ui", { exact: true })).toBeVisible();
    await window.screenshot({ path: test.info().outputPath("activity-labels.png") });
  } finally {
    await harness.close();
  }
});
