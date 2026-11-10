/**
 * Hidden-window metric for renderer cost while an answer streams into a large chat.
 * Identical workload per run: STEPS assistantDelta+sessionUpdated pairs in the same chat, once idle
 * and once with typing. Reports longtasks, React commits, CDP script/layout/style time per delta.
 * Diagnostic, not a CI test. Run with PI_APP_TEST_MODE=background PI_APP_TEST_LANE=core PI_APP_REAL_AUTH=0.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  seedAgentDir,
  type DesktopHarness,
} from "../helpers/electron-app";

const FIXTURE = process.env.PERF_FIXTURE ?? "D:/pf/fixture";
const TARGET_ID = process.env.PERF_TARGET_ID ?? "01a181c5-26dc";
const STEPS = Number(process.env.PERF_STEPS ?? 400);

declare global {
  var __commits: number | undefined;
}

const WORDS =
  "the session list loads while the answer grows and the composer keeps accepting keys without a visible stall".split(
    " ",
  );
const chunk = (i: number) =>
  Array.from({ length: 8 }, (_, k) => WORDS[(i * 8 + k) % WORDS.length]).join(" ") +
  (i % 10 === 9 ? "\n\n" : " ");
const round = (n: number) => Math.round(n * 10) / 10;
const pct = (v: readonly number[], r: number) =>
  [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * r))] ?? 0;

async function emit(h: DesktopHarness, event: SessionDriverEvent): Promise<void> {
  await h.electronApp.evaluate(async (_, payload) => {
    const hooks = (
      globalThis as {
        __PI_APP_TEST_HOOKS?: { emitSessionEvent?: (e: SessionDriverEvent) => Promise<void> };
      }
    ).__PI_APP_TEST_HOOKS;
    if (!hooks?.emitSessionEvent) throw new Error("test hook missing");
    await hooks.emitSessionEvent(payload);
  }, event);
}

test("stream cost", async () => {
  test.setTimeout(420_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  await cp(join(FIXTURE, "sessions"), join(agentDir, "sessions"), { recursive: true });
  const workspaces = JSON.parse(readFileSync(join(FIXTURE, "workspaces.json"), "utf8")) as string[];
  const result: Record<string, unknown> = { label: process.env.PERF_LABEL, steps: STEPS };
  const h = await launchDesktop(userDataDir, { initialWorkspaces: workspaces, agentDir });
  try {
    const p = await h.firstWindow();
    await p.addInitScript(() => {
      globalThis.__commits = 0;
      (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        onScheduleFiberRoot() {},
        onCommitFiberRoot: () => {
          globalThis.__commits = (globalThis.__commits ?? 0) + 1;
        },
        onCommitFiberUnmount() {},
        checkDCE() {},
      };
    });
    await p.reload();
    await p.waitForFunction(() => document.querySelector(".session-row__select") !== null, null, {
      timeout: 120_000,
    });
    for (;;) {
      const s = await getDesktopState(p);
      if (s.workspaces.reduce((n, w) => n + w.sessions.length, 0) >= 51) break;
      await p.waitForTimeout(100);
    }
    const state = await getDesktopState(p);
    const owner = state.workspaces.find((w) => w.sessions.some((s) => s.id.includes(TARGET_ID)))!;
    expect(owner).toBeTruthy();
    const target = owner.sessions.find((s) => s.id.includes(TARGET_ID))!;
    const sessionRef: SessionRef = { workspaceId: owner.id, sessionId: target.id };
    await p.locator(".session-row__select", { hasText: target.title }).first().click();
    await p.waitForFunction(
      (title) => {
        const pane = document.querySelector('[data-testid="timeline-pane"]');
        return (
          document.querySelector(".chat-header__title")?.textContent === title &&
          pane?.getAttribute("data-layout") === "settled" &&
          pane.querySelectorAll("[data-message-id]").length > 0
        );
      },
      target.title,
      { timeout: 120_000 },
    );
    await p.waitForTimeout(2000);

    const cdp = await p.context().newCDPSession(p);
    await cdp.send("Performance.enable");
    const metrics = async () =>
      Object.fromEntries(
        (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]),
      );

    const runId = `perf-${Date.now()}`;
    const snapshot = {
      ref: sessionRef,
      workspace: { workspaceId: owner.id, path: owner.path, displayName: owner.name },
      title: target.title,
      status: "running" as const,
      updatedAt: new Date().toISOString(),
      preview: "streaming",
      runningRunId: runId,
    };
    await emit(h, {
      type: "sessionUpdated",
      sessionRef,
      runId,
      timestamp: snapshot.updatedAt,
      snapshot,
    });
    let step = 0;
    const stream = async (steps: number) => {
      for (let n = 0; n < steps; n++, step++) {
        await emit(h, {
          type: "assistantDelta",
          sessionRef,
          runId,
          timestamp: new Date().toISOString(),
          text: chunk(step),
        });
        await emit(h, {
          type: "sessionUpdated",
          sessionRef,
          runId,
          timestamp: new Date().toISOString(),
          snapshot: { ...snapshot, updatedAt: new Date().toISOString(), preview: `s${step}` },
        });
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await p.getByTestId("composer").click();
    await p.evaluate(() => {
      const g = globalThis as unknown as { __tasks: number[]; __lat: number[] };
      g.__tasks = [];
      g.__lat = [];
      new PerformanceObserver((l) =>
        l.getEntries().forEach((e) => g.__tasks.push(e.duration)),
      ).observe({ entryTypes: ["longtask"] });
      document.addEventListener(
        "keydown",
        (e) => {
          const at = e.timeStamp;
          requestAnimationFrame(() => {
            const c = new MessageChannel();
            c.port1.onmessage = () => g.__lat.push(performance.now() - at);
            c.port2.postMessage(null);
          });
        },
        true,
      );
    });

    const phase = async (name: string, typed: boolean) => {
      await p.evaluate(() => {
        const g = globalThis as unknown as {
          __tasks: number[];
          __lat: number[];
          __commits: number;
        };
        g.__tasks.length = 0;
        g.__lat.length = 0;
        g.__commits = 0;
      });
      const m0 = await metrics();
      const t0 = Date.now();
      let typing = typed;
      const keys = (async () => {
        if (!typed) return;
        for (const ch of "typing while the answer is growing in a long chat ".repeat(3)) {
          if (!typing) break;
          await p.keyboard.type(ch);
          await p.waitForTimeout(45);
        }
      })();
      await Promise.all([stream(STEPS).then(() => (typing = false)), keys]);
      const wall = Date.now() - t0;
      const m1 = await metrics();
      const r = await p.evaluate(() => {
        const g = globalThis as unknown as {
          __tasks: number[];
          __lat: number[];
          __commits: number;
        };
        return { tasks: [...g.__tasks], lat: [...g.__lat], commits: g.__commits };
      });
      const d = (k: string) => ((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000;
      result[name] = {
        wallMs: wall,
        longTasks: r.tasks.length,
        longTaskSumMs: round(r.tasks.reduce((s, n) => s + n, 0)),
        longTaskMaxMs: round(Math.max(0, ...r.tasks)),
        commits: r.commits,
        scriptMsPerDelta: round(d("ScriptDuration") / STEPS),
        taskMsPerDelta: round(d("TaskDuration") / STEPS),
        layoutMsPerDelta: round(d("LayoutDuration") / STEPS),
        styleMsPerDelta: round(d("RecalcStyleDuration") / STEPS),
        layoutCount: Math.round((m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0)),
        keys: r.lat.length,
        keyP95Ms: round(pct(r.lat, 0.95)),
        keyMaxMs: round(pct(r.lat, 1)),
      };
    };
    const cpu = process.env.PERF_CPU === "1";
    if (cpu) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
    }
    await phase("idle", false);
    if (cpu) {
      const { profile } = await cdp.send("Profiler.stop");
      writeFileSync(
        process.env.PERF_CPU_OUT ?? "D:/pf/tools/idle.cpuprofile",
        JSON.stringify(profile),
      );
    }
    await phase("typing", true);
    result.transcriptItems = await p.evaluate(
      async () => (await globalThis.window.piApp!.getSelectedTranscript())?.transcript.length ?? 0,
    );
  } finally {
    await h.close();
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
  const line = JSON.stringify(result);
  console.log("PERF_RESULT " + line);
  if (process.env.PERF_OUT) appendFileSync(process.env.PERF_OUT, line + "\n");
});
