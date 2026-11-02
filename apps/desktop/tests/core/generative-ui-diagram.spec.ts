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

const graph = {
  title: "How a message travels",
  blocks: [
    {
      type: "diagram",
      title: "Pegasus",
      nodes: [
        { id: "ui", label: "Renderer", group: "App", kind: "React", path: "src/app/App.tsx", description: "Draws the chat." },
        { id: "main", label: "Main process", group: "App", kind: "Electron" },
        { id: "driver", label: "Session driver", group: "Runtime" },
        { id: "pi", label: "pi SDK", group: "Runtime" },
      ],
      edges: [
        { from: "ui", to: "main", label: "IPC" },
        { from: "main", to: "driver" },
        { from: "driver", to: "pi" },
      ],
    },
    { type: "diagram", title: "Flow", mermaid: "flowchart LR\n  A[Prompt] --> B{Tool?}\n  B -->|yes| C[Run tool]\n  B -->|no| D[Reply]" },
  ],
};

test("an agent's diagram draws as a floorplan you can click, and Mermaid draws in cards and replies", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("generative-ui-diagram");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    const initial = await getDesktopState(window);
    const workspaceId = initial.selectedWorkspaceId ?? initial.workspaces[0]?.id;
    if (!workspaceId) throw new Error("No workspace available");
    await createSessionViaIpc(window, workspaceId, "Diagram session");
    const state = await getDesktopState(window);
    const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
    const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
    if (!workspace || !session) throw new Error("Expected a selected session");
    const sessionRef: SessionRef = { workspaceId: workspace.id, sessionId: session.id };
    const runId = `diagram-run-${Date.now()}`;
    const now = () => new Date().toISOString();
    const events: SessionDriverEvent[] = [
      {
        type: "sessionUpdated",
        sessionRef,
        timestamp: now(),
        runId,
        snapshot: {
          ref: sessionRef,
          workspace: { workspaceId: workspace.id, path: workspace.path, displayName: workspace.name },
          title: session.title,
          status: "running",
          updatedAt: now(),
          preview: "diagram",
          runningRunId: runId,
        },
      },
      { type: "toolStarted", sessionRef, timestamp: now(), runId, toolName: "show_ui", callId: "d1", input: { spec: graph } },
      { type: "toolFinished", sessionRef, timestamp: now(), callId: "d1", success: true, output: { content: [{ type: "text", text: "Shown." }] } },
      {
        type: "assistantDelta",
        sessionRef,
        timestamp: now(),
        runId,
        text: "Here is the loop:\n\n```mermaid\nsequenceDiagram\n  User->>Agent: prompt\n  Agent-->>User: reply\n```\n",
      },
    ];
    await emitTestSessionEvents(harness, events);

    const diagram = window.getByTestId("generative-ui-diagram").first();
    await expect(diagram.locator(".generative-ui__graph-lane text")).toHaveText(["App", "Runtime"]);
    await expect(diagram.locator(".generative-ui__graph-node")).toHaveCount(4);
    await expect(diagram.locator(".generative-ui__graph-edge")).toHaveCount(3);

    await diagram.locator('[data-node-id="ui"]').click();
    const details = window.getByTestId("generative-ui-diagram-details");
    await expect(details).toContainText("Renderer");
    await expect(details).toContainText("App · React");
    await expect(details).toContainText("Draws the chat.");
    await details.getByRole("button", { name: "Explain this" }).click();
    await expect(window.getByTestId("composer")).toHaveValue(/Explain "Renderer" \(src\/app\/App\.tsx\)/);

    // The graph can stay in view in the side panel while the chat goes on.
    await diagram.getByRole("button", { name: "Open in side panel" }).click();
    const panel = window.getByTestId("diagram-panel");
    await expect(panel.locator(".generative-ui__graph-node")).toHaveCount(4);
    await expect(panel.getByRole("button", { name: "Open in side panel" })).toHaveCount(0);
    // The frame takes the drawing's own shape in both places: no empty band, never squeezed flat.
    const [inChat, inPanel] = await Promise.all(
      [diagram, panel].map((scope) => scope.locator("svg.generative-ui__graph-canvas").boundingBox()),
    );
    expect(inChat!.height).toBeGreaterThan(120);
    expect(inChat!.height / inChat!.width).toBeCloseTo(inPanel!.height / inPanel!.width, 1);
    await diagram.screenshot({ path: test.info().outputPath("graph-card.png") });

    // Mermaid draws as SVG, both inside the card and inside a reply.
    const mermaid = window.getByTestId("transcript").getByTestId("generative-ui-mermaid");
    await expect(mermaid).toHaveCount(2, { timeout: 20_000 });
    await expect(mermaid.first().locator("svg")).toBeVisible();
    await expect(mermaid.first()).toContainText("Run tool");
    await expect(mermaid.nth(1)).toContainText("Agent");
    await expect(mermaid.locator("script")).toHaveCount(0);
    // Drawn at a readable size, not squeezed by the app's icon rules.
    for (const index of [0, 1]) {
      const box = await mermaid.nth(index).locator("svg").boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(150);
    }
    await window.screenshot({ path: test.info().outputPath("diagram.png"), fullPage: true });
  } finally {
    await harness.close();
  }
});
