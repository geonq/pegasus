export type RuntimeLoadStatus = "loading" | "error" | "unavailable" | "ready";

/**
 * The providers page paints from the cached runtime snapshot at once; the slow
 * provider status refresh only shows a small indicator. The blocking placeholder
 * is for a first load with nothing cached, or a failed/unavailable load.
 */
export function providersPlaceholderVisible(
  status: RuntimeLoadStatus | undefined,
  hasCachedRuntime: boolean,
): boolean {
  if (!status || status === "ready") return false;
  if (status === "loading" && hasCachedRuntime) return false;
  return true;
}
