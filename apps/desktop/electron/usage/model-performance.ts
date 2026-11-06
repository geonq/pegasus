import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { totalTokens, type ModelPerformance } from "../../contracts/usage";
import type { apiCostUsd } from "./api-pricing";

/** Saved message time is request start; entry time is persistence after completion. */
export function modelPerformance(
  entries: readonly SessionEntry[],
  price: typeof apiCostUsd,
): readonly ModelPerformance[] {
  const rows = new Map<string, { -readonly [K in keyof ModelPerformance]: ModelPerformance[K] }>();
  let task:
    | { start: number; models: Set<string>; cost: number; priced: boolean; tokens: number }
    | undefined;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    const end = Date.parse(entry.timestamp);
    if (message.role === "user") {
      task = { start: message.timestamp, models: new Set(), cost: 0, priced: true, tokens: 0 };
      continue;
    }
    if (message.role !== "assistant") continue;
    const key = `${message.provider}/${message.model}`;
    const day = new Date(end);
    day.setHours(0, 0, 0, 0);
    const dayStart = day.getTime();
    if (!Number.isFinite(dayStart)) continue;
    const group = `${dayStart}:${key}`;
    let row = rows.get(group);
    if (!row) {
      row = {
        dayStart,
        key,
        requests: 0,
        requestMs: 0,
        outputTokens: 0,
        tasks: 0,
        taskMs: 0,
        pricedTasks: 0,
        taskApiCost: 0,
        taskTokens: 0,
        promptTokens: 0,
        cachedTokens: 0,
        replyTokens: 0,
      };
      rows.set(group, row);
    }
    const elapsed = end - message.timestamp;
    const succeeded = message.stopReason === "stop" || message.stopReason === "toolUse";
    if (succeeded) {
      row.promptTokens += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
      row.cachedTokens += message.usage.cacheRead;
      row.replyTokens += message.usage.output;
    }
    if (succeeded && Number.isFinite(elapsed) && elapsed > 0 && message.usage.output > 0) {
      row.requests++;
      row.requestMs += elapsed;
      row.outputTokens += message.usage.output;
    }
    if (!task) continue;
    task.models.add(key);
    task.tokens += totalTokens({ ...message.usage, cost: null });
    const cost = price(message.model, message.usage, message.provider);
    task.cost += cost ?? 0;
    task.priced &&= cost !== null;
    if (!succeeded) {
      task = undefined;
      continue;
    }
    if (message.stopReason !== "stop") continue;
    const taskMs = end - task.start;
    // Model switches cannot be attributed fairly to one model.
    if (task.models.size === 1 && Number.isFinite(taskMs) && taskMs > 0) {
      row.tasks++;
      row.taskMs += taskMs;
      row.taskTokens += task.tokens;
      if (task.priced) {
        row.pricedTasks++;
        row.taskApiCost += task.cost;
      }
    }
    task = undefined;
  }
  return [...rows.values()];
}
