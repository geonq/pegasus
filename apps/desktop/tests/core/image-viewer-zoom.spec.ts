import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const proofDir = process.env.PI_APP_UI_SMALL_PROOF_DIR;
// A 4x4 orange PNG; shown twice so the viewer has a previous/next to step through.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP478AARwzEcQAWohPx03ZM6QAAAABJRU5ErkJggg==";

async function selectedSessionRef(window: Page): Promise<SessionRef> {
  const state = await getDesktopState(window);
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

test("the image viewer zooms to 8x, pans, toggles 100% and steps through the chat's images", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("image-viewer-zoom-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Image zoom thread");
    const sessionRef = await selectedSessionRef(window);
    const timestamp = new Date().toISOString();
    const started: Extract<SessionDriverEvent, { type: "toolStarted" }> = {
      type: "toolStarted",
      sessionRef,
      timestamp,
      toolName: "read",
      callId: "zoom-call",
      input: { path: "shot.png" },
    };
    await emitTestSessionEvent(harness, started);
    await emitTestSessionEvent(harness, {
      type: "toolFinished",
      sessionRef,
      timestamp,
      callId: "zoom-call",
      success: true,
      output: {
        content: [
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        ],
      },
    } satisfies Extract<SessionDriverEvent, { type: "toolFinished" }>);

    await window.getByRole("button", { name: "View read image 2" }).click({ timeout: 15_000 });
    const viewer = window.getByTestId("image-viewer");
    const image = window.getByTestId("image-viewer-image");
    await expect(viewer).toBeVisible();
    await expect(window.getByTestId("image-viewer-count")).toHaveText("2 / 2");
    await expect(image).toHaveAttribute("data-zoom", "1.000");

    // Arrow keys and buttons step through every image in the chat.
    await window.keyboard.press("ArrowLeft");
    await expect(window.getByTestId("image-viewer-count")).toHaveText("1 / 2");
    await viewer.getByRole("button", { name: "Next image" }).click();
    await expect(window.getByTestId("image-viewer-count")).toHaveText("2 / 2");

    // Wheel zoom grows with each notch and is capped at 8x.
    const box = (await image.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.wheel(0, -300);
    await expect
      .poll(async () => Number(await image.getAttribute("data-zoom")))
      .toBeGreaterThan(1.5);
    for (let step = 0; step < 12; step += 1) await window.mouse.wheel(0, -600);
    await expect(image).toHaveAttribute("data-zoom", "8.000");

    // Dragging pans a zoomed image.
    const before = (await image.boundingBox())!;
    const centre = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    await window.mouse.move(centre.x, centre.y);
    await window.mouse.down();
    await window.mouse.move(centre.x + 40, centre.y + 25, { steps: 5 });
    await window.mouse.up();
    const after = (await image.boundingBox())!;
    expect(Math.round(after.x - before.x)).toBe(40);
    expect(Math.round(after.y - before.y)).toBe(25);
    await expect(window.getByTestId("image-viewer-zoom")).toHaveText("800%");
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await window.screenshot({ path: join(proofDir, "02-image-viewer-zoom.png") });
    }

    // Double-click returns to fit; double-click again goes to the image's own size.
    await image.dblclick({ position: { x: 4, y: 4 } });
    await expect(image).toHaveAttribute("data-zoom", "1.000");
    await image.dblclick();
    await expect.poll(async () => Number(await image.getAttribute("data-zoom"))).toBeGreaterThan(1);
    await image.dblclick();
    await expect(image).toHaveAttribute("data-zoom", "1.000");

    // Stepping resets the zoom.
    await window.mouse.wheel(0, -400);
    await window.keyboard.press("ArrowLeft");
    await expect(image).toHaveAttribute("data-zoom", "1.000");

    await window.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
