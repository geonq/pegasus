import { format } from "node:util";
import { app, type WebContents } from "electron";
import { errorFields, flushEventLogSync, logEvent } from "./event-log";

/**
 * Process-level events into the event log: crashes of any Electron child process, uncaught errors
 * and rejections in main, and every `console.error` / `console.warn` main already writes (most
 * swallowed failures in the codebase end in one of those, so they become searchable lines).
 */
export function watchProcessEvents(): void {
  const error = console.error.bind(console);
  const warn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    error(...args);
    logEvent("console.error", { l: "e", msg: format(...args) });
  };
  console.warn = (...args: unknown[]) => {
    warn(...args);
    logEvent("console.warn", { l: "w", msg: format(...args) });
  };
  process.on("uncaughtExceptionMonitor", (failure, origin) => {
    logEvent("main.uncaught", { l: "e", origin, ...errorFields(failure) });
    flushEventLogSync();
  });
  process.on("unhandledRejection", (reason) => {
    logEvent("main.unhandledRejection", { l: "e", ...errorFields(reason) });
  });
  app.on("child-process-gone", (_event, details) => {
    logEvent("process.gone", {
      l: details.reason === "clean-exit" ? "w" : "e",
      type: details.type,
      reason: details.reason,
      code: details.exitCode,
      name: details.name || details.serviceName,
    });
  });
  // Node's own warnings (e.g. MaxListenersExceededWarning) with where they came from, so a leak
  // names its emitter instead of only repeating in the console.
  process.on("warning", (warning) => {
    const leak = warning as Error & { emitter?: object; type?: unknown; count?: unknown };
    logEvent("main.warning", {
      l: "w",
      name: warning.name,
      emitter: leak.emitter?.constructor?.name,
      event: typeof leak.type === "string" ? leak.type : undefined,
      count: typeof leak.count === "number" ? leak.count : undefined,
      ...errorFields(warning),
    });
  });
  watchMainStalls();
  app.on("web-contents-created", (_event, contents) => watchWebContents(contents));
  // before-quit repeats when the quit flush re-quits; one line per quit.
  app.once("before-quit", () => logEvent("app.quit"));
  app.on("will-quit", () => flushEventLogSync());
}

const STALL_TICK_MS = 250;
const STALL_LOG_MS = 300;

/** Logs every time main's event loop was blocked long enough to be felt (clicks, chat switches). */
function watchMainStalls(): void {
  let expected = performance.now() + STALL_TICK_MS;
  setInterval(() => {
    const now = performance.now();
    const late = now - expected;
    expected = now + STALL_TICK_MS;
    if (late >= STALL_LOG_MS) logEvent("main.stall", { l: "w", ms: Math.round(late) });
  }, STALL_TICK_MS).unref();
}

function watchWebContents(contents: WebContents): void {
  const id = contents.id;
  contents.on("render-process-gone", (_event, details) => {
    logEvent("renderer.gone", { l: "e", wc: id, reason: details.reason, code: details.exitCode });
  });
  contents.on("unresponsive", () => logEvent("renderer.unresponsive", { l: "w", wc: id }));
  contents.on("responsive", () => logEvent("renderer.responsive", { wc: id }));
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (isMainFrame)
      logEvent("renderer.loadFailed", { l: "e", wc: id, code, msg: description, url });
  });
  // Renderer errors and warnings: React's error boundary, failed IPC calls, uncaught errors and
  // the state replica's resync all print here.
  contents.on("console-message", (event) => {
    const details = event as unknown as {
      readonly level?: string;
      readonly message?: string;
      readonly sourceId?: string;
      readonly lineNumber?: number;
    };
    if (details.level !== "error" && details.level !== "warning") return;
    // Electron's dev-only CSP notice repeats in every window and never shows once packaged.
    if (details.message?.includes("Electron Security Warning")) return;
    const isError = details.level === "error";
    logEvent(
      isError ? "renderer.error" : "renderer.warn",
      {
        l: isError ? "e" : "w",
        wc: id,
        msg: details.message ?? "",
        at: details.sourceId
          ? `${details.sourceId.split(/[\\/]/).at(-1)}:${details.lineNumber}`
          : undefined,
      },
      "renderer",
    );
  });
}
