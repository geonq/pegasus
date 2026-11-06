import { appendFile, mkdir } from "node:fs/promises";
import { Session } from "node:inspector";
import path from "node:path";
import { mainFrameListener } from "../ipc/main-frame-ipc";
import type { WindowOwner } from "../windows/window-owner";
import { desktopIpc } from "../../contracts/ipc";

const TICK_MS = 100;
const REPORT_MS = 250;
const MAX_LINES = 5000;
const SAMPLE_US = 10_000;
const PROFILE_WINDOW_MS = 60_000;

interface ProfileNode {
  readonly id: number;
  readonly children?: readonly number[];
  readonly callFrame: {
    readonly functionName: string;
    readonly url: string;
    readonly lineNumber: number;
  };
}
interface Profile {
  readonly nodes: readonly ProfileNode[];
  readonly startTime: number;
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

/**
 * Logs every stretch the main thread was blocked, with the functions that ran during it. Keyboard
 * and mouse input reach the window through this thread, so each line is a moment typing or
 * clicking could not get through. A 10 ms sampling profiler runs in one-minute windows.
 */
export function watchMainThreadStalls(logDirectory: string): void {
  const file = path.join(logDirectory, "main-thread-stalls.log");
  const session = new Session();
  session.connect();
  const post = <T>(method: string, params: object = {}) =>
    new Promise<T>((resolve, reject) =>
      session.post(method, params, (error, result) =>
        error ? reject(error) : resolve(result as T),
      ),
    );
  let profiling = post("Profiler.enable")
    .then(() => post("Profiler.setSamplingInterval", { interval: SAMPLE_US }))
    .then(() => post("Profiler.start"));
  let windowStarted = performance.now();
  let expected = performance.now() + TICK_MS;
  let written = 0;

  const restart = async (): Promise<Profile> => {
    await profiling;
    const { profile } = await post<{ profile: Profile }>("Profiler.stop");
    profiling = post("Profiler.start");
    windowStarted = performance.now();
    return profile;
  };

  const timer = setInterval(() => {
    const now = performance.now();
    const blocked = now - expected;
    expected = now + TICK_MS;
    if (blocked >= REPORT_MS && written < MAX_LINES) {
      written += 1;
      const at = new Date().toISOString();
      const stallEndUs = (performance.timeOrigin + now) * 1000;
      restart()
        .then((profile) => hotFrames(profile, stallEndUs - blocked * 1000, stallEndUs))
        .catch(() => "(no profile)")
        .then((frames) =>
          mkdir(logDirectory, { recursive: true }).then(() =>
            appendFile(file, `${at} main thread blocked ${Math.round(blocked)} ms\n${frames}\n`),
          ),
        )
        .catch((error: unknown) => {
          console.error("[main] writing main-thread-stalls.log failed", error);
        });
    } else if (now - windowStarted > PROFILE_WINDOW_MS) {
      restart().catch((error: unknown) => {
        console.error("[main] main-thread profiler restart failed", error);
      });
    }
  }, TICK_MS);
  timer.unref();
}

/**
 * Slow window frames the preload reports (100 ms or more), written next to the main-thread log so
 * a freeze shows on whichever side caused it.
 */
export function watchRendererStalls(logDirectory: string, windows: WindowOwner): void {
  const file = path.join(logDirectory, "renderer-stalls.log");
  let written = 0;
  mainFrameListener(windows, desktopIpc.reportRendererStall, (report: unknown) => {
    if (typeof report !== "string" || written >= MAX_LINES) return;
    written += 1;
    mkdir(logDirectory, { recursive: true })
      .then(() => appendFile(file, `${new Date().toISOString()} ${report.slice(0, 2000)}\n`))
      .catch((error: unknown) => {
        console.error("[main] writing renderer-stalls.log failed", error);
      });
  });
}

/** The functions with the most time during [fromUs, toUs], wall-clock microseconds. */
function hotFrames(profile: Profile, fromUs: number, toUs: number): string {
  const parent = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id);
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const label = (id: number) => {
    const frame = byId.get(id)?.callFrame;
    return frame
      ? `${frame.functionName || "(anon)"} ${frame.url.split(/[\\/]/).at(-1)}:${frame.lineNumber + 1}`
      : "?";
  };
  // Profile timestamps are monotonic; align the profile's end with the moment it was taken.
  const offset =
    Date.now() * 1000 -
    (profile.startTime + profile.timeDeltas.reduce((sum, delta) => sum + delta, 0));
  const total = new Map<string, number>();
  let time = profile.startTime + offset;
  profile.samples.forEach((sample, index) => {
    time += profile.timeDeltas[index] ?? 0;
    if (time < fromUs || time > toUs) return;
    const seen = new Set<string>();
    for (let id: number | undefined = sample; id !== undefined; id = parent.get(id)) {
      const name = label(id);
      if (!seen.has(name)) total.set(name, (total.get(name) ?? 0) + SAMPLE_US / 1000);
      seen.add(name);
    }
  });
  const lines = [...total.entries()]
    .filter(([name]) => !/^\((root|idle|program|garbage collector)\)/.test(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, ms]) => `    ${Math.round(ms)} ms in ${name}`);
  return lines.length ? lines.join("\n") : "    (no JavaScript samples: native or GC work)";
}
