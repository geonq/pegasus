import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { modelPerformance } from "./model-performance";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "../application/app-store";
import { apiCostUsd } from "./api-pricing";
import {
  totalTokens,
  type UsageBreakdown,
  type UsageReport,
  type UsageTokens,
  type ModelPerformance,
} from "../../contracts/usage";
import {
  mergeHistoricalUsage,
  readHistoricalUsageSummary,
  usageHistorySummaryPath,
} from "./historical-usage";

/** Session files larger than this are skipped and counted as unreadable. */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const TOP_THREADS = 500;

type RecordedUsage = Parameters<typeof toTokens>[0];
type PiAgent = typeof import("@earendil-works/pi-coding-agent");
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Tally = Mutable<Omit<UsageBreakdown, "tokens" | "byProvider">> & {
  tokens: Mutable<UsageTokens>;
  byProvider: Record<string, number>;
};

const emptyTokens = (): Mutable<UsageTokens> => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

function toTokens(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number };
}): UsageTokens {
  return {
    input: usage.input || 0,
    output: usage.output || 0,
    cacheRead: usage.cacheRead || 0,
    cacheWrite: usage.cacheWrite || 0,
    cost: usage.cost?.total || 0,
  };
}

function addTokens(target: Mutable<UsageTokens>, usage: UsageTokens): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost = target.cost === null || usage.cost === null ? null : target.cost + usage.cost;
  target.apiCost = (target.apiCost ?? 0) + (usage.apiCost ?? 0);
  target.unpricedTokens = (target.unpricedTokens ?? 0) + (usage.unpricedTokens ?? 0);
}

