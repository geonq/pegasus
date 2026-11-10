import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  commitAllInGitRepo,
  desktopShortcut,
  getDesktopState,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
  selectSession,
  startThreadViaIpc,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("switches between app-global and per-repo model scope while worktrees inherit root repo settings", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspaceA = await makeWorkspace("model-scope-a");
  const workspaceB = await makeWorkspace("model-scope-b");
  await initGitRepo(workspaceA);
  await commitAllInGitRepo(workspaceA, "init");
  await seedAgentDir(agentDir);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspaceA, workspaceB],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const rootWorkspaceA = await waitForWorkspaceByPath(window, workspaceA);
    const rootWorkspaceB = await waitForWorkspaceByPath(window, workspaceB);

    await createNamedThread(window, "Repo A global session", {
      workspaceName: rootWorkspaceA.name,
    });
    await expect(window.locator(".chat-header__title")).toHaveText("Repo A global session");
    await expectComposerModelState(window, {
      activeModel: "OpenAI · GPT-6.1 Sol",
      visibleModelLabels: ["GPT-6.1 Sol", "GPT-6 Luna"],
      hiddenModelLabels: ["GPT-5.6 Terra"],
    });

    await createNamedThread(window, "Repo B global session", {
      workspaceName: rootWorkspaceB.name,
    });
    await expect(window.locator(".chat-header__title")).toHaveText("Repo B global session");
    await expectComposerModelState(window, {
      activeModel: "OpenAI · GPT-6.1 Sol",
      visibleModelLabels: ["GPT-6.1 Sol", "GPT-6 Luna"],
      hiddenModelLabels: ["GPT-5.6 Terra"],
    });

    await openSettings(window);
    await openSettingsSection(window, "Models");
    await expect(settingsWorkspacePicker(window)).toHaveCount(0);
    await expect(window.getByLabel("Default model", { exact: true })).toHaveValue("openai:gpt-6.1-sol");

    await openSettingsSection(window, "General");
    await window.getByRole("button", { name: "Per repo" }).click();
    await expect
      .poll(async () => (await getDesktopState(window)).modelSettingsScopeMode)
      .toBe("per-repo");

    await openSettingsSection(window, "Models");
    await expect(settingsWorkspacePicker(window)).toHaveCount(1);
    await expect(settingsWorkspacePicker(window).locator("option")).toHaveCount(2);
    await settingsWorkspacePicker(window).selectOption({ label: rootWorkspaceA.name });
    await expect(settingsWorkspacePicker(window)).toHaveValue(rootWorkspaceA.id);
    await expect(window.getByLabel("Default model", { exact: true })).toHaveValue("openai:gpt-6.1-sol");
    await setEnabledModels(window, ["openai/gpt-6-luna", "openai/gpt-5.6-terra"], ["openai/gpt-6.1-sol"]);
    await window.getByLabel("Default model", { exact: true }).selectOption("openai:gpt-6-luna");
    await expect(window.getByLabel("Default model", { exact: true })).toHaveValue("openai:gpt-6-luna");

    await settingsWorkspacePicker(window).selectOption({ label: rootWorkspaceB.name });
    await expect(window.getByLabel("Default model", { exact: true })).toHaveValue("openai:gpt-6.1-sol");

    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await selectSession(window, "Repo B global session");
    await expectComposerModelState(window, {
      activeModel: "OpenAI · GPT-6.1 Sol",
      visibleModelLabels: ["GPT-6.1 Sol", "GPT-6 Luna"],
      hiddenModelLabels: ["GPT-5.6 Terra"],
    });

    await startThreadViaIpc(window, {
      workspaceName: rootWorkspaceA.name,
      environment: "worktree",
      prompt: "",
      provider: "openai",
      modelId: "gpt-6-luna",
    });
    await expect(window.locator(".chat-header__title")).toHaveText("New thread");
    await expectComposerModelState(window, {
      activeModel: "OpenAI · GPT-6 Luna",
      visibleModelLabels: ["GPT-6 Luna", "GPT-5.6 Terra"],
      hiddenModelLabels: ["GPT-6.1 Sol"],
    });

    await openNewThread(window);
    await expect(window.locator(".new-thread__workspace")).toHaveValue(rootWorkspaceA.id);
    await expectNewThreadModelState(window, {
      activeModel: "OpenAI · GPT-6 Luna",
      visibleModelLabels: ["GPT-6 Luna", "GPT-5.6 Terra"],
      hiddenModelLabels: ["GPT-6.1 Sol"],
    });
    await window.locator(".session-row--active .session-row__select").first().click();
    await expect(window.getByTestId("new-thread-composer")).toHaveCount(0);

    await selectComposerModel(window, "GPT-5.6 Terra");
    await expect(
      window.getByRole("button", { name: "OpenAI · GPT-5.6 Terra" }).first(),
    ).toBeVisible();

    await openSettings(window);
    await openSettingsSection(window, "Models");
    await expect(settingsWorkspacePicker(window).locator("option")).toHaveCount(2);
    expect(
      (await settingsWorkspacePicker(window).locator("option").allTextContents()).every(
        (text) => !/Worktree/i.test(text),
      ),
    ).toBeTruthy();
    await setEnabledModels(window, ["openai/gpt-6.1-sol", "openai/gpt-5.6-terra"], ["openai/gpt-6-luna"]);
    await window.getByLabel("Default model", { exact: true }).selectOption("openai:gpt-6.1-sol");
    await expect(window.getByLabel("Default model", { exact: true })).toHaveValue("openai:gpt-6.1-sol");

    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect(
      window.getByRole("button", { name: "OpenAI · GPT-5.6 Terra" }).first(),
    ).toBeVisible();
    await expectComposerModelOptions(window, {
      visibleModelLabels: ["GPT-6.1 Sol", "GPT-5.6 Terra"],
      hiddenModelLabels: ["GPT-6 Luna"],
    });

    const composer = window.getByTestId("composer");
    await composer.fill("/model");
    const optionsMenu = window.getByTestId("slash-options-menu");
    await expect(optionsMenu).toBeVisible();
    await expect(optionsMenu).toContainText("GPT-6.1 Sol");
    await expect(optionsMenu).toContainText("GPT-5.6 Terra");
    await expect(optionsMenu).not.toContainText("GPT-6 Luna");
  } finally {
    await harness.close();
  }
});

