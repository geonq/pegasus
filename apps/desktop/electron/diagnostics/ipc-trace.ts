import { ipcMain } from "electron";
import { errorFields, logEvent, traceEvent } from "./event-log";

const SLOW_MS = 500;
// Called many times a second while typing or streaming; tracing them would push real context out.
const QUIET = /terminal-(write|resize)|report-renderer|set-focused|composer-draft/;

/**
 * Wraps `ipcMain.handle` once, before any handler registers: every renderer call is traced into
 * the context ring, a call slower than 500 ms is logged, and a failed call is logged as an error
 * with the calls before it. Arguments are never logged, only channel names and timings.
 */
export function traceIpcHandlers(): void {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) =>
    handle(channel, async (event, ...args) => {
      const short = channel.replace(/^pi-gui:/, "");
      const quiet = QUIET.test(channel);
      const started = performance.now();
      try {
        const result: unknown = await listener(event, ...args);
        const ms = Math.round(performance.now() - started);
        if (ms >= SLOW_MS) logEvent("ipc.slow", { l: "w", ch: short, ms });
        else if (!quiet) traceEvent("ipc", { ch: short, ms });
        return result;
      } catch (error) {
        logEvent("ipc.error", {
          l: "e",
          ch: short,
          ms: Math.round(performance.now() - started),
          ...errorFields(error),
        });
        throw error;
      }
    });
}
