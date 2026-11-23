#!/usr/bin/env node
// Publishes the phone app's JS as an over-the-air update that the Pegasus host serves.
//
//   node apps/mobile/scripts/publish-update.mjs [--json]
//   node apps/mobile/scripts/publish-update.mjs --rollback <updateId> [--json]
//
// Publish: `expo export --platform ios`, copy the files into <state>/assets by content hash, write a
// signed manifest to <state>/updates/<id>/, then point latest.json at it (rename, so the host never
// reads half a file). Keeps the newest 5 updates. Idempotent: a source SHA (PEGASUS_UPDATE_SOURCE_SHA)
// or code that is already published prints the existing update with "skipped": true.
// Rollback: republishes an earlier update's files under a new id and createdAt, because a phone
// only loads an update newer than the one it runs.
// The last stdout line with --json: {"id","runtimeVersion","previousId","skipped"[,"rolledBackTo"]}.
// <state> = PEGASUS_MOBILE_UPDATES_DIR or D:\Pi\pi-ecosystem\.state\mobile-updates; the signing key
// is <state>\keys\private-key.pem (PEGASUS_UPDATE_KEY overrides) and never enters the repo.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assetsToPrune,
  buildManifest,
  contentKey,
  describeFile,
  iosFilesFromMetadata,
  isSafeAssetName,
  isUpdateId,
  nextCreatedAt,
  signatureHeader,
  updatesToPrune,
  verifySignatureHeader,
} from "./update-lib.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = resolve(process.env.PEGASUS_MOBILE_UPDATES_DIR || "D:\\Pi\\pi-ecosystem\\.state\\mobile-updates");
const keyPath = process.env.PEGASUS_UPDATE_KEY || join(stateDir, "keys", "private-key.pem");
const certPath = join(projectRoot, "updates", "certificate.pem");
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const rollbackAt = argv.indexOf("--rollback");
const log = (...a) => (json ? console.error : console.log)(...a);

