import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../dist/node/atomic-write.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-atomic-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await test("writes new content and creates missing directories", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "nested", "catalog.json");
    await writeFileAtomic(target, "hello");
    assert.equal(await readFile(target, "utf8"), "hello");
  });
});

await test("leaves only the target file behind, no lingering temp files", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "catalog.json");
    await writeFileAtomic(target, "one");
    await writeFileAtomic(target, "two");
    const entries = await readdir(dir);
    assert.deepEqual(entries, ["catalog.json"]);
    assert.equal(await readFile(target, "utf8"), "two");
  });
});

await test("concurrent writes never collide or leave a partial file; result is one of the inputs", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "catalog.json");
    const payloads = Array.from({ length: 40 }, (_, i) => `payload-${i}-${"x".repeat(i * 32)}`);

    await Promise.all(payloads.map((payload) => writeFileAtomic(target, payload)));

    // A partial/truncated file would not exactly equal any input payload.
    const finalContent = await readFile(target, "utf8");
    assert.ok(payloads.includes(finalContent), "final content must be exactly one written payload");

    // Collision-safe temp names mean no *.tmp survivors from the racing writers.
    const entries = await readdir(dir);
    assert.deepEqual(entries, ["catalog.json"]);
  });
});

await test(
  "on Windows, waits out a reader that briefly holds the file without delete sharing",
  { skip: process.platform !== "win32" },
  async () => {
    const { spawn } = await import("node:child_process");
    const { writeFile } = await import("node:fs/promises");
    await withTempDir(async (dir) => {
      const target = join(dir, "catalogs.json");
      await writeFile(target, "old");
      // FileShare.Read only, like a virus scan: replacing the file is refused until it closes.
      const script = `$f=[System.IO.File]::Open('${target}','Open','Read','Read'); [Console]::Out.WriteLine('held'); Start-Sleep -Milliseconds 400; $f.Close()`;
      const holder = spawn("powershell.exe", ["-NoProfile", "-Command", script]);
      const exited = new Promise((resolve) => holder.on("exit", resolve));
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("held")) resolve();
        });
        holder.on("error", reject);
      });
      // While held, a plain replace is refused: the case this guards.
      const { rename } = await import("node:fs/promises");
      await writeFile(join(dir, "probe"), "x");
      await assert.rejects(rename(join(dir, "probe"), target), { code: "EPERM" });
      await writeFileAtomic(target, "new");
      assert.equal(await readFile(target, "utf8"), "new");
      await exited;
    });
  },
);
