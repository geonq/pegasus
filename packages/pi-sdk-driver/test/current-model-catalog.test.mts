import assert from "node:assert/strict";
import test from "node:test";
import { currentDesktopModels } from "../dist/current-model-catalog.js";

await test("Claude pickers keep the newest offered version per family and canonical aliases", () => {
  const ids = [
    "claude-opus-4-5",
    "claude-opus-5-5-20261001",
    "claude-opus-5-5",
    "claude-haiku-4-5",
    "claude-haiku-5-5",
    "claude-fable-5",
    "claude-fable-5-1",
    "default",
  ];
  const models = ids.map((id) => ({ provider: "claude-code-account-1", id }));
  assert.deepEqual(
    currentDesktopModels(models).map((x) => x.id),
    ["claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  );
});
await test("Codex shows every current GPT generation, including ones released later", () => {
  const models = [
    "gpt-4o",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6.2-sol",
    "gpt-7",
    "codex-auto-review",
  ].map((id) => ({ provider: "openai-account-2", id }));
  assert.deepEqual(
    currentDesktopModels(models).map((x) => x.id),
    ["gpt-5.6-luna", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6.2-sol", "gpt-7"],
  );
});
await test("Other providers and model identities are preserved", () => {
  const models = [
    { provider: "custom-team", id: "older-model" },
    { provider: "antigravity", id: "gemini-4-argon" },
  ];
  assert.deepEqual(currentDesktopModels(models), models);
  assert.equal(currentDesktopModels(models)[0], models[0]);
});
await test("Claude discovery advances per account without inventing unavailable models", () => {
  const models = [
    { provider: "anthropic", id: "claude-opus-5-5" },
    { provider: "anthropic", id: "claude-opus-6" },
    { provider: "claude-code-account-2", id: "claude-opus-5-5" },
  ];
  assert.deepEqual(currentDesktopModels(models), models.slice(1));
});
