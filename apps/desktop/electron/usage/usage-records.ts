/**
 * The usage-relevant part of a pi session entry, from either source: pi's full entries (read in
 * Node) or the host's slim usage entries (read in Rust, message content left out). Both shapes are
 * checked field by field here, so malformed data becomes "no usage" instead of NaN downstream.
 */

/** Token counts of one request, as pi records them (cost is what the provider billed). */
export interface RecordedUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

export type UsageRecord =
  /** A `usage`, `compaction` or `branch_summary` entry: maintenance calls with no model reply. */
  | { readonly kind: "maintenance"; readonly time: number; readonly usage: RecordedUsage }
  /** A user turn; only marks when a task started. */
  | { readonly kind: "user"; readonly time: number; readonly startedAt: number | undefined }
  | {
      readonly kind: "assistant";
      /** When the reply was saved (after it finished). */
      readonly time: number;
      /** When the request started. */
      readonly startedAt: number | undefined;
      readonly provider: string;
      readonly model: string;
      readonly usage: RecordedUsage;
      readonly stopReason: string | undefined;
    }
  | {
      readonly kind: "toolResult";
      readonly time: number;
      readonly startedAt: number | undefined;
      readonly usage: RecordedUsage;
    };

/** Shared by pi's `SessionEntry` and the host's `UsageEntry`; every field is checked before use. */
export interface RawUsageEntry {
  readonly type: string;
  readonly timestamp?: unknown;
  readonly usage?: unknown;
  readonly message?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export function recordedUsage(value: unknown): RecordedUsage | undefined {
  if (!isRecord(value)) return undefined;
  return {
    input: count(value.input),
    output: count(value.output),
    cacheRead: count(value.cacheRead),
    cacheWrite: count(value.cacheWrite),
    cost: isRecord(value.cost) ? count(value.cost.total) : 0,
  };
}

export function toUsageRecords(entries: readonly RawUsageEntry[]): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const entry of entries) {
    const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      const usage = recordedUsage(entry.usage);
      if (usage) records.push({ kind: "maintenance", time, usage });
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    const startedAt = typeof message.timestamp === "number" ? message.timestamp : undefined;
    if (message.role === "user") {
      records.push({ kind: "user", time, startedAt });
      continue;
    }
    const usage = recordedUsage(message.usage);
    if (!usage) continue;
    if (message.role === "toolResult") {
      records.push({ kind: "toolResult", time, startedAt, usage });
    } else if (message.role === "assistant") {
      records.push({
        kind: "assistant",
        time,
        startedAt,
        provider: text(message.provider) ?? "",
        model: text(message.model) ?? "",
        usage,
        stopReason: text(message.stopReason),
      });
    }
  }
  return records;
}