async function openSettings(window: Page): Promise<void> {
  await window.keyboard.press(desktopShortcut(","));
  await expect(window.getByTestId("settings-surface")).toBeVisible();
}

async function openSettingsSection(window: Page, section: "General" | "Models"): Promise<void> {
  await window.getByRole("button", { name: section, exact: true }).click();
  await expect(window.locator(".view-header__title")).toContainText(section);
}

async function setEnabledModel(window: Page, pattern: string, enabled: boolean): Promise<void> {
  const [, modelId = pattern] = pattern.split("/");
  const searchInput = window.getByLabel("Search models");
  await searchInput.fill(modelId);
  const toggle = window.getByRole("switch", { name: `Enable ${pattern}`, exact: true });
  await expect(toggle).toBeVisible();
  if ((await toggle.isChecked()) !== enabled) {
    await toggle.click();
  }
  await expect(toggle).toHaveJSProperty("checked", enabled);
  await searchInput.fill("");
}

async function setEnabledModels(
  window: Page,
  enable: readonly string[],
  disable: readonly string[],
): Promise<void> {
  for (const pattern of enable) {
    await setEnabledModel(window, pattern, true);
  }
  for (const pattern of disable) {
    await setEnabledModel(window, pattern, false);
  }
}

async function expectComposerModelState(
  window: Page,
  expectations: {
    readonly activeModel: string;
    readonly visibleModelLabels: readonly string[];
    readonly hiddenModelLabels: readonly string[];
  },
): Promise<void> {
  await expect(
    window.getByRole("button", { name: expectations.activeModel }).first(),
  ).toBeVisible();
  await expectModelOptions(window, ".composer__bar", expectations);
}

async function expectComposerModelOptions(
  window: Page,
  expectations: {
    readonly visibleModelLabels: readonly string[];
    readonly hiddenModelLabels: readonly string[];
  },
): Promise<void> {
  await expectModelOptions(window, ".composer__bar", expectations);
}

async function expectNewThreadModelState(
  window: Page,
  expectations: {
    readonly activeModel: string;
    readonly visibleModelLabels: readonly string[];
    readonly hiddenModelLabels: readonly string[];
  },
): Promise<void> {
  await expect(
    window.getByRole("button", { name: expectations.activeModel }).first(),
  ).toBeVisible();
  await expectModelOptions(window, ".new-thread__hint", expectations);
}

async function expectModelOptions(
  window: Page,
  scopeSelector: string,
  expectations: {
    readonly visibleModelLabels: readonly string[];
    readonly hiddenModelLabels: readonly string[];
  },
): Promise<void> {
  const scope = window.locator(scopeSelector).first();
  const badge = scope.locator(".model-selector__badge").first();
  await badge.click();
  const dropdown = scope.locator(".model-selector__dropdown").first();
  await expect(dropdown).toBeVisible();
  const option = (label: string) => dropdown.getByRole("button", { name: label, exact: true });
  for (const label of expectations.visibleModelLabels) {
    await expect(option(label)).toBeVisible();
  }
  for (const label of expectations.hiddenModelLabels) {
    await expect(option(label)).toHaveCount(0);
  }
  await window.keyboard.press("Escape");
  await expect(dropdown).toHaveCount(0);
}

async function selectComposerModel(window: Page, label: string): Promise<void> {
  const badge = window.locator(".composer__bar .model-selector__badge").first();
  await badge.click();
  const dropdown = window.locator(".composer__bar .model-selector__dropdown").first();
  await expect(dropdown).toBeVisible();
  await dropdown.getByRole("button", { name: new RegExp(label, "i") }).click();
}

function settingsWorkspacePicker(window: Page) {
  return window.getByTestId("settings-surface").getByLabel("Workspace", { exact: true });
}

test("a default reasoning level picked in Settings shows at once and is still chosen after a restart", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspace = await makeWorkspace("default-reasoning");
  await seedAgentDir(agentDir);
  const options = { agentDir, initialWorkspaces: [workspace], testMode: "background" as const };

  const first = await launchDesktop(userDataDir, options);
  try {
    const window = await first.firstWindow();
    await waitForWorkspaceByPath(window, workspace);
    await window.keyboard.press(desktopShortcut(","));
    await openSettingsSection(window, "Models");
    const reasoning = window.getByRole("combobox", { name: "Reasoning", exact: true });
    const before = await reasoning.inputValue();
    const next = before === "high" ? "low" : "high";
    await reasoning.selectOption(next);
    // Immediately, not after the save's round trip.
    expect(await reasoning.inputValue()).toBe(next);
    await expect(reasoning).toHaveValue(next, { timeout: 10_000 });
    await first.close();

    const second = await launchDesktop(userDataDir, options);
    try {
      const again = await second.firstWindow();
      await waitForWorkspaceByPath(again, workspace);
      await again.keyboard.press(desktopShortcut(","));
      await openSettingsSection(again, "Models");
      await expect(again.getByRole("combobox", { name: "Reasoning", exact: true })).toHaveValue(
        next,
      );
    } finally {
      await second.close();
    }
  } finally {
    await first.close().catch(() => undefined);
  }
});
