import type { AccountLimits } from "../../../contracts/usage";

/** At or above this share used, an account is marked as running low (as Orca warns at 80 %). */
export const LOW_LIMIT_USED_PERCENT = 80;

function tightestUsedPercent(account: AccountLimits): number {
  return account.windows.reduce((max, window) => Math.max(max, window.usedPercent), -1);
}

/** Accounts with the least left first, so the one about to run out is the first one read. */
export function orderByTightestLimit(limits: readonly AccountLimits[]): AccountLimits[] {
  return limits
    .map((account, index) => ({ account, index, used: tightestUsedPercent(account) }))
    .sort((a, b) => b.used - a.used || a.index - b.index)
    .map((entry) => entry.account);
}

export function isRunningLow(account: AccountLimits): boolean {
  return tightestUsedPercent(account) >= LOW_LIMIT_USED_PERCENT;
}
