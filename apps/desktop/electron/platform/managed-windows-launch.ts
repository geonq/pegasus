import { app, dialog } from "electron";
import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import {
  applyManagedLaunchEnvironment,
  DENIED_ENVIRONMENT_NAME,
  recordStartupError,
} from "./managed-launch-environment";

export interface ManagedWindowsLaunch {
  readonly ecosystemRoot: string;
  readonly launcher: string;
  readonly profile: Readonly<{ userDataDir: string; agentDir: string }>;
}

function failManagedLaunch(ecosystemRoot: string, error: unknown): never {
  recordStartupError(ecosystemRoot, error);
  dialog.showErrorBox(
    "Pegasus could not start",
    "The managed Pi profile could not be prepared. Review the private startup log in pi-ecosystem/.state.",
  );
  app.exit(1);
  throw error instanceof Error ? error : new Error(String(error));
}

/**
 * Synchronous and cheap, at module load: decides whether this start is a managed one and pins its
 * profile, because Electron reads userData and the single-instance lock before the launcher could
 * finish. Secrets are scrubbed from the environment here, before any child process starts.
 */
export function beginManagedWindowsLaunch(): ManagedWindowsLaunch | undefined {
  if (process.platform !== "win32" || !app.isPackaged) return undefined;
  app.setAppUserModelId("com.pi-gui.desktop");
  if (process.env.PI_GUI_INTEGRATED_LAUNCH === "1") return undefined;
  const installRoot = path.dirname(process.execPath);
  const ecosystemRoot = path.join(path.dirname(installRoot), "pi-ecosystem");
  const launcher = path.join(ecosystemRoot, "scripts", "Launch-PiGui.ps1");
  if (!existsSync(launcher)) return undefined;
  try {
    if (
      lstatSync(installRoot).isSymbolicLink() ||
      lstatSync(ecosystemRoot).isSymbolicLink() ||
      lstatSync(launcher).isSymbolicLink()
    ) {
      throw new Error("Unexpected managed launch path.");
    }
  } catch (error) {
    failManagedLaunch(ecosystemRoot, error);
  }
  const profile = {
    userDataDir: path.join(ecosystemRoot, ".state", "pi-gui"),
    agentDir: path.join(ecosystemRoot, ".state", "agent"),
  };
  process.env.PI_APP_USER_DATA_DIR = profile.userDataDir;
  process.env.PI_CODING_AGENT_DIR = profile.agentDir;
  for (const name of Object.keys(process.env)) {
    if (DENIED_ENVIRONMENT_NAME.test(name)) delete process.env[name];
  }
  return { ecosystemRoot, launcher, profile };
}

/**
 * Runs the launcher's prepare step (storage check, agent sandbox marks, profile files) while the
 * startup window is already on screen, instead of blocking before any window exists. Must finish
 * before the store is created: the store reads the prepared profile.
 */
export function finishManagedWindowsLaunch(launch: ManagedWindowsLaunch): Promise<void> {
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return new Promise<void>((resolve, reject) => {
    execFile(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launch.launcher,
        "-PrepareOnly",
        "-GuiProcessId",
        String(process.pid),
      ],
      { windowsHide: true, encoding: "utf8", maxBuffer: 256 * 1024, timeout: 30_000 },
      (error, stdout) => {
        try {
          if (error) throw error;
          applyManagedLaunchEnvironment(stdout, launch.profile);
          resolve();
        } catch (failure) {
          try {
            failManagedLaunch(launch.ecosystemRoot, failure);
          } catch (stopped) {
            reject(stopped);
          }
        }
      },
    );
  });
}
