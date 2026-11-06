import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { app, net } from "electron";
import type { UpdateStatus } from "../../contracts/updates";
import { checkForUpdate, type UpdateCheckResult } from "./update-checker";

const execFileAsync = promisify(execFile);
const CHECKSUMS_ASSET = "SHA256SUMS.txt";
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 15_000;

/** The release asset this build installs from, or undefined where self-update is not supported. */
export function installerAssetName(
  version: string,
  platform = process.platform,
  arch = process.arch,
) {
  if (platform === "win32" && arch === "x64") return `Pegasus-${version}-x64-setup.exe`;
  if (platform === "darwin" && arch === "arm64") return `Pegasus-${version}-arm64-mac.zip`;
  return undefined;
}

/** `sha256  name` lines (sha256sum format) to a name -> hash map. */
export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

interface UpdaterOptions {
  /** Version of the Windows host when this app is the Mac remote client. */
  readonly getHostVersion?: () => Promise<string | undefined>;
  /** Packaged builds only: a dev or test run never replaces itself. */
  readonly canInstall: boolean;
}

/**
 * Checks GitHub Releases, then downloads the installer for this platform, verifies it against the
 * release's SHA256SUMS.txt and installs it: the Windows NSIS installer runs silently, the Mac zip
 * replaces the app bundle (a backup restores it if anything fails). The app relaunches afterwards.
 */
export class AppUpdater {
  private status: UpdateStatus = { phase: "idle", currentVersion: app.getVersion() };
  private latest: Extract<UpdateCheckResult, { status: "update-available" }> | undefined;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly options: UpdaterOptions) {}

  getStatus(): UpdateStatus {
    return this.status;
  }

  subscribe(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): () => void {
    const run = () => void this.check().catch(() => undefined);
    this.timers = [setTimeout(run, INITIAL_DELAY_MS), setInterval(run, CHECK_INTERVAL_MS)];
    void pruneUpdateDownloads(
      path.join(app.getPath("userData"), "updates"),
      app.getVersion(),
    ).catch((error: unknown) => {
      console.error("[updates] pruning old downloads failed", error);
    });
    return () => {
      for (const timer of this.timers) clearTimeout(timer);
      this.timers = [];
    };
  }

  async check(): Promise<UpdateStatus> {
    if (this.status.phase === "downloading" || this.status.phase === "installing") {
      return this.status;
    }
    const [result, hostVersion] = await Promise.all([
      checkForUpdate(),
      this.options.getHostVersion?.().catch(() => undefined),
    ]);
    const base = {
      currentVersion: app.getVersion(),
      ...(hostVersion ? { hostVersion } : {}),
    };
    if (result.status === "error") {
      this.latest = undefined;
      this.publish({ ...base, phase: "idle", message: result.message });
    } else if (result.status === "update-available") {
      this.latest = result;
      const asset = installerAssetName(result.latestVersion);
      const installable =
        this.options.canInstall &&
        Boolean(asset && result.assets.some((entry) => entry.name === asset)) &&
        result.assets.some((entry) => entry.name === CHECKSUMS_ASSET);
      this.publish({
        ...base,
        phase: "available",
        latestVersion: result.latestVersion,
        releaseUrl: result.releaseUrl,
        canInstall: installable,
      });
    } else {
      this.latest = undefined;
      this.publish({ ...base, phase: "idle", latestVersion: result.latestVersion });
    }
    return this.status;
  }

  async install(): Promise<UpdateStatus> {
    const release = this.latest;
    if (!release || this.status.phase !== "available" || !this.status.canInstall) {
      throw new Error("No installable Pegasus update is available.");
    }
    const assetName = installerAssetName(release.latestVersion)!;
    const asset = release.assets.find((entry) => entry.name === assetName)!;
    const checksums = release.assets.find((entry) => entry.name === CHECKSUMS_ASSET)!;
    const directory = path.join(app.getPath("userData"), "updates", release.latestVersion);
    try {
      this.publish({ ...this.status, phase: "downloading", progress: 0, message: undefined });
      const expected = parseChecksums(await (await fetchOk(checksums.url)).text()).get(assetName);
      if (!expected) throw new Error(`${CHECKSUMS_ASSET} has no checksum for ${assetName}.`);
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, assetName);
      const actual = await this.download(asset.url, file, asset.size);
      if (actual !== expected)
        throw new Error("The downloaded update does not match its checksum.");
      this.publish({ ...this.status, phase: "installing", progress: 1 });
      if (process.platform === "win32") await installWindows(file, directory);
      else await installMac(file, directory, release.latestVersion);
      // The helper waits for this process to exit, installs and starts the new version.
      setTimeout(() => app.quit(), 500);
      return this.status;
    } catch (error) {
      this.publish({
        ...this.status,
        phase: "error",
        message: error instanceof Error ? error.message : "The update could not be installed.",
      });
      throw error;
    }
  }

  private async download(url: string, file: string, size: number): Promise<string> {
    const response = await fetchOk(url);
    if (!response.body) throw new Error("The update download was empty.");
    const hash = createHash("sha256");
    let received = 0;
    let reported = 0;
    const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    source.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      const progress = size > 0 ? Math.min(received / size, 1) : 0;
      if (progress - reported >= 0.02) {
        reported = progress;
        this.publish({ ...this.status, progress });
      }
    });
    await pipeline(source, createWriteStream(file));
    return hash.digest("hex");
  }

  /** Re-reads the Windows host's version (after a reconnect the host may run a new build). */
  async refreshHostVersion(): Promise<void> {
    const hostVersion = await this.options.getHostVersion?.().catch(() => undefined);
    if (!hostVersion || hostVersion === this.status.hostVersion) return;
    this.publish({ ...this.status, hostVersion });
  }

  private publish(status: UpdateStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // One closed window must not stop the others from hearing about the update.
      }
    }
  }
}

