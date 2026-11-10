// Session-read benchmark, headless, read-only over pi session files.
//   node tools/bench-sessions.mjs <sessionsRoot> <bigFile> [runs] [pi|sidecar]
// pi      = what Pegasus did before: SessionManager.list/open + transcriptFromSession in the main process.
// sidecar = the same app functions routed through crates/pegasus-core (cache file: PEGASUS_SIDECAR_CACHE).
import { serialize } from "node:v8";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { dirname } from "node:path";

const [root, big, runsArg, mode = "pi"] = process.argv.slice(2);
process.env.PI_CODING_AGENT_DIR = dirname(root); // sessions live at <agentDir>/sessions
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { transcriptFromSession } = await import("../packages/pi-sdk-driver/dist/session-supervisor-utils.js");
const { listSessionInfos, openTranscriptSource, sliceSessionRows, closeSidecar } = await import("../packages/pi-sdk-driver/dist/sidecar-client.js");

const runs = Number(runsArg ?? 10);
const useRs = mode === "sidecar";
const ms = (t) => +(performance.now() - t).toFixed(1);
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)];
const report = (name, a) => console.log(JSON.stringify({ mode, name, runs: a.length, first: a[0], median: pct(a, 0.5), p95: pct(a, 0.95), worst: Math.max(...a) }));

const cwds = [...new Set((await SessionManager.listAll()).map((x) => x.cwd))];
const loop = monitorEventLoopDelay({ resolution: 1 });
const listAll = [], listPerCwd = [], open = [], proj = [], total = [], ser = [], slice = [];
let items, bytes = 0, count = 0;
loop.enable();
for (let i = 0; i < runs; i++) {
  let t = performance.now();
  if (!useRs) { await SessionManager.listAll(); listAll.push(ms(t)); }

  // What the app does at startup/sync: one list per workspace cwd, in parallel.
  t = performance.now();
  const lists = await Promise.all(cwds.map((c) => (useRs ? listSessionInfos(c) : SessionManager.list(c))));
  listPerCwd.push(ms(t));
  count = lists.reduce((n, l) => n + l.length, 0);

  // Chat switch on the big session: getTranscript's readTranscriptFromDisk.
  const start = performance.now();
  t = performance.now();
  const src = useRs ? await openTranscriptSource(big) : SessionManager.open(big);
  open.push(ms(t));
  t = performance.now();
  items = transcriptFromSession(src);
  proj.push(ms(t));
  total.push(ms(start));

  t = performance.now();
  bytes = serialize(items).length; // structured-clone proxy for the per-update IPC payload
  ser.push(ms(t));

  if (useRs) { t = performance.now(); await sliceSessionRows(big, 100, 50); slice.push(ms(t)); }
}
loop.disable();
console.log(JSON.stringify({ mode, sessions: count, cwds: cwds.length, transcriptItems: items.length, ipcPayloadBytes: bytes }));
console.log(JSON.stringify({ mode, name: "event_loop_delay_ms(all phases)", p99: +(loop.percentile(99) / 1e6).toFixed(1), max: +(loop.max / 1e6).toFixed(1) }));
if (!useRs) report("list_all_sessions", listAll);
report("list_per_workspace_cwd(app startup)", listPerCwd);
report(useRs ? "context_read(sidecar)" : "open_big_session(SessionManager.open)", open);
report("project_transcript", proj);
report("CHAT_SWITCH_total(open+project)", total);
report("ipc_clone_per_update(v8.serialize)", ser);
if (useRs) report("slice_50_rows(sidecar)", slice);
closeSidecar();
