// Equivalence check: Rust sidecar vs pi's SessionManager on the real session files (read-only).
// Usage: node tools/verify-sidecar.mjs <sessionsRoot> <cacheFile>
import { dirname } from "node:path";
import { readFileSync } from "node:fs";

const [root, cache] = process.argv.slice(2);
process.env.PI_CODING_AGENT_DIR = dirname(root);
process.env.PEGASUS_SIDECAR_CACHE = cache;
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { transcriptFromSession } =
  await import("../packages/pi-sdk-driver/dist/session-supervisor-utils.js");
const { listSessionInfos, openTranscriptSource, closeSidecar } =
  await import("../packages/pi-sdk-driver/dist/sidecar-client.js");

const norm = (p) => p.replaceAll("\\", "/").toLowerCase();
const row = (s) =>
  JSON.stringify([
    norm(s.path),
    s.id,
    s.cwd,
    s.name ?? null,
    s.parentSessionPath ?? null,
    s.created.getTime(),
    s.modified.getTime(),
    s.messageCount,
    s.firstMessage,
  ]);

const all = await SessionManager.listAll();
const cwds = [...new Set(all.map((s) => s.cwd))];
let listBad = 0,
  listTotal = 0;
for (const cwd of cwds) {
  const [a, b] = await Promise.all([SessionManager.list(cwd), listSessionInfos(cwd)]);
  const ra = new Map(a.map((s) => [norm(s.path), row(s)]));
  const rb = new Map(b.map((s) => [norm(s.path), row(s)]));
  listTotal += ra.size;
  for (const [k, v] of ra)
    if (rb.get(k) !== v) {
      listBad++;
      console.log("LIST MISMATCH", cwd, "\n pi ", v, "\n rs ", rb.get(k));
    }
  for (const k of rb.keys())
    if (!ra.has(k)) {
      listBad++;
      console.log("EXTRA in sidecar", k);
    }
}
console.log(
  JSON.stringify({ listing: { cwds: cwds.length, sessions: listTotal, mismatches: listBad } }),
);

let tBad = 0,
  tOk = 0,
  tSkip = 0;
for (const s of all) {
  const head = JSON.parse(readFileSync(s.path, "utf8").split("\n", 1)[0]);
  if ((head.version ?? 1) < 3) {
    tSkip++;
    continue;
  } // SessionManager.open would migrate AND rewrite the file
  const viaPi = JSON.stringify(transcriptFromSession(SessionManager.open(s.path)));
  const viaRs = JSON.stringify(transcriptFromSession(await openTranscriptSource(s.path)));
  if (viaPi === viaRs) tOk++;
  else {
    tBad++;
    console.log("TRANSCRIPT MISMATCH", s.path, viaPi.length, viaRs.length);
  }
}
console.log(
  JSON.stringify({ transcripts: { identical: tOk, mismatches: tBad, skippedOldSchema: tSkip } }),
);
closeSidecar();
process.exit(listBad + tBad === 0 ? 0 : 1);
