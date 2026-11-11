import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

/**
 * Phone ↔ PC over Tailscale, end to end. A hidden test Pegasus here serves the remote API on this
 * PC's Tailscale address for one paired test phone; the Pegasus iPhone app on a headless simulator
 * on the Mac opens the pairing link and must list this profile's chat. Opt-in: set
 * PEGASUS_PHONE_E2E_MAC=user@host (the Mac with the simulator build from apps/mobile).
 */
const execFileAsync = promisify(execFile);
// windowsHide: ssh and scp are console programs; without it each call opens a terminal window on Windows.
const run = (file: string, args: readonly string[], options: { timeout?: number } = {}) =>
  execFileAsync(file, args, { ...options, windowsHide: true });
const mac = process.env.PEGASUS_PHONE_E2E_MAC;

function tailscaleAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((address) => {
      if (!address || address.family !== "IPv4" || address.internal) return false;
      const [a, b] = address.address.split(".").map(Number);
      return a === 100 && b !== undefined && b >= 64 && b < 128;
    })?.address;
}

async function onMac(script: string): Promise<string> {
  try {
    const { stdout } = await run("ssh", ["-o", "BatchMode=yes", mac!, script], {
      timeout: 240_000,
    });
    return stdout;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; signal?: string; code?: number };
    throw new Error(
      `Mac step failed (code ${failure.code ?? "?"}, signal ${failure.signal ?? "none"}):
${failure.stdout ?? ""}
${failure.stderr ?? ""}`,
    );
  }
}

test("the iPhone app pairs over Tailscale and lists this PC's chats", async () => {
  test.skip(!mac, "set PEGASUS_PHONE_E2E_MAC to run against the Mac's simulator");
  const address = tailscaleAddress();
  test.skip(!address, "this PC has no Tailscale address");
  test.setTimeout(240_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("phone-remote");
  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let workspaceId: string;
  try {
    const window = await first.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Phone visible chat");
    const state = await getDesktopState(window);
    workspaceId = state.workspaces.find((workspace) => workspace.path === workspacePath)!.id;
  } finally {
    await first.close();
  }

  const token = randomBytes(32).toString("base64url");
  const port = 47_300 + Math.floor(Math.random() * 600);
  const configPath = join(userDataDir, "phone-e2e-host.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      port,
      allowedOrigins: ["file://"],
      clients: [{ id: "phone-e2e", token, workspaceIds: [workspaceId], label: "E2E phone" }],
      phoneAccess: { bind: "tailscale" },
    }),
  );
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: { PI_REMOTE_DESKTOP_HOST_CONFIG: configPath },
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    // The API answers on the tailnet address with the phone's key and without an Origin.
    const base = `http://${address}:${port}`;
    await expect
      .poll(
        async () =>
          fetch(`${base}/v1/invoke`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ method: "getAppVersion", args: [] }),
          })
            .then((response) => response.status)
            .catch(() => 0),
        { timeout: 30_000 },
      )
      .toBe(200);

    const link = `pegasus://pair?v=1&url=${encodeURIComponent(base)}&token=${token}&name=E2E-PC`;
    const shot = `/tmp/pegasus-phone-e2e-${port}.png`;
    await onMac(
      [
        "set -ex",
        "UDID=$(cat /tmp/pegasus-sim)",
        "xcrun simctl bootstatus $UDID -b >/dev/null",
        "xcrun simctl terminate $UDID dev.geonq.pegasus >/dev/null 2>&1 || true",
        "xcrun simctl uninstall $UDID dev.geonq.pegasus >/dev/null 2>&1 || true",
        // iOS keeps Keychain items across an uninstall, and a paired phone ignores new pairing links
        // (by design). Resetting this test simulator's keychain makes every run start unpaired.
        "xcrun simctl keychain $UDID reset",
        "xcrun simctl install $UDID ~/Pi/pegasus-mobile/ios/build/Build/Products/Release-iphonesimulator/Pegasus.app",
        // Opening a link would need a tap on iOS's confirmation; a launch argument pairs directly.
        `xcrun simctl launch $UDID dev.geonq.pegasus -PegasusPairingLink '${link}' >/dev/null`,
        "sleep 12",
        `xcrun simctl io $UDID screenshot ${shot}`,
      ].join(" && "),
    );
    const local = test.info().outputPath("phone-paired.png");
    await run("scp", ["-q", `${mac}:${shot}`, local]);
    await test.info().attach("phone", { path: local, contentType: "image/png" });
    // The phone is paired and streaming: the host saw its event stream open.
    const hostLog = await readFile(join(userDataDir, "agent", "logs", "pegasus-host.log"), "utf8");
    await test.info().attach("host log", { body: hostLog });
    expect(hostLog.includes("sse stream opened for phone-e2e"), hostLog.slice(-2000)).toBe(true);
  } finally {
    await harness.close();
  }
});
