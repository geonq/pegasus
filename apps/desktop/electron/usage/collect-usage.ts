import { sharedHost } from "@pi-gui/host-protocol/shared";
import { resolveAgentDir } from "../platform/agent-dir";
import type { UsageReport } from "../../contracts/usage";
import { apiCostUsd } from "./api-pricing";
import { readHistoricalUsageSummary, usageHistorySummaryPath } from "./historical-usage";
import {
  aggregateUsage,
  hostUsageSource,
  nodeUsageSource,
  type UsageSource,
} from "./usage-aggregate";

/**
 * Sums every usage record pi saved, in every session of every folder, the way pi's own
 * `getSessionStats()` counts a session: assistant and tool-result usage, usage entries
 * (cache warming) and compaction/branch-summary calls. The Rust host reads the files when it
 * runs; otherwise pi's reader does, yielding between files.
 */
export async function collectUsage(
  options: {
    sessionDir?: string;
    signal?: AbortSignal;
    historySummaryPath?: string;
    /** "node" skips the host (the parity test compares both). */
    source?: "auto" | "node";
  } = {},
): Promise<UsageReport> {
  const summaryPath = options.historySummaryPath ?? usageHistorySummaryPath(resolveAgentDir());
  const historicalRead = readHistoricalUsageSummary(summaryPath);
  // The host serves only the profile's own sessions root.
  let source: UsageSource | undefined;
  if (options.source !== "node" && options.sessionDir === undefined) {
    source = await sharedHost()
      .then((client) => (client ? hostUsageSource(client) : undefined))
      .catch((error: unknown) => {
        console.warn("[usage] host scan failed; reading sessions in this process:", error);
        return undefined;
      });
  }
  source ??= await nodeUsageSource(options.sessionDir, options.signal);
  return aggregateUsage(source, await historicalRead, apiCostUsd, options.signal);
}
