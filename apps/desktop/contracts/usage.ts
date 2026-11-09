/** Token counts; null cost means the source does not report a trustworthy USD total. */
export interface UsageTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number | null;
  /** USD these tokens would cost at the provider's public API prices (pi-ai's price list). */
  readonly apiCost?: number;
  /** Tokens of models without a public API price, left out of `apiCost`. */
  readonly unpricedTokens?: number;
}

/** One local calendar day: total tokens per model key (`provider/model`). */
export interface UsageDay {
  readonly dayStart: number;
  readonly byModel: Readonly<Record<string, number>>;
}

/** Usage for one model, workspace or thread. */
export interface UsageBreakdown {
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
  readonly provider?: string;
  readonly replies: number;
  readonly tokens: UsageTokens;
  /** Workspaces and threads: total tokens per provider account. */
  readonly byProvider?: Readonly<Record<string, number>>;
}

/** Historical provider totals that may overlap native Pi usage and are kept separate. */
export interface UsageHistoryTotals {
  readonly label: string;
  readonly totals: UsageTokens;
  readonly days: readonly UsageDay[];
  readonly models: readonly UsageBreakdown[];
  readonly workspaces: readonly UsageBreakdown[];
  readonly threads: readonly UsageBreakdown[];
  readonly sessions: number;
}

/** Read status and limitations of the bounded private CLI-history summary. */
export interface UsageHistorySummary {
  readonly status: "available" | "missing" | "unavailable";
  readonly generatedAt?: number;
  /** Importer's checkpoint time for an in-progress or completed summary. */
  readonly asOf?: number;
  /** False while the importer is publishing intermediate atomic checkpoints. */
  readonly complete?: boolean;
  readonly eventCount?: number;
  readonly safeEventCount?: number;
  readonly potentialOverlapEventCount?: number;
  readonly duplicateCrossHostEvents?: number;
  /** Token totals are partial even when the source-file inventory is complete. */
  readonly tokenCoveragePartial?: boolean;
  /** Bounded importer explanation for token normalization coverage. */
  readonly normalizationNote?: string | null;
  readonly piCoverageAvailable?: boolean;
  readonly sourceFileErrors?: number;
  readonly unknownTotalEvents?: number;
  readonly unmappedProjects?: number;
  readonly potentialOverlap?: UsageHistoryTotals;
}

/** A Claude subscription slot as pi-ecosystem's account ledger last recorded it. */
export type AccountState = "ready" | "busy" | "limited" | "relogin" | "disabled" | "unknown";

export interface AccountStatus {
  /** Provider id, e.g. `claude-code-account-1`. */
  readonly id: string;
  readonly state: AccountState;
  /** When a quota cooldown ends (epoch ms); only while `limited`. */
  readonly resetAt?: number;
}

/** Whether one sign-in still works, from the hourly check (local status commands, no model calls). */
export interface SignInStatus {
  /** Provider id (`claude-code-account-1`, `openai`, `antigravity`) or `codex` for the Codex CLI. */
  readonly id: string;
  readonly name: string;
  /** `expiring`: still signed in, but the long-lived login ends within 3 days. */
  readonly state: "ok" | "signed-out" | "expiring" | "unknown";
  /** When the long-lived login ends (epoch ms), where the provider records it. */
  readonly expiresAt?: number;
  /** What the owner runs to sign in again. */
  readonly fix?: string;
}

/** The one status every provider shows, the same way: in the model picker and on the Usage page. */
export type ProviderState = "ready" | "limited" | "relogin" | "expiring" | "unknown";

/** One subscription quota window as the provider reports it, e.g. "5-hour" or "Weekly". */
export interface UsageLimitWindow {
  readonly label: string;
  readonly usedPercent: number;
  /** Epoch ms. */
  readonly resetsAt?: number;
}

/** One Claude CLI slot: whether it holds a sign-in, and who it is signed in as. */
export interface ClaudeSlot {
  readonly slot: number;
  readonly signedIn: boolean;
  /** Profile name, or email when the profile has no name. */
  readonly name?: string;
  /** Subscription plan the sign-in was granted, e.g. "pro" or "max". */
  readonly plan?: string;
  /** Two slots with the same uuid are the same Claude account. */
  readonly accountUuid?: string;
}

/** How much of each plan window one signed-in account has used. Only windows the plan has appear. */
export interface AccountLimits {
  /** Provider id, e.g. `claude-code-account-1` or `openai`. */
  readonly id: string;
  /** The name people know the account by, e.g. "Claude · work". */
  readonly name: string;
  readonly windows: readonly UsageLimitWindow[];
  /** When the provider reported these numbers (epoch ms). */
  readonly asOf: number;
  /** Where the numbers come from, or why there are none. */
  readonly note?: string;
}

/** App-wide usage across every saved pi session, all models and workspaces. */
export interface UsageReport {
  /** Local Pi request/task timings; imported CLI history has no comparable timing data. */
  readonly performance?: readonly ModelPerformance[];
  readonly openscalePlan?: boolean;
  readonly refreshedAt: number;
  readonly totals: UsageTokens;
  /** Ascending by day; only days with usage. */
  readonly days: readonly UsageDay[];
  readonly models: readonly UsageBreakdown[];
  readonly workspaces: readonly UsageBreakdown[];
  /** The threads that used the most tokens (enough to rank each account's own). */
  readonly threads: readonly UsageBreakdown[];
  readonly sessions: number;
  readonly unreadable: number;
  /** Present on collectors that attempted to load the private CLI-history summary. */
  readonly history?: UsageHistorySummary;
}

export interface ModelPerformance {
  readonly dayStart: number;
  readonly key: string;
  readonly requests: number;
  readonly requestMs: number;
  readonly outputTokens: number;
  readonly tasks: number;
  readonly taskMs: number;
  readonly pricedTasks: number;
  readonly taskApiCost: number;
  readonly taskTokens: number;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly replyTokens: number;
}

/** pi's total: input + output + cache read + cache write. */
export function totalTokens(tokens: UsageTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}
