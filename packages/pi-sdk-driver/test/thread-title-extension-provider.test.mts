import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";

// Gemini reaches Pegasus as an extension provider (pi-ecosystem's agy bridge). The title
// generator used to build its own model runtime from auth.json/models.json only, so it could
// not find such a model, returned null, and the chat kept its prompt as the title.
const PROVIDER = "title-ext-provider";
const MODEL = "scripted-title";

function scriptedProvider(pi: { registerProvider: (name: string, config: unknown) => void }) {
  pi.registerProvider(PROVIDER, {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "title-ext-test",
    models: [
      {
        id: MODEL,
        name: "Scripted title",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model: { api: string; provider: string; id: string }) {
      const text = "Fix Gemini Titles";
      const message = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } } as never);
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message } as never);
      stream.push({ type: "done", reason: "stop", message } as never);
      return stream;
    },
  });
}

await test("thread title resolves a model registered by an extension provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-title-ext-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));

  const driver = new PiSdkDriver({
    agentDir,
    builtinExtensions: [
      { name: "title-ext-provider", displayName: "Title test", factory: scriptedProvider as never },
    ],
  });
  const workspace = { workspaceId: "title-ws", path: workspacePath };

  const title = await driver.generateThreadTitle(workspace, {
    prompt: "the gemini chat kept my prompt as its title, please fix it",
    model: { provider: PROVIDER, modelId: MODEL },
  });
  assert.equal(title, "Fix Gemini Titles");

  const text = await driver.generateOneShotText(workspace, {
    system: "Answer briefly.",
    prompt: "Say something.",
    model: { provider: PROVIDER, modelId: MODEL },
  });
  assert.equal(text, "Fix Gemini Titles");
});
