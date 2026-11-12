import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runElectronBuilder } from "./run-electron-builder.mjs";

const electronBuilderArgs = process.argv.slice(2);
if (electronBuilderArgs.length === 0) {
  throw new Error("Usage: package-windows.mjs <electron-builder args...>");
}

// electron-builder copies crates/target/release/pegasus-host.exe into resources/bin and silently skips
// it when missing, which shipped a self-update build with no host (and a stale one is just as wrong).
// Build it here, versioned like scripts/release.mjs does, so every Windows package carries the host
// built from the same commit. Cargo is incremental: an up-to-date host costs a few seconds.
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cratesDir = path.resolve(desktopDir, "..", "..", "crates");
const { version } = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const env = { ...process.env, PEGASUS_APP_VERSION: version };
execFileSync("cargo", ["build", "--release", "-p", "pegasus-host"], {
  cwd: cratesDir,
  env,
  stdio: "inherit",
  windowsHide: true,
});
const host = path.join(cratesDir, "target", "release", "pegasus-host.exe");
if (!existsSync(host)) throw new Error(`cargo did not produce ${host}`);
const reported = execFileSync(host, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
if (reported !== `pegasus-host ${version}`) {
  throw new Error(`pegasus-host reports '${reported}', not ${version}`);
}

process.exit(await runElectronBuilder(electronBuilderArgs));
