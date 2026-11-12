/**
 * Render counters for the "a streamed token re-renders one row" proof. Inert unless a test (or a
 * profiling session) creates `globalThis.__piRenderCounts`; then every counted component adds one
 * per render under its own key.
 */
export function countRender(key: string): void {
  const counts = (globalThis as { __piRenderCounts?: Record<string, number> }).__piRenderCounts;
  if (counts) counts[key] = (counts[key] ?? 0) + 1;
}
