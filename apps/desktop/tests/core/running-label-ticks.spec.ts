/**
 * The header's "Working for 12s" counts up once a second by writing its own text node. The app
 * shell must not re-render per tick: over 3.5 s of an otherwise quiet run, App renders at most
 * once (a stray state echo), never three or four times.
 */
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createSessionViaIpc,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const SHOTS = process.env.PI_APP_SHOTS_DIR?.trim();

test("the running label ticks without re-rendering the app", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("running-label-ticks");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createSessionViaIpc(window, workspacePath, "ticking");
    await selectSession(window, "ticking");
    const state = await getDesktopState(window);
    const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId)!;
    const session = workspace.sessions.find((entry) => entry.id === state.selectedSessionId)!;
    const sessionRef: SessionRef = { workspaceId: workspace.id, sessionId: session.id };
    const runId = `tick-${Date.now()}`;
    const startedAt = new Date().toISOString();
    const event: SessionDriverEvent = {
      type: "sessionUpdated",
      sessionRef,
      timestamp: startedAt,
      runId,
      snapshot: {
        ref: sessionRef,
        workspace: { workspaceId: workspace.id, path: workspace.path, displayName: workspace.name },
        title: session.title,
        status: "running",
        updatedAt: startedAt,
        preview: "start",
        runningRunId: runId,
      },
    };
    await emitTestSessionEvent(harness, event);
    await emitTestSessionEvent(harness, {
      type: "toolStarted",
      sessionRef,
      timestamp: new Date().toISOString(),
      runId,
      toolName: "bash",
      callId: "call-tick",
      input: { command: "sleep 30" },
    });
    const toolElapsed = window.getByTestId("tool-elapsed");
    await expect(toolElapsed).toHaveText(/^ · \d+s$/);

    const label = window.getByTestId("running-label");
    await expect(label).toHaveText(/^Working for \d+s$/);
    await window.waitForTimeout(800);
    await window.evaluate(() => {
      (globalThis as { __piRenderCounts?: Record<string, number> }).__piRenderCounts = {};
    });
    const before = await label.textContent();
    const toolBefore = await toolElapsed.textContent();
    await window.waitForTimeout(3_500);
    const after = await label.textContent();
    const toolAfter = await toolElapsed.textContent();
    const counts = await window.evaluate(
      () => (globalThis as { __piRenderCounts?: Record<string, number> }).__piRenderCounts ?? {},
    );
    console.log(`RUNNING_LABEL ${before} -> ${after} renders ${JSON.stringify(counts)}`);

    // The label moved on by about three seconds...
    const seconds = (text: string | null) => Number(/(\d+)s$/.exec(text ?? "")?.[1] ?? NaN);
    expect(seconds(after) - seconds(before)).toBeGreaterThanOrEqual(3);
    expect(seconds(toolAfter) - seconds(toolBefore)).toBeGreaterThanOrEqual(3);
    // The running tool row counted up without a single timeline row render.
    const rowRenders = Object.entries(counts)
      .filter(([key]) => key.startsWith("timeline-row:"))
      .reduce((sum, [, value]) => sum + value, 0);
    expect(rowRenders).toBe(0);
    // ...while App rendered at most once in that window.
    expect(counts.app ?? 0).toBeLessThanOrEqual(1);

    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true });
      await window.screenshot({ path: `${SHOTS}/running-label.png` });
    }
  } finally {
    await harness.close();
  }
});
