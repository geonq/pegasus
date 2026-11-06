import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  desktopShortcut,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("model analytics separates unlimited usage and shows measured model efficiency", async () => {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspace = await makeWorkspace("model-analytics");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sessionDir = join(agentDir, "sessions", "analytics-fixture");
  await mkdir(sessionDir, { recursive: true });
  const models = [
    "deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v4.1-flash-1017",
    "z-ai/glm-5.3-flash",
  ];
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        openscale: {
          baseUrl: "http://127.0.0.1:9/never-contact",
          api: "anthropic-messages",
          apiKey: "sk-openscale-plan-LOCAL_TEST_CANARY",
          models: models.map((id) => ({ id, name: id, contextWindow: 128000, maxTokens: 4096 })),
        },
      },
    }),
  );
  for (const model of models) {
    const manager = SessionManager.create(workspace, sessionDir);
    manager.appendMessage({
      role: "user",
      content: "Synthetic analytics fixture",
      timestamp: Date.now() - 5000,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Fixture complete" }],
      api: "anthropic-messages",
      provider: "openscale",
      model,
      timestamp: Date.now() - 1000,
      stopReason: "stop",
      usage: {
        input: 100,
        output: 200,
        cacheRead: 900,
        cacheWrite: 0,
        totalTokens: 1200,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  }
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const page = await harness.firstWindow();
    await waitForWorkspaceByPath(page, workspace);
    await page.getByTestId("sidebar-usage").click();
    await page.getByRole("button", { name: "Model analytics", exact: true }).click();
    const analytics = page.getByRole("region", { name: "Model analytics", exact: true });
    await expect(analytics.getByText(/Unlimited plan key/)).toBeVisible();
    await expect(analytics.locator("tbody tr")).toHaveCount(3);
    await expect(analytics.locator("tbody tr").first()).toContainText("90%");
    await expect(analytics.locator("tbody tr").first()).toContainText("5:1");
    await expect(analytics.locator("tbody th svg")).toHaveCount(3);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.keyboard.press(desktopShortcut(","));
      await expect(page.getByTestId("settings-surface")).toBeVisible();
      await page.getByRole("button", { name: "Appearance", exact: true }).click();
      await page
        .getByRole("radio", { name: colorScheme === "light" ? "Light" : "Dark", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await page.getByTestId("sidebar-usage").click();
      await page.getByRole("button", { name: "Model analytics", exact: true }).click();
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: test.info().outputPath(`analytics-${colorScheme}.png`) });
    }
    await page.setViewportSize({ width: 800, height: 700 });
    await expect(analytics.getByRole("columnheader", { name: "Model", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("analytics-narrow.png") });
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await expect(page.getByRole("region", { name: "Totals", exact: true })).toBeVisible();
  } finally {
    await harness.close();
  }
});
