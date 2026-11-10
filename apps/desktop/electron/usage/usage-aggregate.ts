import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { HostClient } from "@pi-gui/host-protocol";
import { modelPerformance } from "./model-performance";
import { toUsageRecords, type RecordedUsage, type UsageRecord } from "./usage-records";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "../platform/agent-dir";
import type { apiCostUsd } from "./api-pricing";
import {
  totalTokens,
  type UsageBreakdown,
  type UsageReport,
  type UsageTokens,
  type ModelPerformance,
} from "../../contracts/usage";
import { mergeHistoricalUsage, type readHistoricalUsageSummary } from "./historical-usage";

/** Without the host, session files larger than this are skipped and counted as unreadable. */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const TOP_THREADS = 500;

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

function toTokens(usage: RecordedUsage): UsageTokens {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost,
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

/** One session as the totals need it; `records` is undefined when the file could not be read. */
interface SessionUsage {
  readonly id: string;
  readonly cwd: string;
  readonly name?: string;
  readonly firstMessage?: string;
  readonly records: readonly UsageRecord[] | undefined;
}

export interface UsageSource {
  /** Every session found, readable or not. */
  readonly count: number;
  readonly sessions: AsyncIterable<SessionUsage>;
}

/** pi's own reader in this process: capped per file, yields between files. Fallback and test reference. */
export async function nodeUsageSource(
  sessionDir: string | undefined,
  signal?: AbortSignal,
): Promise<UsageSource> {
  // The Electron main bundle is CommonJS and pi's agent package is ESM-only.
  const pi: PiAgent = await import("@earendil-works/pi-coding-agent");
  const infos = await pi.SessionManager.listAll(sessionDir, undefined, signal);
  return {
    count: infos.length,
    sessions: (async function* () {
      for (const info of infos) {
        signal?.throwIfAborted();
        const entries = await readEntries(pi, info.path);
        await nextTurn();
        yield {
          id: info.id,
          cwd: info.cwd,
          ...(info.name === undefined ? {} : { name: info.name }),
          firstMessage: info.firstMessage,
          records: entries ? toUsageRecords(entries) : undefined,
        };
      }
    })(),
  };
}

/** The Rust host's usage index: every file, no size cap, off this process's main thread. */
export async function hostUsageSource(client: Pick<HostClient, "call">): Promise<UsageSource> {
  const scan = await client.call("usage.scan", {});
  return {
    count: scan.sessions.length + scan.unreadable,
    sessions: (async function* (): AsyncGenerator<SessionUsage> {
      for (const session of scan.sessions) {
        yield {
          id: session.id,
          cwd: session.cwd,
          ...(session.name === undefined ? {} : { name: session.name }),
          // pi's listAll names a session without messages this way.
          firstMessage: session.firstMessage || "(no messages)",
          records: toUsageRecords(session.entries),
        };
      }
      for (let n = 0; n < scan.unreadable; n += 1) yield { id: "", cwd: "", records: undefined };
    })(),
  };
}

/** Totals by day, model, folder and thread, priced at API rates, merged with CLI history. */
export async function aggregateUsage(
  source: UsageSource,
  historical: Awaited<ReturnType<typeof readHistoricalUsageSummary>>,
  price: typeof apiCostUsd,
  signal?: AbortSignal,
): Promise<UsageReport> {
  const totals = emptyTokens();
  const days = new Map<number, Record<string, number>>();
  const models = new Map<string, Tally>();
  const workspaces = new Map<string, Tally>();
  const threads: Tally[] = [];
  const performance: ModelPerformance[] = [];
  let unreadable = 0;

  for await (const info of source.sessions) {
    signal?.throwIfAborted();
    const entries = info.records;
    if (!entries) {
      unreadable += 1;
      continue;
    }
    performance.push(...modelPerformance(entries, price));
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
      const apiCost = model ? price(model.model, recordedTokens, model.provider) : null;
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
    for (const record of entries) {
      if (record.kind === "maintenance") add(record.time, record.usage);
      if (record.kind === "user" || record.kind === "maintenance") continue;
      // Saved message time is request start; the entry time is the fallback.
      const time = record.startedAt ?? record.time;
      if (record.kind === "toolResult") {
        add(time, record.usage);
        continue;
      }
      const model = { provider: record.provider, model: record.model };
      add(time, record.usage, model);
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
    sessions: source.count,
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
