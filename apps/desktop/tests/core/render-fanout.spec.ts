/**
 * A streamed token must re-render only what shows it: the growing timeline row and the one
 * sidebar row of the running session. Other sidebar rows and finished timeline rows must not.
 * Components report renders through `globalThis.__piRenderCounts` (src/lib/render-count.ts).
 */
import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createSessionViaIpc,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
  selectSession,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("a streamed token re-renders one timeline row and one sidebar row", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("render-fanout");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    for (const title of ["idle one", "idle two", "idle three", "streaming"]) {
      await createSessionViaIpc(window, workspacePath, title);
    }
    await selectSession(window, "streaming");
    await seedTranscriptMessages(harness, window, { count: 12 });

    const state = await getDesktopState(window);
    const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId)!;
    const session = workspace.sessions.find((entry) => entry.id === state.selectedSessionId)!;
    const sessionRef: SessionRef = { workspaceId: workspace.id, sessionId: session.id };
    const workspaceRef = {
      workspaceId: workspace.id,
      path: workspace.path,
      displayName: workspace.name,
    };
    const runId = `fanout-${Date.now()}`;
    const emit = (event: SessionDriverEvent) =>
      harness.electronApp.evaluate(async (_, payload) => {
        const hooks = (
          globalThis as {
            __PI_APP_TEST_HOOKS?: {
              emitSessionEvent?: (event: SessionDriverEvent) => Promise<void>;
            };
          }
        ).__PI_APP_TEST_HOOKS;
        await hooks!.emitSessionEvent!(payload);
      }, event);
    const running = (preview: string): SessionDriverEvent => ({
      type: "sessionUpdated",
      sessionRef,
      timestamp: new Date().toISOString(),
      runId,
      snapshot: {
        ref: sessionRef,
        workspace: workspaceRef,
        title: session.title,
        status: "running",
        updatedAt: new Date().toISOString(),
        preview,
        runningRunId: runId,
      },
    });

    // Start the run and let the first rows settle, then count only the streaming window.
    await emit(running("start"));
    await emit({
      type: "assistantDelta",
      sessionRef,
      timestamp: new Date().toISOString(),
      runId,
      text: "first ",
    });
    await expect(window.locator('[data-session-id]')).toHaveCount(4);
    await window.waitForTimeout(600);
    await window.evaluate(() => {
      (globalThis as { __piRenderCounts?: Record<string, number> }).__piRenderCounts = {};
    });

    const tokens = 40;
    for (let index = 0; index < tokens; index += 1) {
      await emit({
        type: "assistantDelta",
        sessionRef,
        timestamp: new Date().toISOString(),
        runId,
        text: `tok${index} `,
      });
      await emit(running(`tok${index}`));
    }
    await window.waitForTimeout(800);
    const counts = await window.evaluate(
      () => (globalThis as { __piRenderCounts?: Record<string, number> }).__piRenderCounts ?? {},
    );
    console.log("RENDER_COUNTS " + JSON.stringify(counts));

    const threadRows = Object.entries(counts).filter(([key]) => key.startsWith("thread-row:"));
    const timelineRows = Object.entries(counts).filter(([key]) => key.startsWith("timeline-row:"));
    const streamingRow = counts[`thread-row:${session.id}`] ?? 0;
    const otherThreadRenders = threadRows
      .filter(([key]) => key !== `thread-row:${session.id}`)
      .reduce((sum, [, value]) => sum + value, 0);
    const timelineRenderTotal = timelineRows.reduce((sum, [, value]) => sum + value, 0);
    const busiestTimelineRow = Math.max(0, ...timelineRows.map(([, value]) => value));

    // The running session's own row follows its preview; no other sidebar row renders at all.
    expect(streamingRow).toBeGreaterThan(0);
    expect(otherThreadRenders).toBe(0);
    // Only the growing row renders: 12 seeded rows plus the streamed one would otherwise all count.
    expect(timelineRows.length).toBeLessThanOrEqual(2);
    expect(busiestTimelineRow).toBeGreaterThan(0);
    expect(timelineRenderTotal).toBeLessThanOrEqual(tokens * 2 + 4);
  } finally {
    await harness.close();
  }
});