async function fetchOk(url: string): Promise<Response> {
  const response = await net.fetch(url, { headers: { Accept: "application/octet-stream" } });
  if (!response.ok) throw new Error(`The update download returned ${response.status}.`);
  return response;
}

/**
 * Runs the NSIS installer silently into the current install folder once Pegasus and its helper
 * processes have exited, then starts the new version. Every step is logged next to the installer.
 */
/**
 * Once a version runs, the downloads of every other version are dead weight (about 1 GB each on the Mac,
 * where nothing removed them). The running version's folder stays: it holds previous.app, the rollback copy.
 */
export async function pruneUpdateDownloads(
  directory: string,
  currentVersion: string,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== currentVersion)
      .map((entry) =>
        rm(path.join(directory, entry.name), { recursive: true, force: true }).catch(
          () => undefined,
        ),
      ),
  );
}

async function installWindows(installer: string, directory: string): Promise<void> {
  const installDir = path.dirname(process.execPath);
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = path.join(directory, "install-update.ps1");
  const log = path.join(directory, "install-update.log");
  await writeFile(
    script,
    [
      "$ErrorActionPreference = 'Stop'",
      `Start-Transcript -Path ${quote(log)} -Force | Out-Null`,
      "try {",
      `  Wait-Process -Id ${process.pid} -Timeout 120 -ErrorAction SilentlyContinue`,
      // Renderer, GPU and agent processes run from the install folder too; NSIS cannot replace
      // files they hold, so wait for them and stop what is left.
      `  $folder = ${quote(`${installDir}\\`)}`,
      "  $deadline = (Get-Date).AddSeconds(60)",
      "  do {",
      "    $left = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase) })",
      "    if ($left.Count -eq 0) { break }",
      "    Start-Sleep -Milliseconds 500",
      "  } while ((Get-Date) -lt $deadline)",
      "  $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      `  $setup = Start-Process -FilePath ${quote(installer)} -ArgumentList '/S', ${quote(`/D=${installDir}`)} -Wait -PassThru`,
      "  Write-Output ('installer exit ' + $setup.ExitCode)",
      "} finally {",
      `  Start-Process -FilePath ${quote(process.execPath)} -WorkingDirectory ${quote(installDir)}`,
      "  Stop-Transcript | Out-Null",
      "}",
    ].join("\r\n"),
    "utf8",
  );
  // A child of Pegasus dies with it (Windows ends the app's whole process tree on quit), so the
  // helper is created by WMI instead: it then outlives Pegasus. The launcher only waits for that.
  const command = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; ` +
        `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quote(command)}; ProcessStartupInformation = $startup }; ` +
        `Write-Output $result.ReturnValue`,
    ],
    { windowsHide: true },
  );
  if (stdout.trim() !== "0") throw new Error("The update installer could not be started.");
}

/**
 * Unpacks and verifies the new bundle now; once Pegasus has exited a helper keeps a backup, swaps the
 * bundle in place, checks its signature (restoring the backup on failure) and reopens it.
 */
async function installMac(zip: string, directory: string, version: string): Promise<void> {
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  if (path.extname(bundle) !== ".app")
    throw new Error("Pegasus is not running from an app bundle.");
  const extracted = path.join(directory, "extracted");
  await mkdir(extracted, { recursive: true });
  await execFileAsync("/usr/bin/ditto", ["-x", "-k", zip, extracted]);
  const name = (await readdir(extracted)).find((entry) => entry.endsWith(".app"));
  if (!name) throw new Error("The update archive has no app inside.");
  const next = path.join(extracted, name);
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", next]);
  const { stdout } = await execFileAsync("/usr/bin/plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    path.join(next, "Contents", "Info.plist"),
  ]);
  if (stdout.trim() !== version) throw new Error("The update archive holds a different version.");
  const backup = path.join(directory, "previous.app");
  const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const script = path.join(directory, "install-update.sh");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
      `rm -rf ${q(backup)} && /usr/bin/ditto ${q(bundle)} ${q(backup)} || exit 1`,
      `if /usr/bin/rsync -a --delete ${q(`${next}/`)} ${q(`${bundle}/`)} && /usr/bin/codesign --verify --deep --strict ${q(bundle)}; then :; else /usr/bin/rsync -a --delete ${q(`${backup}/`)} ${q(`${bundle}/`)}; fi`,
      `/usr/bin/open ${q(bundle)}`,
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
}
