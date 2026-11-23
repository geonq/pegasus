/** Foreground checks at most once a minute, so app switching does not hammer the PC. */
export const MIN_CHECK_INTERVAL_MS = 60_000;

export function shouldCheck(lastCheckMs: number, nowMs: number): boolean {
  return nowMs - lastCheckMs >= MIN_CHECK_INTERVAL_MS;
}
