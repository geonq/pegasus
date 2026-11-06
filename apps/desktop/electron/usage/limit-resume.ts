import type { AccountLimits, AccountStatus } from "../../contracts/usage";

/** Wait this long past the reported reset, so the first request after it is not refused again. */
const RESET_MARGIN_MS = 60_000;
/** Never sooner than this, so a stale reset time cannot loop a thread into back-to-back failures. */
const MIN_WAIT_MS = 2 * 60_000;
/** When no account reports a reset time, try again after this long. */
const UNKNOWN_RESET_WAIT_MS = 30 * 60_000;
/** A thread that keeps hitting the limit after continuing stops being continued after this many. */
export const MAX_LIMIT_CONTINUES = 6;

export const LIMIT_CONTINUE_TITLE_PREFIX = "Continue after limit";
export const LIMIT_CONTINUE_INSTRUCTION =
  "The Claude usage limit that stopped your last turn has reset. Continue the task from where you stopped.";

/**
 * A turn the Claude account pool could not finish because every account was at its usage or
 * rate limit. Billing refusals and sign-in problems do not count: waiting does not fix those.
 */
export function isClaudeLimitFailure(message: string): boolean {
  const pool = /No authenticated Claude account can complete this request[^:]*:(.*)$/is.exec(
    message,
  );
  // Only the reason after the colon counts; the prefix itself names the "quota policy".
  return (
    pool !== null && /rate.?limit|usage.?limit|429|too many requests|hit your limit/i.test(pool[1]!)
  );
}

/**
 * When the first approved Claude account can take a request again: the later of its pool cooldown
 * and the reset of any plan window it has used up. The earliest such account decides.
 */
export function limitResumeAt(
  states: readonly AccountStatus[],
  limits: readonly AccountLimits[],
  now: number,
): number {
  const candidates = states
    .filter((status) => status.id.startsWith("claude-code-account-") && status.state !== "disabled")
    .map((status) => {
      const cooldown = status.state === "limited" ? (status.resetAt ?? 0) : 0;
      const windows = limits.find((entry) => entry.id === status.id)?.windows ?? [];
      const spent = windows
        .filter((window) => window.usedPercent >= 100)
        .map((window) => window.resetsAt);
      // A window used up with no reset time leaves this account's return unknown.
      if (spent.some((resetsAt) => resetsAt === undefined)) return undefined;
      return Math.max(cooldown, ...(spent as number[]));
    })
    .filter((at): at is number => at !== undefined);
  const earliest = candidates.length > 0 ? Math.min(...candidates) : undefined;
  const target =
    earliest === undefined
      ? now + UNKNOWN_RESET_WAIT_MS
      : Math.max(earliest + RESET_MARGIN_MS, now + MIN_WAIT_MS);
  return target;
}