function node(script, args) {
  return execFileSync(process.execPath, [join(projectRoot, "node_modules", ...script), ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

/** Write then rename: readers see the old file or the new one, never a partial one. */
async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function allMetas() {
  const dir = join(stateDir, "updates");
  const ids = existsSync(dir) ? (await readdir(dir)).filter(isUpdateId) : [];
  const metas = [];
  for (const id of ids) {
    const m = await readJson(join(dir, id, "meta.json"), null);
    if (m?.id === id) metas.push(m);
  }
  return metas;
}

/** Signs and stores one update, then switches latest.json for its runtime to it. */
async function writeUpdate({ runtimeVersion, files, sourceSha, key, previous }) {
  const privateKey = await readFile(keyPath, "utf8").catch(() => {
    throw new Error(`signing key missing at ${keyPath} (see apps/mobile/README.md, Updates)`);
  });
  const certificate = await readFile(certPath, "utf8");
  const id = randomUUID();
  const createdAt = nextCreatedAt(new Date(), previous?.createdAt);
  const manifest = buildManifest({ id, createdAt, runtimeVersion, bundle: files.bundle, assets: files.assets });
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = signatureHeader(bytes, privateKey);
  // A key that does not match the app's certificate would publish updates every phone rejects.
  if (!verifySignatureHeader(bytes, signature, certificate)) {
    throw new Error(`${keyPath} does not match ${certPath}; the phone would reject this update`);
  }
  const dir = join(stateDir, "updates", id);
  const tmp = `${dir}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await writeFile(join(tmp, "manifest.json"), bytes);
  await writeFile(join(tmp, "signature"), signature);
  const meta = {
    id,
    createdAt,
    runtimeVersion,
    sourceSha: sourceSha ?? null,
    contentKey: key,
    files,
    assets: [files.bundle.name, ...files.assets.map((a) => a.name)],
  };
  await writeFile(join(tmp, "meta.json"), JSON.stringify(meta, null, 2));
  await rename(tmp, dir);
  const latestPath = join(stateDir, "latest.json");
  const latest = await readJson(latestPath, {});
  await writeAtomic(latestPath, JSON.stringify({ ...latest, [runtimeVersion]: id }, null, 2));
  return meta;
}

async function prune() {
  const latest = await readJson(join(stateDir, "latest.json"), {});
  const metas = await allMetas();
  const drop = new Set(updatesToPrune(metas, latest));
  for (const id of drop) await rm(join(stateDir, "updates", id), { recursive: true, force: true });
  const kept = metas.filter((m) => !drop.has(m.id));
  const assetDir = join(stateDir, "assets");
  const names = (await readdir(assetDir)).filter(isSafeAssetName);
  for (const n of assetsToPrune(names, kept)) await rm(join(assetDir, n), { force: true });
  return drop.size;
}

async function publish() {
  const sourceSha = process.env.PEGASUS_UPDATE_SOURCE_SHA || null;
  const resolved = JSON.parse(node(["expo-updates", "bin", "cli.js"], ["runtimeversion:resolve", "--platform", "ios"]));
  const runtimeVersion = resolved.runtimeVersion;
  if (typeof runtimeVersion !== "string" || !runtimeVersion) throw new Error("could not resolve the runtime version");
  const latest = await readJson(join(stateDir, "latest.json"), {});
  const metas = await allMetas();
  const previous = metas.find((m) => m.id === latest[runtimeVersion]) ?? null;
  const already = sourceSha && metas.find((m) => m.sourceSha === sourceSha && m.runtimeVersion === runtimeVersion);
  if (already) {
    log(`update for ${sourceSha} already published as ${already.id}`);
    return { id: already.id, runtimeVersion, previousId: previous?.id ?? null, skipped: true };
  }

  const out = join(stateDir, "export.tmp");
  await rm(out, { recursive: true, force: true });
  log("expo export --platform ios ...");
  node(["expo", "bin", "cli"], ["export", "--platform", "ios", "--output-dir", out]);
  const exported = iosFilesFromMetadata(await readJson(join(out, "metadata.json"), null));
  await mkdir(join(stateDir, "assets"), { recursive: true });
  const store = async (f) => {
    const bytes = await readFile(join(out, f.path));
    const d = describeFile(bytes, f.ext);
    const target = join(stateDir, "assets", d.name);
    // Content-addressed: an existing file already holds these exact bytes.
    if (!existsSync(target)) {
      await copyFile(join(out, f.path), `${target}.tmp`);
      await rename(`${target}.tmp`, target);
    }
    return d;
  };
  const files = { bundle: await store(exported.bundle), assets: [] };
  for (const a of exported.assets) files.assets.push(await store(a));
  await rm(out, { recursive: true, force: true });

  const key = contentKey(runtimeVersion, exported.bundle.path, files.assets);
  if (previous && previous.contentKey === key) {
    log(`code unchanged since ${previous.id}; nothing to publish`);
    return { id: previous.id, runtimeVersion, previousId: previous.id, skipped: true };
  }
  const meta = await writeUpdate({ runtimeVersion, files, sourceSha, key, previous });
  log(`published ${meta.id} for runtime ${runtimeVersion}; pruned ${await prune()}`);
  return { id: meta.id, runtimeVersion, previousId: previous?.id ?? null, skipped: false };
}

async function rollback(targetId) {
  if (!isUpdateId(targetId)) throw new Error(`not an update id: ${targetId}`);
  const metas = await allMetas();
  const target = metas.find((m) => m.id === targetId);
  if (!target) throw new Error(`update ${targetId} is not kept on this PC`);
  const latest = await readJson(join(stateDir, "latest.json"), {});
  const previous = metas.find((m) => m.id === latest[target.runtimeVersion]) ?? null;
  const meta = await writeUpdate({
    runtimeVersion: target.runtimeVersion,
    files: target.files,
    sourceSha: target.sourceSha,
    key: target.contentKey,
    previous,
  });
  log(`rolled back to ${targetId}'s code as ${meta.id}; pruned ${await prune()}`);
  return { id: meta.id, runtimeVersion: meta.runtimeVersion, previousId: previous?.id ?? null, rolledBackTo: targetId, skipped: false };
}

try {
  const result = rollbackAt >= 0 ? await rollback(argv[rollbackAt + 1]) : await publish();
  console.log(json ? JSON.stringify(result) : `update id: ${result.id}${result.skipped ? " (unchanged)" : ""}`);
} catch (e) {
  console.error(`publish-update failed: ${e?.message ?? e}`);
  process.exit(1);
}
