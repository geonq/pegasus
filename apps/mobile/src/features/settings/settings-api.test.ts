import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactCount,
  defaultModel,
  settingsWorkspaceId,
  thinkingLabel,
  thinkingLevelsFor,
  totalTokens,
  type RuntimeSnapshot,
} from "./settings-api.ts";
import type { DesktopAppState } from "../../api/types.ts";

const runtime: RuntimeSnapshot = {
  models: [
    {
      providerId: "a",
      providerName: "A",
      modelId: "m1",
      label: "M1",
      available: true,
      thinkingLevels: ["off"],
    },
    {
      providerId: "b",
      providerName: "B",
      modelId: "m2",
      label: "M2",
      available: true,
      thinkingLevels: ["max", "off", "low", "bogus"],
    },
  ],
  settings: { defaultProvider: "b", defaultModelId: "m2" },
};

test("default model is matched by provider and id", () => {
  assert.equal(defaultModel(runtime)?.label, "M2");
  assert.equal(defaultModel({ ...runtime, settings: {} }), undefined);
  assert.equal(defaultModel(undefined), undefined);
});

test("thinking levels keep pi's order, drop unknowns, and hide a lone off", () => {
  assert.deepEqual(thinkingLevelsFor(runtime.models[1]), ["off", "low", "max"]);
  assert.deepEqual(thinkingLevelsFor(runtime.models[0]), []);
  assert.equal(thinkingLabel("xhigh"), "Extra high");
  assert.equal(thinkingLabel("low"), "Low");
});

test("counts and totals", () => {
  assert.equal(totalTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: null }), 10);
  assert.equal(compactCount(980), "980");
  assert.equal(compactCount(34_400), "34 k");
  assert.equal(compactCount(1_250_000), "1.3 M");
});

test("settings workspace falls back to the first visible one", () => {
  const state = {
    revision: 1,
    workspaces: [{ id: "w1" }, { id: "w2" }],
    selectedWorkspaceId: "w2",
    selectedSessionId: "",
  } as unknown as DesktopAppState;
  assert.equal(settingsWorkspaceId(state), "w2");
  assert.equal(settingsWorkspaceId({ ...state, selectedWorkspaceId: "gone" }), "w1");
  assert.equal(settingsWorkspaceId(null), null);
});