function localDayStart(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function tally(
  map: Map<string, Tally>,
  key: string,
  init: () => Omit<Tally, "tokens" | "replies" | "byProvider">,
): Tally {
  let entry = map.get(key);
  if (!entry) {
    entry = { ...init(), replies: 0, tokens: emptyTokens(), byProvider: {} };
    map.set(key, entry);
  }
  return entry;
}

async function readEntries(pi: PiAgent, path: string): Promise<SessionEntry[] | undefined> {
  try {
    if ((await stat(path)).size > MAX_SESSION_BYTES) return undefined;
    const entries = pi.parseSessionEntries(await readFile(path, "utf8"));
    if (entries[0]?.type !== "session") return undefined;
    pi.migrateSessionEntries(entries);
    return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
  } catch {
    return undefined;
  }
}

/**
 * Sums every usage record pi saved, in every session of every folder, the way pi's own
 * `getSessionStats()` counts a session: assistant and tool-result usage, usage entries
 * (cache warming) and compaction/branch-summary calls. Yields between files so a large
 * history never blocks the main process for long.
 */
export async function collectUsage(
  options: { sessionDir?: string; signal?: AbortSignal; historySummaryPath?: string } = {},
): Promise<UsageReport> {
  // The Electron main bundle is CommonJS and pi's agent package is ESM-only.
  const pi: PiAgent = await import("@earendil-works/pi-coding-agent");
  const summaryPath = options.historySummaryPath ?? usageHistorySummaryPath(resolveAgentDir());
  const [infos, historical] = await Promise.all([
    pi.SessionManager.listAll(options.sessionDir, undefined, options.signal),
    readHistoricalUsageSummary(summaryPath),
  ]);
  const totals = emptyTokens();
  const days = new Map<number, Record<string, number>>();
  const models = new Map<string, Tally>();
  const workspaces = new Map<string, Tally>();
  const threads: Tally[] = [];
  const performance: ModelPerformance[] = [];
  let unreadable = 0;

  for (const info of infos) {
    options.signal?.throwIfAborted();
    const entries = await readEntries(pi, info.path);
    await nextTurn();
    if (!entries) {
      unreadable += 1;
      continue;
    }
    performance.push(...modelPerformance(entries, apiCostUsd));
    const cwd = info.cwd || "";
    const workspace = tally(workspaces, cwd, () => ({
      key: cwd,
      label: basename(cwd) || cwd || "Unknown",
      detail: cwd,
    }));
    const thread: Tally = {
      key: info.id,
      label:
        info.name?.trim() ||
        info.firstMessage?.replace(/\s+/g, " ").trim().slice(0, 80) ||
        "Untitled thread",
      detail: workspace.label,
      replies: 0,
      tokens: emptyTokens(),
      byProvider: {},
    };
    const add = (
      time: number,
      recorded: RecordedUsage,
      model?: { provider: string; model: string },
    ) => {
      const recordedTokens = toTokens(recorded);
      const amount = totalTokens(recordedTokens);
      const apiCost = model ? apiCostUsd(model.model, recordedTokens, model.provider) : null;
      const usage: UsageTokens =
        apiCost === null
          ? { ...recordedTokens, unpricedTokens: amount }
          : { ...recordedTokens, apiCost };
      if (!amount && !usage.cost) return;
      for (const target of [totals, workspace.tokens, thread.tokens]) addTokens(target, usage);
      const provider = model?.provider ?? "pi";
      for (const owner of [workspace, thread]) {
        owner.byProvider[provider] = (owner.byProvider[provider] ?? 0) + amount;
      }
      const modelKey = model ? `${model.provider}/${model.model}` : "pi/maintenance";
      const modelTally = tally(models, modelKey, () => ({
        key: modelKey,
        label: model?.model ?? "Compaction & cache",
        provider: model?.provider ?? "pi",
      }));
      addTokens(modelTally.tokens, usage);
      const dayStart = localDayStart(time);
      const day = days.get(dayStart) ?? {};
      day[modelKey] = (day[modelKey] ?? 0) + amount;
      days.set(dayStart, day);
    };
    for (const entry of entries) {
      const entryTime = Date.parse(entry.timestamp);
      if (entry.type === "usage") add(entryTime, entry.usage);
      else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage)
        add(entryTime, entry.usage);
      if (entry.type !== "message") continue;
      const message = entry.message;
      const time = typeof message.timestamp === "number" ? message.timestamp : entryTime;
      if (message.role === "toolResult" && message.usage) add(time, message.usage);
      if (message.role !== "assistant") continue;
      const model = { provider: message.provider, model: message.model };
      add(time, message.usage, model);
      tally(models, `${model.provider}/${model.model}`, () => ({
        key: "",
        label: model.model,
        provider: model.provider,
      })).replies += 1;
      workspace.replies += 1;
      thread.replies += 1;
    }
    if (totalTokens(thread.tokens)) threads.push(thread);
  }

  const byTotal = (a: Tally, b: Tally) => totalTokens(b.tokens) - totalTokens(a.tokens);
  const withKeys = (map: Map<string, Tally>) =>
    [...map]
      .map(([key, value]) => ({ ...value, key }))
      .filter((value) => totalTokens(value.tokens))
      .sort(byTotal);
  const native: UsageReport = {
    performance,
    openscalePlan: await readOpenScalePlan(),
    refreshedAt: Date.now(),
    totals,
    days: [...days].sort(([a], [b]) => a - b).map(([dayStart, byModel]) => ({ dayStart, byModel })),
    models: withKeys(models),
    workspaces: withKeys(workspaces),
    threads: threads.sort(byTotal).slice(0, TOP_THREADS),
    sessions: infos.length,
    unreadable,
  };
  return mergeHistoricalUsage(native, historical);
}

async function readOpenScalePlan(): Promise<boolean> {
  try {
    const config = JSON.parse(await readFile(join(resolveAgentDir(), "models.json"), "utf8")) as {
      providers?: { openscale?: { apiKey?: unknown } };
    };
    const key = config.providers?.openscale?.apiKey;
    return typeof key === "string" && key.startsWith("sk-openscale-plan-");
  } catch {
    return false;
  }
}
