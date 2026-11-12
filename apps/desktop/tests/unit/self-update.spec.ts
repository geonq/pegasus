import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  consumeResume,
  resumeMessage,
  watchQuitRequest,
  writeHealthy,
} from "../../electron/platform/self-update";

const tempDir = () => mkdtemp(join(tmpdir(), "self-update-"));

test("consumeResume returns the marker and result once, then nothing", async () => {
  const dir = await tempDir();
  expect(await consumeResume(dir)).toBeUndefined();
  await writeFile(join(dir, "resume.json"), JSON.stringify({ sessionId: "s1", note: "check it" }));
  await writeFile(join(dir, "result.json"), JSON.stringify({ status: "rolled-back", detail: "x" }));
  const pending = await consumeResume(dir);
  expect(pending?.marker).toEqual({ sessionId: "s1", note: "check it" });
  expect(pending?.result).toEqual({ status: "rolled-back", detail: "x" });
  expect(await consumeResume(dir)).toBeUndefined();
});

test("consumeResume treats a missing result as installed and drops a broken marker", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "resume.json"), JSON.stringify({ sessionId: "s1", note: "" }));
  expect((await consumeResume(dir))?.result?.status).toBe("installed");
  await writeFile(join(dir, "resume.json"), "{not json");
  expect(await consumeResume(dir)).toBeUndefined();
  expect(existsSync(join(dir, "resume.json"))).toBe(false);
});

test("resumeMessage names the version and reports a rollback", () => {
  const marker = { sessionId: "s1", note: "verify splitters" };
  expect(resumeMessage(marker, { status: "installed" }, "1.0.24")).toContain(
    "Pegasus restarted on version 1.0.24 after your update; continue.",
  );
  const back = resumeMessage(marker, { status: "rolled-back", detail: "no heartbeat" }, "1.0.23");
  expect(back).toContain("previous install was restored");
  expect(back).toContain("no heartbeat");
});

test("writeHealthy leaves a fresh heartbeat for the helper", async () => {
  const dir = join(await tempDir(), "self-update");
  const before = Date.now();
  await writeHealthy(dir, "1.0.24");
  const beat: unknown = JSON.parse(await readFile(join(dir, "healthy.json"), "utf8"));
  expect(beat).toMatchObject({ version: "1.0.24" });
  if (typeof beat !== "object" || beat === null || !("at" in beat))
    throw new Error("no heartbeat time");
  expect(beat.at).toBeGreaterThanOrEqual(before);
});

test("a quit request written before this process started is not obeyed", async () => {
  // The update was scheduled while no Pegasus ran: the request still lies there when the new build
  // starts, minutes young but older than the process. Obeying it quit the freshly installed app.
  const dir = join(await tempDir(), "self-update");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "quit.request"),
    JSON.stringify({ createdAt: Math.floor(performance.timeOrigin) - 1_000 }),
  );
  let quits = 0;
  const stop = watchQuitRequest(dir, () => (quits += 1));
  await expect.poll(() => existsSync(join(dir, "quit.request"))).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  stop();
  expect(quits).toBe(0);
});

test("watchQuitRequest quits once for a fresh request and ignores a stale one", async () => {
  const dir = join(await tempDir(), "self-update");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "quit.request"), JSON.stringify({ createdAt: Date.now() - 3_600_000 }));
  let quits = 0;
  const stop = watchQuitRequest(dir, () => (quits += 1));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(existsSync(join(dir, "quit.request"))).toBe(false);
  await writeFile(join(dir, "quit.request"), JSON.stringify({ createdAt: Date.now() }));
  await expect.poll(() => existsSync(join(dir, "quit.request"))).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  stop();
  expect(quits).toBe(1);
});
