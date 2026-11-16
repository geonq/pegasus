import type { AccountLimits, SessionUsageSnapshot } from "./types";

/** The fullest plan window one chat reports, and what the phone says about it. */
export interface PlanStatus {
  readonly provider: string;
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

/**
 * The window to warn about: the fullest one. A chat that reports no limits (an imported CLI
 * session, or a provider that does not report usage) has no status, and the phone says nothing.
 */
export function planStatus(snapshot: SessionUsageSnapshot | undefined): PlanStatus | null {
  const limits = snapshot?.planLimits;
  if (!limits || limits.limits.length === 0) return null;
  const fullest = limits.limits.reduce((most, limit) =>
    limit.usedPercent > most.usedPercent ? limit : most,
  );
  return {
    provider: limits.provider,
    usedPercent: fullest.usedPercent,
    ...(fullest.resetsAt === undefined ? {} : { resetsAt: fullest.resetsAt }),
  };
}

/** Warnings start here: below it the phone stays quiet, because a limit is not news yet. */
export const LIMIT_WARNING_PERCENT = 90;

/** "resets in 43 min", from the provider's own reset time. */
export function resetsIn(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const minutes = Math.round((Date.parse(resetsAt) - now) / 60_000);
  if (!Number.isFinite(minutes)) return null;
  if (minutes <= 0) return "resets now";
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `resets in ${hours} h` : `resets in ${hours} h ${rest} min`;
}

/** The account whose fullest window matters most, for the Usage screen's order. */
export function accountsByFullest(accounts: readonly AccountLimits[]): readonly AccountLimits[] {
  const fullest = (account: AccountLimits) =>
    account.windows.reduce((most, window) => Math.max(most, window.usedPercent), 0);
  return [...accounts].sort((a, b) => fullest(b) - fullest(a));
}
