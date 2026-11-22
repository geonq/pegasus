import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";

// A title on the chat's premium Gemini model ran beside the chat's first turn on the same
// Antigravity quota, and that turn got 429. Titles go to the cheapest agy model instead.
const calls: Array<{ model: string; reasoning: unknown }> = [];

const geminiModel = (id: string) => ({
  id,
  name: id,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 65_536,
});

function fakeAntigravity(pi: { registerProvider: (name: string, config: unknown) => void }) {
  pi.registerProvider("antigravity", {
    baseUrl: "process://agy",
    apiKey: "LOCAL_TEST_CANARY",
    api: "antigravity-title-test",
    models: [geminiModel("gemini-4-neon"), geminiModel("gemini-3.8-flash")],
    streamSimple(model: { api: string; provider: string; id: string }, _context: unknown, options?: { reasoning?: unknown }) {
      calls.push({ model: model.id, reasoning: options?.reasoning });
      const text = "Cheap Title";
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

await test("an antigravity chat titles itself with gemini-3.8-flash at low effort, not the chat's model", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-title-agy-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));

  const driver = new PiSdkDriver({
    agentDir,
    builtinExtensions: [{ name: "antigravity-title-test", displayName: "agy test", factory: fakeAntigravity as never }],
  });
  const title = await driver.generateThreadTitle(
    { workspaceId: "title-agy-ws", path: workspacePath },
    { prompt: "why does gemini keep failing", model: { provider: "antigravity", modelId: "gemini-4-neon" } },
  );
  assert.equal(title, "Cheap Title");
  assert.deepEqual(calls, [{ model: "gemini-3.8-flash", reasoning: "low" }]);
});
