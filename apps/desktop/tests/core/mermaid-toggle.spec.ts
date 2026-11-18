import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  emitTestSessionEvents,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { copiedTexts, stubClipboard } from "../helpers/clipboard";

const proofDir = process.env.PI_APP_UI_SMALL_PROOF_DIR;
const SOURCE = "sequenceDiagram\n  User->>Agent: prompt\n  Agent-->>User: reply";

test("a Mermaid block toggles between diagram and code and copies its source", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("mermaid-toggle-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Mermaid toggle thread");
    const state = await getDesktopState(window);
    const sessionRef: SessionRef = {
      workspaceId: state.selectedWorkspaceId,
      sessionId: state.selectedSessionId,
    };
    const events: SessionDriverEvent[] = [
      {
        type: "assistantDelta",
        sessionRef,
        timestamp: new Date().toISOString(),
        runId: "mermaid-toggle-run",
        text: `Here is the loop:\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n`,
      },
    ];
    await emitTestSessionEvents(harness, events);

    const block = window.getByTestId("generative-ui-mermaid-block");
    const toggle = block.getByTestId("mermaid-toggle");
    await expect(block.getByTestId("generative-ui-mermaid")).toBeVisible({ timeout: 20_000 });
    await expect(toggle).toHaveText("Show code");
    await expect(block.getByTestId("mermaid-source")).toHaveCount(0);
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await block.screenshot({ path: join(proofDir, "03-mermaid-diagram.png") });
    }

    await toggle.click();
    await expect(toggle).toHaveText("Show diagram");
    await expect(block.getByTestId("mermaid-source")).toHaveText(SOURCE);
    await expect(block.getByTestId("generative-ui-mermaid")).toHaveCount(0);
    if (proofDir) await block.screenshot({ path: join(proofDir, "03-mermaid-code.png") });

    await stubClipboard(window);
    await block.getByTestId("mermaid-copy").click();
    await expect(block.getByTestId("mermaid-copy")).toHaveAttribute("aria-label", "Copied");
    expect(await copiedTexts(window)).toEqual([SOURCE]);

    await toggle.click();
    await expect(toggle).toHaveText("Show code");
    await expect(block.getByTestId("generative-ui-mermaid")).toBeVisible();
  } finally {
    await harness.close();
  }
});
