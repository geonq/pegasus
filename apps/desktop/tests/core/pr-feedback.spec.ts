import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  seedAgentDir,
  selectSidePanel,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

// Needs the network, a signed-in gh and a checkout whose branch tracks an open pull request
// (e.g. `gh pr checkout <n>` in a clone of any public repo), so it runs only when pointed at one.
const REPO = process.env.PEGASUS_PR_FEEDBACK_REPO ?? "";
const SHOTS = process.env.PI_REVIEW_SHOTS ?? "";

test("the review header shows the PR's checks and sends its feedback to the chat", async () => {
  test.skip(!REPO, "set PEGASUS_PR_FEEDBACK_REPO to a checkout on a pull request branch");
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [REPO],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, REPO);
    await createNamedThread(window, "PR task", { workspaceName: workspace.name });
    await selectSidePanel(window, "Review");
    const panel = window.getByRole("region", { name: "Review", exact: true });

    const status = panel.getByTestId("review-pr-feedback");
    await expect(status).toBeVisible({ timeout: 60_000 });
    await expect(status).toHaveText(/failing|Running|Passing|PR #\d+/);
    await expect(status).toHaveAttribute("aria-label", /^Pull request #\d+: /);
    await status.click();
    const dialog = panel.getByRole("dialog", { name: "Pull request feedback" });
    await expect(dialog.getByRole("button", { name: /^Pull request #\d+$/ })).toBeVisible();

    if (SHOTS) await window.screenshot({ path: join(SHOTS, "pr-feedback.png") });
    const send = dialog.getByRole("button", { name: "Send to chat" });
    test.skip(await send.isDisabled(), "this pull request has nothing failing and no comments");
    await send.click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await expect(window.getByText(/Feedback on pull request #\d+/).first()).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await harness.close();
  }
});
