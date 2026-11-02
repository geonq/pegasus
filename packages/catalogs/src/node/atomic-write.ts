import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Suffix of the transient files writeFileAtomic creates before renaming into place. */
export const TMP_SUFFIX = ".tmp";

let tmpCounter = 0;

/**
 * Write `data` to `filePath` durably. A concurrent reader or a crash at any
 * point always observes either the previous file contents or the fully-written
 * new contents — never a missing, truncated, or partially-written file.
 *
 * Steps:
 * - Write to a uniquely-named temp file in the same directory and fsync it.
 * - rename() straight over the target (atomic replace on POSIX). There is no
 *   unlink first, so a crash in the write window cannot leave the target gone.
 * - fsync the containing directory so the rename entry itself survives power
 *   loss, not just the temp file's data blocks.
 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  // Collision-safe temp name: a pid + monotonic counter + randomness so two
  // writers, or two writes within the same millisecond, never share a path
  // (Date.now() alone is not unique under concurrent writes).
  tmpCounter = (tmpCounter + 1) >>> 0;
  const tmpPath = `${filePath}.${process.pid}.${tmpCounter}.${randomBytes(6).toString("hex")}${TMP_SUFFIX}`;

  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await renameReplace(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  await syncDirectory(dir);
}

/** Serialize `value` as pretty JSON with a trailing newline and write it atomically. */
export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Windows refuses to replace a file another process has open (a reader, a virus scan) with EPERM,
 * EACCES or EBUSY for a moment. Retry briefly instead of failing the save; the old file stays put.
 */
async function renameReplace(src: string, dest: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(src, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const busy = code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EEXIST";
      if (process.platform !== "win32" || !busy || attempt >= 20) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(5 * 2 ** attempt, 100) + (attempt % 7)),
      );
    }
  }
}

async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
  } catch {
    // Some platforms (notably Windows) reject opening a directory for fsync.
    // The rename above is still atomic; skip the extra durability step.
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Best effort — a failed directory fsync must not fail the write.
  } finally {
    await handle.close();
  }
}
