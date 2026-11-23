import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assetsToPrune,
  buildManifest,
  contentKey,
  describeFile,
  iosFilesFromMetadata,
  isSafeAssetName,
  isUpdateId,
  nextCreatedAt,
  safeExt,
  signatureHeader,
  updatesToPrune,
  verifySignatureHeader,
} from "./update-lib.mjs";

const id = "0b6f3c9e-5d2a-4f1b-9c3e-7a8d6e5f4c3b";
const bundle = describeFile(Buffer.from("console.log(1)"), "hbc");
const png = describeFile(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "png");

test("manifest follows expo-updates v1 with relative, content-addressed asset URLs", () => {
  const m = buildManifest({
    id,
    createdAt: "2026-11-23T10:00:00.000Z",
    runtimeVersion: "rv1",
    bundle,
    assets: [png],
  });
  assert.equal(m.id, id);
  assert.equal(m.runtimeVersion, "rv1");
  assert.equal(m.launchAsset.url, `assets/${bundle.name}`);
  assert.equal(m.launchAsset.contentType, "application/javascript");
  assert.equal(m.assets[0].fileExtension, ".png");
  assert.equal(m.assets[0].contentType, "image/png");
  // hash is base64url sha256 (what the phone checks), key an md5 hex.
  assert.match(m.launchAsset.hash, /^[A-Za-z0-9_-]{43}$/);
  assert.match(m.launchAsset.key, /^[0-9a-f]{32}$/);
  assert.ok(isSafeAssetName(bundle.name) && isSafeAssetName(png.name));
  assert.throws(() =>
    buildManifest({ id: "../x", createdAt: "", runtimeVersion: "rv", bundle, assets: [] }),
  );
});

test("signature verifies against the certificate and fails for other bytes or keys", () => {
  const cert = readFileSync(new URL("../updates/certificate.pem", import.meta.url), "utf8");
  // The real key lives outside the repo; a stranger's key must be refused, as on the phone.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const bytes = Buffer.from('{"id":"x"}');
  const header = signatureHeader(bytes, privateKey.export({ type: "pkcs8", format: "pem" }));
  assert.match(header, /^sig="[A-Za-z0-9+/=]+", keyid="main"$/);
  assert.equal(verifySignatureHeader(bytes, header, cert), false);

  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const testCert = selfSigned(pair);
  const good = signatureHeader(bytes, pem);
  assert.equal(verifySignatureHeader(bytes, good, testCert), true);
  assert.equal(verifySignatureHeader(Buffer.from('{"id":"y"}'), good, testCert), false);
  assert.equal(
    verifySignatureHeader(bytes, good.replace('keyid="main"', 'keyid="other"'), testCert),
    false,
  );
});

test("path safety: ids, asset names, extensions and export paths", () => {
  assert.ok(isUpdateId(id));
  for (const bad of ["../etc", id.toUpperCase(), `${id}/..`, "", null])
    assert.equal(isUpdateId(bad), false, String(bad));
  for (const bad of [
    "../a.png",
    `${"a".repeat(64)}.png/..`,
    `${"A".repeat(64)}.png`,
    `${"a".repeat(63)}.png`,
    `${"a".repeat(64)}`,
    `${"a".repeat(64)}.p/g`,
    "x.png",
  ]) {
    assert.equal(isSafeAssetName(bad), false, bad);
  }
  assert.equal(safeExt(".PNG"), "png");
  assert.throws(() => safeExt("png/../x"));
  assert.throws(() => safeExt(""));

  const files = iosFilesFromMetadata({
    fileMetadata: {
      ios: {
        bundle: "_expo\\static\\js\\ios\\index-1.hbc",
        assets: [{ path: "assets\\abc", ext: "png" }],
      },
    },
  });
  assert.equal(files.bundle.path, "_expo/static/js/ios/index-1.hbc");
  assert.equal(files.bundle.ext, "hbc");
  assert.equal(files.assets[0].path, "assets/abc");
  for (const p of ["../secret", "assets/../../x", "/etc/passwd", "C:\\Windows\\x", "a//b"]) {
    assert.throws(
      () =>
        iosFilesFromMetadata({
          fileMetadata: { ios: { bundle: "b.hbc", assets: [{ path: p, ext: "png" }] } },
        }),
      p,
    );
  }
  assert.throws(() => iosFilesFromMetadata({ fileMetadata: {} }));
});

test("keeps the newest five and every runtime's latest; prunes unreferenced assets", () => {
  const metas = Array.from({ length: 8 }, (_, i) => ({
    id: `u${i}`,
    createdAt: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(),
    assets: [`a${i}`, "shared"],
  }));
  // u1 is still latest for an older native build's runtime.
  const drop = updatesToPrune(metas, { rvNew: "u7", rvOld: "u1" });
  assert.deepEqual(drop.sort(), ["u0", "u2"]);
  const kept = metas.filter((m) => !drop.includes(m.id));
  assert.deepEqual(assetsToPrune(["a0", "a1", "a2", "a7", "shared", "orphan"], kept).sort(), [
    "a0",
    "a2",
    "orphan",
  ]);
});

test("content key ignores asset order; createdAt always moves forward", () => {
  const b = "_expo/static/js/ios/index-1.hbc";
  assert.equal(contentKey("rv", b, [png, bundle]), contentKey("rv", b, [bundle, png]));
  assert.notEqual(contentKey("rv", b, [png]), contentKey("rv2", b, [png]));
  assert.notEqual(
    contentKey("rv", b, [png]),
    contentKey("rv", "_expo/static/js/ios/index-2.hbc", [png]),
  );
  const now = new Date("2026-11-23T10:00:00.000Z");
  assert.equal(nextCreatedAt(now, null), now.toISOString());
  assert.equal(nextCreatedAt(now, "2026-11-23T11:00:00.000Z"), "2026-11-23T11:00:00.001Z");
});

/** A minimal self-signed X.509 certificate for a test key, built with the DER encoder below. */
function selfSigned({ publicKey, privateKey }) {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const seq = (...p) => der(0x30, Buffer.concat(p));
  const int = (n) => der(0x02, Buffer.from([n]));
  const oid = (hex) => der(0x06, Buffer.from(hex, "hex"));
  const sha256Rsa = seq(oid("2a864886f70d01010b"), Buffer.from([0x05, 0x00]));
  const name = seq(der(0x31, seq(oid("550403"), der(0x0c, Buffer.from("test")))));
  const time = (s) => der(0x17, Buffer.from(s));
  const tbs = seq(
    der(0xa0, int(2)),
    int(1),
    sha256Rsa,
    name,
    seq(time("250101000000Z"), time("350101000000Z")),
    name,
    spki,
  );
  const sig = sign("sha256", tbs, privateKey);
  const cert = seq(tbs, sha256Rsa, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  return `-----BEGIN CERTIFICATE-----\n${cert
    .toString("base64")
    .match(/.{1,64}/g)
    .join("\n")}\n-----END CERTIFICATE-----\n`;
}

function der(tag, body) {
  const len = body.length;
  const head =
    len < 0x80
      ? Buffer.from([len])
      : len < 0x100
        ? Buffer.from([0x81, len])
        : Buffer.from([0x82, len >> 8, len & 0xff]);
  return Buffer.concat([Buffer.from([tag]), head, body]);
}
