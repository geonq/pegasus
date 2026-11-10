import { expect, test } from "@playwright/test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { modelPerformance as measure } from "../../electron/usage/model-performance";
import { openscaleApiCost } from "../../electron/usage/openscale-pricing";
import { toUsageRecords } from "../../electron/usage/usage-records";

const modelPerformance = (entries: readonly SessionEntry[]) =>
  measure(toUsageRecords(entries), openscaleApiCost);
const apiCostUsd = (
  model: string,
  tokens: Parameters<typeof openscaleApiCost>[1],
  _provider: string,
) => openscaleApiCost(model, tokens);

const start = Date.UTC(2026, 10, 6, 12);
function user(time = start): SessionEntry {
  return {
    type: "message",
    id: "user",
    parentId: null,
    timestamp: new Date(time).toISOString(),
    message: { role: "user", content: "task", timestamp: time },
  };
}
function reply(
  offset: number,
  stopReason: "toolUse" | "stop" | "aborted" = "stop",
  model = "deepseek/deepseek-v4.1-flash",
): SessionEntry {
  return {
    type: "message",
    id: `reply-${offset}`,
    parentId: "user",
    timestamp: new Date(start + offset).toISOString(),
    message: {
      role: "assistant",
      api: "anthropic-messages",
      provider: "openscale",
      model,
      content: [],
      stopReason,
      timestamp: start + offset - 1000,
      usage: {
        input: 100,
        output: 200,
        cacheRead: 50,
        cacheWrite: 0,
        totalTokens: 350,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  };
}

test("effective speed excludes tool gaps, while completed task time and cost include every reply", () => {
  const [row] = modelPerformance([user(), reply(1000, "toolUse"), reply(6000)]);
  expect(row).toMatchObject({
    requests: 2,
    requestMs: 2000,
    outputTokens: 400,
    tasks: 1,
    taskMs: 6000,
    pricedTasks: 1,
    taskTokens: 700,
    promptTokens: 300,
    cachedTokens: 100,
    replyTokens: 400,
  });
  expect(row!.taskApiCost).toBeCloseTo(0.0001083, 9);
});
test("aborted, unfinished, mixed-model and invalid-clock tasks do not become completed samples", () => {
  expect(modelPerformance([user(), reply(1000, "aborted")])[0]!.tasks).toBe(0);
  expect(modelPerformance([user(), reply(1000, "toolUse")])[0]!.tasks).toBe(0);
  expect(
    modelPerformance([
      user(),
      reply(1000, "toolUse"),
      reply(5000, "stop", "z-ai/glm-5.3-flash"),
    ]).every((row) => row.tasks === 0),
  ).toBe(true);
  expect(modelPerformance([user(start + 10000), reply(1000)])[0]!.tasks).toBe(0);
});
test("OpenScale pricing matches published token categories and leaves unknown models unpriced", () => {
  expect(
    apiCostUsd(
      "z-ai/glm-5.3-flash",
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      "openscale",
    ),
  ).toBeCloseTo(0.664);
  expect(
    apiCostUsd(
      "deepseek/deepseek-v4.1-flash-1017",
      { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      "openscale",
    ),
  ).toBe(0.06);
  expect(
    apiCostUsd("unknown", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, "openscale"),
  ).toBeNull();
});
