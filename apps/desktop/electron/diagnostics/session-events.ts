import type { SessionDriverEvent } from "@pi-gui/session-driver";
import { logEvent, traceEvent } from "./event-log";

interface RunStats {
  readonly startedAt: number;
  readonly runId?: string;
  deltas: number;
  deltaChars: number;
  thinkingChars: number;
  tools: number;
  toolErrors: number;
  firstTokenMs?: number;
}

interface OpenTool {
  readonly name: string;
  readonly startedAt: number;
}

/**
 * Turns the driver's event stream into a few lines per run: run start, each tool call when it
 * finishes (name, ms, ok), and the run end with its totals (tokens are counted, never logged one
 * by one). Errors carry the driver's message and code.
 */
export class SessionEventRecorder {
  private readonly runs = new Map<string, RunStats>();
  private readonly tools = new Map<string, OpenTool>();

  record(event: SessionDriverEvent): void {
    const s = event.sessionRef.sessionId;
    const key = `${event.sessionRef.workspaceId}\u0000${s}`;
    switch (event.type) {
      case "assistantDelta":
      case "assistantThinkingDelta": {
        const run = this.runFor(key, event.runId);
        if (event.type === "assistantDelta") {
          run.deltas += 1;
          run.deltaChars += event.text.length;
          run.firstTokenMs ??= Date.now() - run.startedAt;
        } else {
          run.thinkingChars += event.text.length;
        }
        return;
      }
      case "sessionUpdated":
      case "sessionOpened": {
        const status = event.snapshot.status;
        if (status === "running" && !this.runs.has(key)) {
          const run = this.runFor(key, event.snapshot.runningRunId ?? event.runId);
          logEvent("run.start", {
            s,
            r: run.runId,
            model: event.snapshot.config?.modelId,
            provider: event.snapshot.config?.provider,
          });
        } else {
          traceEvent(`session.${event.type === "sessionOpened" ? "opened" : "updated"}`, {
            s,
            status,
          });
        }
        return;
      }
      case "toolStarted":
        this.runFor(key, event.runId).tools += 1;
        this.tools.set(`${key}\u0000${event.callId}`, { name: event.toolName, startedAt: Date.now() });
        traceEvent("tool.start", { s, r: event.runId, tool: event.toolName, call: event.callId });
        return;
      case "toolUpdated":
        return;
      case "toolFinished": {
        const toolKey = `${key}\u0000${event.callId}`;
        const tool = this.tools.get(toolKey);
        this.tools.delete(toolKey);
        if (!event.success) this.runFor(key, event.runId).toolErrors += 1;
        logEvent("tool.end", {
          s,
          r: event.runId,
          tool: tool?.name,
          call: event.callId,
          ms: tool ? Date.now() - tool.startedAt : undefined,
          ...(event.success ? {} : { l: "w", ok: false }),
        });
        return;
      }
      case "runCompleted":
        this.endRun(key, s, "run.done", event.runId);
        return;
      case "runFailed":
        this.endRun(key, s, "run.failed", event.runId, {
          l: "e",
          msg: event.error.message,
          code: event.error.code,
        });
        return;
      case "sessionClosed":
        if (this.runs.has(key)) this.endRun(key, s, "run.closed", event.runId, { reason: event.reason });
        logEvent("session.closed", { s, reason: event.reason });
        return;
      case "hostUiRequest":
        if (event.request.kind === "notify" && event.request.level === "error") {
          logEvent("ui.notify", { l: "e", s, msg: event.request.message });
        } else if (event.request.kind !== "status" && event.request.kind !== "widget") {
          traceEvent("ui.request", { s, kind: event.request.kind });
        }
        return;
      case "extensionCompatibilityIssue":
        logEvent("extension.issue", {
          l: "w",
          s,
          capability: event.issue.capability,
          msg: event.issue.message,
          ext: event.issue.extensionPath,
        });
        return;
      default:
        traceEvent(`session.${event.type}`, { s, r: event.runId });
    }
  }

  private runFor(key: string, runId: string | undefined): RunStats {
    let run = this.runs.get(key);
    if (!run) {
      run = {
        startedAt: Date.now(),
        ...(runId ? { runId } : {}),
        deltas: 0,
        deltaChars: 0,
        thinkingChars: 0,
        tools: 0,
        toolErrors: 0,
      };
      this.runs.set(key, run);
    }
    return run;
  }

  private endRun(
    key: string,
    s: string,
    kind: string,
    runId: string | undefined,
    extra: Readonly<Record<string, unknown>> = {},
  ): void {
    const run = this.runs.get(key);
    this.runs.delete(key);
    for (const toolKey of this.tools.keys()) if (toolKey.startsWith(`${key}\u0000`)) this.tools.delete(toolKey);
    logEvent(kind, {
      s,
      r: runId ?? run?.runId,
      ms: run ? Date.now() - run.startedAt : undefined,
      firstTokenMs: run?.firstTokenMs,
      deltas: run?.deltas,
      chars: run?.deltaChars,
      thinkingChars: run?.thinkingChars || undefined,
      tools: run?.tools,
      toolErrors: run?.toolErrors || undefined,
      ...extra,
    });
  }
}
