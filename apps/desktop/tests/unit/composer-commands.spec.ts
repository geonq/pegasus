import { expect, test } from "@playwright/test";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import {
  buildModelOptions,
  isModelSelectable,
  modelFamily,
  versionedModelLabel,
} from "../../src/features/conversation/composer-commands";

const model = {
  providerId: "openai",
  providerName: "OpenAI",
  modelId: "gpt-6",
  label: "GPT-6",
  available: true,
  authType: "api_key",
  reasoning: true,
  thinkingLevels: [],
  supportsImages: true,
};

function runtime(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    workspace: { workspaceId: "workspace", path: "C:/project" },
    providers: [],
    models: [model],
    skills: [],
    extensions: [],
    settings: {
      enableSkillCommands: false,
      enabledModelPatterns: [],
    },
    ...overrides,
  } as RuntimeSnapshot;
}

function expectMatchesOptions(
  value: RuntimeSnapshot | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): void {
  expect(isModelSelectable(value, providerId, modelId)).toBe(
    buildModelOptions(value).some(
      (option) => option.providerId === providerId && option.modelId === modelId,
    ),
  );
}

test("returns false without a runtime or complete model selection", () => {
  expect(isModelSelectable(undefined, "openai", "gpt-6")).toBe(false);
  expect(isModelSelectable(runtime(), undefined, "gpt-6")).toBe(false);
  expect(isModelSelectable(runtime(), "openai", undefined)).toBe(false);
});

test("selects an available default when enabled patterns are empty", () => {
  const value = runtime();
  expect(isModelSelectable(value, "openai", "gpt-6")).toBe(true);
  expectMatchesOptions(value, "openai", "gpt-6");
});

test("selects a model when its exact provider/model pattern is enabled", () => {
  const value = runtime({
    settings: {
      enableSkillCommands: false,
      enabledModelPatterns: ["openai/gpt-6"],
    },
  });
  expect(isModelSelectable(value, "openai", "gpt-6")).toBe(true);
  expectMatchesOptions(value, "openai", "gpt-6");
});

test("rejects a model omitted from a nonempty enabled-pattern list", () => {
  const value = runtime({
    settings: {
      enableSkillCommands: false,
      enabledModelPatterns: ["openai/gpt-5"],
    },
  });
  expect(isModelSelectable(value, "openai", "gpt-6")).toBe(false);
  expectMatchesOptions(value, "openai", "gpt-6");
});

test("rejects unavailable records and provider/model mismatches", () => {
  const unavailable = runtime({ models: [{ ...model, available: false }] });
  expect(isModelSelectable(unavailable, "openai", "gpt-6")).toBe(false);
  expect(isModelSelectable(runtime(), "anthropic", "gpt-6")).toBe(false);
  expect(isModelSelectable(runtime(), "openai", "other-model")).toBe(false);
  expectMatchesOptions(unavailable, "openai", "gpt-6");
});

test("shows only the newest enabled model of each family", () => {
  const ids = [
    "gpt-5.6-sol",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-5.6-terra",
    "gpt-6.1-terra",
    "gpt-6-luna",
  ];
  const value = runtime({
    models: ids.map((modelId) => ({ ...model, modelId, label: modelId })),
    settings: {
      enableSkillCommands: false,
      enabledModelPatterns: [
        "openai/gpt-5.6-sol",
        "openai/gpt-6-sol",
        "openai/gpt-5.6-terra",
        "openai/gpt-6-luna",
      ],
    },
  } as Partial<RuntimeSnapshot>);
  expect(
    buildModelOptions(value)
      .map((option) => option.modelId)
      .sort(),
  ).toEqual(["gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra"]);
  // Hidden from the picker, but a chat saved on it keeps working.
  expect(isModelSelectable(value, "openai", "gpt-6-sol")).toBe(true);
  // The newer version the picker shows instead is usable too, though not enabled itself.
  expect(isModelSelectable(value, "openai", "gpt-6.1-sol")).toBe(true);
  expect(isModelSelectable(value, "openai", "gpt-5.6-luna")).toBe(false);
});

