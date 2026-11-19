import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedTranscriptMessages,
} from "../helpers/electron-app";
import { captureProof, rect } from "../helpers/ui-chrome";

const TIMELINE_GAP = 16;

test("the scheduled-task chip keeps the timeline's row gap and the transcript column width", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [await makeWorkspace("scheduled-chip-rhythm")],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Chip rhythm thread");
    await seedTranscriptMessages(harness, window, { count: 2 });
    const state = await getDesktopState(window);
    await window.evaluate(
      async ({ workspaceId, sessionId }) => {
        await globalThis.window.piApp!.createScheduledTask({
          title: "Rhythm ping",
          instruction: "Say ping",
          schedule: { kind: "interval", everyMs: 60 * 60_000 },
          target: { kind: "existing-thread", workspaceId, sessionId },
        });
      },
      { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId },
    );
    const chip = window.getByTestId("scheduled-task-chip");
    await expect(chip).toBeVisible();

    const marginTop = await chip.evaluate((node) => getComputedStyle(node).marginTop);
    expect(marginTop).toBe(`${TIMELINE_GAP}px`);
    // Rows are spaced by the same gap.
    const rows = window.locator(".timeline__virtual-row");
    const first = await rect(rows.nth(0));
    const second = await rect(rows.nth(1));
    expect(Math.round(second.y - (first.y + first.height))).toBe(TIMELINE_GAP);

    // Same column as the transcript.
    const transcript = await rect(window.getByTestId("transcript"));
    const box = await rect(chip);
    expect(Math.round(box.x)).toBe(Math.round(transcript.x));
    expect(Math.round(box.width)).toBe(Math.round(transcript.width));
    await captureProof(window, "05-scheduled-chip.png");
  } finally {
    await harness.close();
  }
});
