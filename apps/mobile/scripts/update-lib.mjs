// Pure helpers for self-hosted expo-updates (protocol v1): manifest building, code signing and
// the on-disk layout the Pegasus host serves (crates/pegasus-host/src/updates.rs reads it).
//
// <state>/latest.json              {"<runtimeVersion>": "<updateId>"}  (replaced atomically)
// <state>/updates/<id>/manifest.json  exact signed bytes served as the "manifest" part
// <state>/updates/<id>/signature      the expo-signature header value for those bytes
// <state>/updates/<id>/meta.json      {id, createdAt, runtimeVersion, sourceSha, contentKey, assets}
// <state>/assets/<sha256 hex>.<ext>   content-addressed files shared by all updates
import { createHash, createPublicKey, sign, verify, X509Certificate } from "node:crypto";

export const KEY_ID = "main";
export const KEEP_UPDATES = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXT = /^[a-z0-9]{1,8}$/;
const ASSET_NAME = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;

/** Update ids become directory names: only a lowercase UUID may reach a path join. */
export function isUpdateId(id) {
  return typeof id === "string" && UUID.test(id);
}

/** Same rule as the host's `safe_asset_name`: a sha256 hex name with a short extension, nothing else. */
export function isSafeAssetName(name) {
  return typeof name === "string" && ASSET_NAME.test(name);
}

/** The extension an exported file is stored under; refuses anything that could alter a path. */
export function safeExt(ext) {
  const e = String(ext ?? "")
    .replace(/^\./, "")
    .toLowerCase();
  if (!EXT.test(e)) throw new Error(`unsupported asset extension: ${JSON.stringify(ext)}`);
  return e;
}

// Kept in step with content_type() in crates/pegasus-host/src/updates.rs.
const TYPES = {
  hbc: "application/javascript",
  js: "application/javascript",
  bundle: "application/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
};

export function contentType(ext) {
  return TYPES[ext] ?? "application/octet-stream";
}

/**
 * The iOS bundle and assets from `expo export` metadata.json. Windows writes `assets\\x`, so
 * separators are normalised; any path that climbs out of the export folder is refused.
 */
export function iosFilesFromMetadata(metadata) {
  const ios = metadata?.fileMetadata?.ios;
  if (!ios || typeof ios.bundle !== "string") throw new Error("expo export produced no iOS bundle");
  const clean = (p) => {
    const rel = String(p).replace(/\\/g, "/");
    if (
      rel.startsWith("/") ||
      /^[a-z]:/i.test(rel) ||
      rel.split("/").some((s) => s === ".." || s === "")
    ) {
      throw new Error(`unsafe export path: ${JSON.stringify(p)}`);
    }
    return rel;
  };
  const bundleExt = safeExt(ios.bundle.split(".").pop());
  return {
    bundle: { path: clean(ios.bundle), ext: bundleExt },
    assets: (ios.assets ?? []).map((a) => ({ path: clean(a.path), ext: safeExt(a.ext) })),
  };
}

/** Hashes the protocol wants: `hash` is base64url sha256, `key` an md5 hex (as Expo's server). */
export function describeFile(bytes, ext) {
  const sha = createHash("sha256").update(bytes).digest();
  return {
    sha256: sha.toString("hex"),
    hash: sha.toString("base64url"),
    key: createHash("md5").update(bytes).digest("hex"),
    ext,
    contentType: contentType(ext),
    name: `${sha.toString("hex")}.${ext}`,
  };
}

/**
 * The expo-updates v1 manifest. Asset URLs are relative: the phone resolves them against its
 * configured update URL (ExpoUpdatesUpdate.swift resolveManifestAssetUrls), so the signed bytes
 * hold no host and the same update works over Tailscale and on 127.0.0.1.
 */
export function buildManifest({ id, createdAt, runtimeVersion, bundle, assets }) {
  if (!isUpdateId(id)) throw new Error(`bad update id ${id}`);
  if (!runtimeVersion) throw new Error("runtimeVersion is required");
  return {
    id,
    createdAt,
    runtimeVersion,
    launchAsset: {
      hash: bundle.hash,
      key: bundle.key,
      contentType: bundle.contentType,
      url: `assets/${bundle.name}`,
    },
    assets: assets.map((a) => ({
      hash: a.hash,
      key: a.key,
      contentType: a.contentType,
      fileExtension: `.${a.ext}`,
      url: `assets/${a.name}`,
    })),
    metadata: {},
    extra: {},
  };
}

/**
 * Identifies the code of an update; equal keys mean publishing again would change nothing. The
 * bundle counts by Metro's export name (a hash of the JS), not its bytes: Hermes bytecode of the
 * same JS differs from build to build, which would make every publish look new.
 */
export function contentKey(runtimeVersion, bundleExportPath, assets) {
  const parts = [runtimeVersion, bundleExportPath, ...assets.map((a) => a.sha256).sort()];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/**
 * The `expo-signature` value (an RFC 8941 dictionary) for the exact manifest bytes: RSA PKCS#1
 * v1.5 over SHA-256, the only algorithm the iOS client accepts (CodeSigningAlgorithm.swift).
 */
export function signatureHeader(bytes, privateKeyPem) {
  const sig = sign("sha256", bytes, privateKeyPem).toString("base64");
  return `sig="${sig}", keyid="${KEY_ID}"`;
}

/** Checks a signature header against the certificate the app embeds, as the phone will. */
export function verifySignatureHeader(bytes, header, certificatePem) {
  const m = /^sig="([A-Za-z0-9+/=]+)", keyid="([^"]*)"$/.exec(header);
  if (!m || m[2] !== KEY_ID) return false;
  const key = createPublicKey(
    new X509Certificate(certificatePem).publicKey.export({ type: "spki", format: "pem" }),
  );
  return verify("sha256", bytes, key, Buffer.from(m[1], "base64"));
}

/**
 * Updates to delete: everything beyond the newest `keep`, except what latest.json points at
 * (a phone on an older native build still needs its runtime's latest update).
 */
export function updatesToPrune(metas, latest, keep = KEEP_UPDATES) {
  const pinned = new Set(Object.values(latest));
  const newestFirst = [...metas].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return newestFirst
    .slice(keep)
    .filter((m) => !pinned.has(m.id))
    .map((m) => m.id);
}

/** Asset files no kept update references. */
export function assetsToPrune(assetNames, keptMetas) {
  const used = new Set(keptMetas.flatMap((m) => m.assets));
  return assetNames.filter((n) => !used.has(n));
}

/**
 * createdAt decides what the phone loads: it only takes an update newer than the one it runs
 * (LoaderSelectionPolicyFilterAware.swift), so a new update is never older than the last one.
 */
export function nextCreatedAt(now, previousCreatedAt) {
  const prev = previousCreatedAt ? Date.parse(previousCreatedAt) : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(now.getTime(), prev + 1)).toISOString();
}
