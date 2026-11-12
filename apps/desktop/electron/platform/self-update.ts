import { watch } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The app's side of an agent-driven self-update (the agent tool and the install helper live in pi-ecosystem:
 * src/pegasus-update.mjs, scripts/Install-PegasusUpdate.ps1). The three sides talk through small files in
 * <userData>/self-update:
 *   quit.request  agent tool -> app: quit now, the helper is waiting
 *   resume.json   agent tool -> new app: which chat to continue and why
 *   result.json   helper -> new app: "installed" or "rolled-back"
 *   healthy.json  new app -> helper: startup finished (the helper rolls back without it)
 */
export interface ResumeMarker {
  readonly sessionId: string;
  readonly note: string;
}

export interface UpdateResult {
  readonly status: "installed" | "rolled-back";
  readonly detail?: string;
}

const QUIT_REQUEST_MAX_AGE_MS = 10 * 60_000;
const QUIT_DELAY_MS = 3_000;

export const selfUpdateDir = (userDataDir: string) => path.join(userDataDir, "self-update");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The file's JSON object; undefined when the file is missing or not an object (the other side may not have written yet). */
async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(isRecord(error) && error.code === "ENOENT")) {
      console.error("[self-update] cannot read", file, error);
    }
    return undefined;
  }
}

/** Reads and deletes the resume marker and the helper's result; undefined when no update is pending. */
export async function consumeResume(
  dir: string,
): Promise<{ marker: ResumeMarker; result: UpdateResult | undefined } | undefined> {
  const marker = await readJson(path.join(dir, "resume.json"));
  const result = await readJson(path.join(dir, "result.json"));
  await rm(path.join(dir, "resume.json"), { force: true });
  await rm(path.join(dir, "result.json"), { force: true });
  const sessionId = marker?.sessionId;
  const note = marker?.note;
  if (typeof sessionId !== "string" || !sessionId || typeof note !== "string") return undefined;
  const detail = result?.detail;
  return {
    marker: { sessionId, note },
    result: {
      status: result?.status === "rolled-back" ? "rolled-back" : "installed",
      ...(typeof detail === "string" ? { detail } : {}),
    },
  };
}

/** The follow-up the restarted agent receives. */
export function resumeMessage(
  marker: ResumeMarker,
  result: UpdateResult | undefined,
  version: string,
): string {
  const note = marker.note ? ` Your note before the restart: ${marker.note}` : "";
  if (result?.status === "rolled-back") {
    return (
      `Pegasus restarted on version ${version}, but the update you scheduled did not start healthy and the previous install was restored` +
      `${result.detail ? ` (${result.detail})` : ""}. Find out why, fix it and try again.${note}`
    );
  }
  return `Pegasus restarted on version ${version} after your update; continue.${note}`;
}

/** Tells the helper that this start finished. */
export async function writeHealthy(dir: string, version: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "healthy.json"),
    JSON.stringify({ pid: process.pid, version, at: Date.now() }),
  );
}

/**
 * Calls `onQuit` once a fresh quit.request appears (after a short delay, so the agent's tool result
 * is saved first). Returns a stop function.
 */
export function watchQuitRequest(dir: string, onQuit: () => void): () => void {
  const file = path.join(dir, "quit.request");
  let handled = false;
  const check = async () => {
    const createdAt = (await readJson(file))?.createdAt;
    if (handled || typeof createdAt !== "number") return;
    // fs.watch fires several events per write; claim the request before awaiting so only one check quits.
    // A request older than this process was meant for the app that ran when the update was scheduled.
    // When none ran, it is still lying here as the new build starts, and obeying it quit the freshly
    // installed Pegasus 5 s after it reported healthy.
    const fresh =
      createdAt >= performance.timeOrigin && Date.now() - createdAt <= QUIT_REQUEST_MAX_AGE_MS;
    if (fresh) handled = true;
    await rm(file, { force: true });
    if (fresh) setTimeout(onQuit, QUIT_DELAY_MS);
  };
  let watcher: ReturnType<typeof watch> | undefined;
  const checkNow = () => {
    check().catch((error: unknown) => console.error("[self-update] quit check failed", error));
  };
  mkdir(dir, { recursive: true })
    .then(() => {
      watcher = watch(dir, checkNow);
      checkNow();
    })
    .catch((error: unknown) => console.error("[self-update] cannot watch", dir, error));
  return () => watcher?.close();
}