test("enabled Sonnet and Haiku survive catalog version pruning and dated aliases", () => {
  const providerId = "claude-code-account-1";
  const value = runtime({
    models: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"].map((modelId) => ({ ...model, providerId, modelId, label: modelId })),
    settings: {
      enableSkillCommands: false,
      enabledModelPatterns: [
        `${providerId}/claude-opus-5-5`,
        `${providerId}/claude-sonnet-4-5`,
        `${providerId}/claude-haiku-4-5`,
      ],
    },
  });
  expect(buildModelOptions(value).map((option) => option.modelId).sort()).toEqual([
    "claude-haiku-4-5-20251001", "claude-opus-5-5", "claude-sonnet-5",
  ]);
  expect(isModelSelectable(value, providerId, "claude-sonnet-5")).toBe(true);
  expect(isModelSelectable(value, providerId, "claude-haiku-4-5-20251001")).toBe(true);
});

test("family upgrades neither enable another account nor re-enable a disabled family", () => {
  const value = runtime({
    models: [
      { ...model, providerId: "claude-code-account-1", modelId: "claude-sonnet-5" },
      { ...model, providerId: "claude-code-account-1", modelId: "claude-haiku-4-5-20251001" },
      { ...model, providerId: "claude-code-account-2", modelId: "claude-sonnet-5" },
    ],
    settings: { enableSkillCommands: false, enabledModelPatterns: ["claude-code-account-1/claude-sonnet-4-5"] },
  });
  expect(buildModelOptions(value).map((option) => `${option.providerId}/${option.modelId}`)).toEqual([
    "claude-code-account-1/claude-sonnet-5",
  ]);
});

test("Claude dates are aliases, while dated DeepSeek variants remain distinct", () => {
  expect(modelFamily("claude-haiku-4-5-20251001")).toEqual(modelFamily("claude-haiku-4-5"));
  expect(modelFamily("deepseek-v4.1-flash-1017").family).not.toBe(modelFamily("deepseek-v4.1-flash").family);
});

test("bare CLI model labels show the discovered version and follow a newer CLI catalog", () => {
  const providerId = "claude-code-account-1";
  const discovered = (modelId: string) => runtime({
    models: [{ ...model, providerId, providerName: "Claude · hera", modelId, label: "Fable (Claude Code)" }],
  });
  const current = buildModelOptions(discovered("claude-fable-5-2"))[0]!;
  expect(current.label).toBe("Claude · hera · Fable 5.2");
  expect(current.modelId).toBe("claude-fable-5-2");
  expect(buildModelOptions(discovered("claude-fable-5-3"))[0]!.label).toBe("Claude · hera · Fable 5.3");
  expect(versionedModelLabel("claude-sonnet-5-5", "Sonnet")).toBe("Sonnet 5.5");
  expect(versionedModelLabel("claude-haiku-4-5-20251001", "Haiku")).toBe("Haiku 4.5");
  expect(versionedModelLabel("claude-opus-5-5[1m]", "Opus")).toBe("Opus 5.5 (1M context)");
  expect(versionedModelLabel("default", "Default (Opus 5.5)")).toBe("Default (Opus 5.5)");
  expect(versionedModelLabel("gpt-6.1-sol", "6.1 Sol")).toBe("6.1 Sol");
});

test("model choices are reused per runtime and follow a changed enabled list", () => {
  const first = runtime();
  expect(buildModelOptions(first)).toBe(buildModelOptions(first));
  // app-global scope hands out a new runtime object that still shares models, providers and patterns
  expect(buildModelOptions({ ...first })).toBe(buildModelOptions(first));
  const narrowed = {
    ...first,
    settings: { ...first.settings, enabledModelPatterns: ["openai/other"] },
  };
  expect(buildModelOptions(narrowed)).toEqual([]);
  expect(isModelSelectable(narrowed, "openai", "gpt-6")).toBe(false);
  expect(isModelSelectable(first, "openai", "gpt-6")).toBe(true);
});
