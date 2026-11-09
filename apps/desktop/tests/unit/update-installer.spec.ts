import { expect, test } from "@playwright/test";
import { hostVersionDrift } from "../../contracts/updates";
import { releaseAssets } from "../../electron/platform/update-checker";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  installerAssetName,
  parseChecksums,
  pruneUpdateDownloads,
} from "../../electron/platform/update-installer";

test("each platform installs only its own release asset", () => {
  expect(installerAssetName("1.0.9", "win32", "x64")).toBe("Pegasus-1.0.9-x64-setup.exe");
  expect(installerAssetName("1.0.9", "darwin", "arm64")).toBe("Pegasus-1.0.9-arm64-mac.zip");
  expect(installerAssetName("1.0.9", "darwin", "x64")).toBeUndefined();
  expect(installerAssetName("1.0.9", "linux", "x64")).toBeUndefined();
});

test("SHA256SUMS lines map file names to lowercase hashes", () => {
  const hash = "A".repeat(64);
  const sums = parseChecksums(
    `${hash}  Pegasus-1.0.9-x64-setup.exe\r\n${"b".repeat(64)} *Pegasus-1.0.9-arm64-mac.zip\nnot a line\n`,
  );
  expect(sums.get("Pegasus-1.0.9-x64-setup.exe")).toBe("a".repeat(64));
  expect(sums.get("Pegasus-1.0.9-arm64-mac.zip")).toBe("b".repeat(64));
  expect(sums.size).toBe(2);
});

test("release assets are used only from this repository's release downloads", () => {
  const assets = releaseAssets({
    tag_name: "v1.0.9",
    assets: [
      {
        name: "SHA256SUMS.txt",
        browser_download_url:
          "https://github.com/geonq/pegasus/releases/download/v1.0.9/SHA256SUMS.txt",
        size: 200,
      },
      { name: "evil.exe", browser_download_url: "https://example.com/evil.exe", size: 1 },
      { name: 3, browser_download_url: "https://github.com/geonq/pegasus/releases/download/x" },
    ],
  });
  expect(assets).toEqual([
    {
      name: "SHA256SUMS.txt",
      url: "https://github.com/geonq/pegasus/releases/download/v1.0.9/SHA256SUMS.txt",
      size: 200,
    },
  ]);
});

test("the Mac notices when its Windows host runs another version", () => {
  const status = { phase: "idle" as const, currentVersion: "1.0.9" };
  expect(hostVersionDrift(status)).toBeUndefined();
  expect(hostVersionDrift({ ...status, hostVersion: "1.0.9" })).toBeUndefined();
  expect(hostVersionDrift({ ...status, hostVersion: "1.0.10" })).toBe("host-newer");
  expect(hostVersionDrift({ ...status, hostVersion: "1.0.8" })).toBe("host-older");
});

test("only the running version's update download is kept", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pegasus-updates-"));
  for (const version of ["1.0.10", "1.0.13", "1.0.21"]) {
    await mkdir(path.join(root, version, "extracted"), { recursive: true });
    await writeFile(path.join(root, version, "Pegasus.zip"), "x");
  }
  await pruneUpdateDownloads(root, "1.0.21");
  expect(await readdir(root)).toEqual(["1.0.21"]);
  await pruneUpdateDownloads(path.join(root, "missing"), "1.0.21");
});
