import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const PROVIDER_ID = "generative-ui-test";
const MODEL_ID = "scripted";

// The scripted model asks with ask_user, then repeats the tool result it got back, so the test
// sees exactly what the agent received.
const providerSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const spec = {
  title: "How should I isolate the work?",
  blocks: [
    { type: "text", text: "Two sessions edit the same files." },
    {
      type: "choice",
      id: "approach",
      label: "Approach",
      allowOther: true,
      options: [
        { id: "worktree", label: "Worktree", description: "Separate checkout, merge later" },
        { id: "wait", label: "Wait", description: "Let the other session commit first" },
        { id: "here", label: "Work here", description: "Risk conflicts" },
      ],
    },
  ],
};

export default function provider(pi) {
  pi.registerProvider("generative-ui-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "generative-ui-test",
    models: [{
      id: "scripted", name: "Scripted", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 4096,
    }],
    streamSimple(model, context) {
      const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
      const resultText = result ? result.content.map((part) => part.text ?? "").join("") : "";
      const content = result
        ? [{ type: "text", text: "Agent received: " + resultText }]
        : [{ type: "toolCall", id: "ask-" + Date.now(), name: "ask_user", arguments: { ...spec } }];
      const message = {
        role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: result ? "stop" : "toolUse",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (result) stream.push({ type: "text_delta", contentIndex: 0, delta: content[0].text, partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    },
  });
}
`;

async function ask(window: Page) {
  const composer = window.getByTestId("composer");
  await composer.click();
  await composer.fill("Start the attachments work.");
  await composer.press("Enter");
  const card = window.getByTestId("generative-ui");
  await expect(card).toHaveAttribute("data-state", "open");
  return card;
}

test("the agent asks with clickable options, gets the pick back, and the answer stays after restart", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("generative-ui");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID,
      enabledModels: [`${PROVIDER_ID}/${MODEL_ID}`],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await writeProjectExtension(workspacePath, "provider.ts", providerSource);
  const launch = () =>
    launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
    });

  const firstRun = await launch();
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    await createNamedThread(window, "Answered question");
    const card = await ask(window);
    await expect(card).toContainText("How should I isolate the work?");
    // Sending with nothing picked says what is missing and sends nothing.
    await card.getByTestId("generative-ui-submit").click();
    await expect(card.getByRole("alert")).toHaveText('Pick an option for "Approach".');
    await card.getByText("Worktree", { exact: true }).click();
    await card.getByTestId("generative-ui-submit").click();
    const reply = window.locator(".timeline-item--assistant");
    await expect(reply).toContainText("Agent received: The user answered.");
    await expect(reply).toContainText("Approach: Worktree");
    await expect(reply).toContainText('Answer as JSON: {"approach":"worktree"}');
    await expect(card).toHaveAttribute("data-state", "answered");
    await expect(card.getByRole("radio", { name: /Worktree/ })).toBeChecked();
    await expect(card.getByRole("radio", { name: /Worktree/ })).toBeDisabled();
    await window.screenshot({ path: test.info().outputPath("answered.png") });

    // A second chat's question is still waiting when the app quits.
    await createNamedThread(window, "Waiting question");
    await ask(window);
    await window.screenshot({ path: test.info().outputPath("open.png") });
  } finally {
    await firstRun.close();
  }

  const secondRun = await launch();
  try {
    const window = await secondRun.firstWindow();
    await selectSession(window, "Answered question");
    const answered = window.getByTestId("generative-ui");
    await expect(answered).toHaveAttribute("data-state", "answered");
    await expect(answered.getByRole("radio", { name: /Worktree/ })).toBeChecked();
    await expect(answered.getByTestId("generative-ui-submit")).toHaveCount(0);

    await selectSession(window, "Waiting question");
    const expired = window.getByTestId("generative-ui");
    await expect(expired).toHaveAttribute("data-state", "closed");
    await expect(expired).toContainText("Not answered. Reply in the chat instead.");
  } finally {
    await secondRun.close();
  }
});
