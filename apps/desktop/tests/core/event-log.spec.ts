/**
 * The event log (electron/diagnostics) in a real app: a run that streams, calls a tool and fails
 * leaves a handful of lines in <userData>/logs/events.ndjson, with totals instead of one line per
 * token, and the failure arrives with the session events that led up to it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createSessionViaIpc,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

type Line = Record<string, unknown>;

async function readLines(userDataDir: string): Promise<Line[]> {
  const text = await readFile(join(userDataDir, "logs", "events.ndjson"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

test("a failed run leaves a few structured lines with totals and context", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("event-log");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createSessionViaIpc(window, workspacePath, "logged run");
    await selectSession(window, "logged run");
    const state = await getDesktopState(window);
    const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId)!;
    const session = workspace.sessions.find((entry) => entry.id === state.selectedSessionId)!;
    const sessionRef: SessionRef = { workspaceId: workspace.id, sessionId: session.id };
    const runId = `event-log-${Date.now()}`;
    const base = { sessionRef, runId, timestamp: new Date().toISOString() };
    const emit = (event: SessionDriverEvent) =>
      harness.electronApp.evaluate(async (_, payload) => {
        const hooks = (
          globalThis as {
            __PI_APP_TEST_HOOKS?: { emitSessionEvent?: (event: SessionDriverEvent) => Promise<void> };
          }
        ).__PI_APP_TEST_HOOKS;
        await hooks!.emitSessionEvent!(payload);
      }, event);

    await emit({
      ...base,
      type: "sessionUpdated",
      snapshot: {
        ref: sessionRef,
        workspace: { workspaceId: workspace.id, path: workspace.path, displayName: workspace.name },
        title: session.title,
        status: "running",
        updatedAt: new Date().toISOString(),
        runningRunId: runId,
      },
    });
    for (let index = 0; index < 50; index += 1) {
      await emit({ ...base, type: "assistantDelta", text: `token ${index} ` });
    }
    await emit({ ...base, type: "toolStarted", toolName: "bash", callId: "call-1" });
    await emit({ ...base, type: "toolFinished", callId: "call-1", success: true });
    await emit({ ...base, type: "runFailed", error: { message: "provider overloaded", code: "529" } });

    // Lines reach the file within the 250 ms batch window.
    await expect
      .poll(async () => (await readLines(userDataDir)).some((line) => line.k === "run.failed"))
      .toBe(true);
    const lines = await readLines(userDataDir);
    expect(lines[0]).toMatchObject({ k: "app.start", src: "main" });
    const run = lines.filter((line) => line.s === session.id);
    expect(run.map((line) => line.k)).toEqual(
      expect.arrayContaining(["run.start", "tool.end", "run.failed"]),
    );
    // 50 tokens, no token lines.
    expect(run.filter((line) => String(line.k).includes("delta"))).toHaveLength(0);
    expect(run.find((line) => line.k === "run.failed")).toMatchObject({
      l: "e",
      r: runId,
      deltas: 50,
      tools: 1,
      msg: "provider overloaded",
      code: "529",
    });
    expect(run.find((line) => line.k === "tool.end")).toMatchObject({ tool: "bash" });
    // The failure carries what came just before it, marked as context.
    const failedAt = lines.findIndex((line) => line.k === "run.failed");
    expect(lines.slice(0, failedAt).some((line) => line.ctx === 1 && line.k === "tool.start")).toBe(true);
  } finally {
    await harness.close();
  }
});
