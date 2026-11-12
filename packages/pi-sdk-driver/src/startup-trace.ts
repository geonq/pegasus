/**
 * One startup timeline for the Electron main process, the app store and the SDK driver. Every boot
 * records it (a few hundred short strings), so a slow start on the owner's machine can be read from
 * logs/startup.log afterwards instead of being reproduced. PI_APP_STARTUP_TRACE=1 also prints each line.
 */
const MAX_ENTRIES = 400;
const entries: string[] = [];

export function startupTrace(message: string): void {
  if (process.env.PI_APP_STARTUP_TRACE === "1") console.info(`[startup] ${message}`);
  if (entries.length < MAX_ENTRIES) {
    entries.push(`${String(Math.round(performance.now())).padStart(7)} ms  ${message}`);
  }
}

/** Times `operation` as one stage: logs its start and its duration. */
export function startupTraceStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  startupTrace(`${stage} started`);
  return operation().finally(() =>
    startupTrace(`${stage}: ${Math.round(performance.now() - startedAt)}ms`),
  );
}

/** The timeline so far, oldest first. Times are milliseconds since the process started. */
export function startupTraceLines(): readonly string[] {
  return entries;
}
