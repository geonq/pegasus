import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

function hasTailscale(): boolean {
  return Object.values(networkInterfaces())
    .flat()
    .some((address) => {
      if (!address || address.family !== "IPv4" || address.internal) return false;
      const [a, b] = address.address.split(".").map(Number);
      return a === 100 && b !== undefined && b >= 64 && b < 128;
    });
}

test("Settings › Phone pairs a phone with a QR code and asks for a restart to apply it", async () => {
  test.skip(!hasTailscale(), "pairing needs this machine's Tailscale address");
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("settings-phone");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window.keyboard.press(desktopShortcut(","));
    const surface = window.getByTestId("settings-surface");
    await expect(surface).toBeVisible();
    await surface
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Phone", exact: true })
      .click();
    await expect(window.locator(".view-header__title")).toHaveText("Phone");
    await expect(window.getByTestId("phone-tailscale-status")).toHaveText("Connected");
    await expect(surface.getByText("No phones yet")).toBeVisible();

    await surface.getByLabel("Phone name").fill("Test iPhone");
    await window.getByTestId("phone-pair").click();
    const qr = window.getByTestId("phone-qr");
    await expect(qr.getByRole("img", { name: "QR code to pair Test iPhone" })).toBeVisible();
    await expect(surface.getByText("Test iPhone", { exact: true })).toBeVisible();
    await expect(surface.getByRole("button", { name: "Restart Pegasus" })).toBeVisible();

    // The profile's own config now holds the phone (tests never touch an owner config).
    const config = JSON.parse(
      await readFile(join(userDataDir, "remote-desktop-host.json"), "utf8"),
    ) as { clients: { id: string; label?: string }[]; phoneAccess?: unknown };
    expect(config.clients.map((client) => client.label)).toEqual(["Test iPhone"]);
    expect(config.phoneAccess).toEqual({ bind: "tailscale" });

    await surface.getByRole("button", { name: "Revoke" }).click();
    await expect(surface.getByText("No phones yet")).toBeVisible();
    await expect(qr).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
