import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  pairPhone,
  readPhoneAccess,
  revokePhone,
  tailscaleAddress,
} from "../../electron/remote/phone-access";
import { parseRemoteDesktopHostConfig } from "../../electron/remote/remote-desktop-config";

async function setup(existing?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "pi-gui-phone-"));
  const configPath = join(dir, "host.json");
  if (existing) await writeFile(configPath, JSON.stringify(existing));
  const served: string[] = [];
  return {
    dir,
    configPath,
    served,
    options: {
      configPath,
      workspaceIds: () => ["workspace-a", "workspace-b"],
      servedPhoneIds: () => served,
    },
  };
}

const macClient = {
  id: "mac-client",
  token: "m".repeat(40),
  workspaceIds: ["workspace-a"],
};

test("the host config accepts phone access, labels and an empty client list", () => {
  const parsed = parseRemoteDesktopHostConfig({
    version: 1,
    port: 47219,
    allowedOrigins: ["file://"],
    clients: [{ ...macClient, label: "Mac" }],
    phoneAccess: { bind: "tailscale" },
  });
  expect(parsed.phoneAccess).toEqual({ bind: "tailscale" });
  expect(parsed.clients[0]?.label).toBe("Mac");
  expect(
    parseRemoteDesktopHostConfig({ version: 1, port: 1, allowedOrigins: ["file://"], clients: [] })
      .clients,
  ).toEqual([]);
  expect(() =>
    parseRemoteDesktopHostConfig({
      version: 1,
      port: 1,
      allowedOrigins: ["file://"],
      clients: [],
      phoneAccess: { bind: "0.0.0.0" },
    }),
  ).toThrow();
});

test("pairing a phone adds its own client, keeps others, backs up the file and encodes a QR", async () => {
  test.skip(!tailscaleAddress(), "this machine has no Tailscale address");
  const { configPath, options, dir, served } = await setup({
    version: 1,
    port: 47219,
    allowedOrigins: ["file://"],
    clients: [macClient],
  });
  const pairing = await pairPhone(options, "  Georg's iPhone  ");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    clients: { id: string; token: string; workspaceIds: string[]; label?: string }[];
    phoneAccess?: unknown;
  };
  expect(config.clients.map((client) => client.id)).toEqual(["mac-client", pairing.phone.id]);
  const phone = config.clients[1]!;
  expect(phone.label).toBe("Georg's iPhone");
  expect(phone.workspaceIds).toEqual(["workspace-a", "workspace-b"]);
  expect(phone.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(config.phoneAccess).toEqual({ bind: "tailscale" });
  expect((await readdir(dir)).some((name) => name.startsWith("host.json.bak-"))).toBe(true);

  const url = new URL(pairing.pairingUrl);
  expect(url.protocol).toBe("pegasus:");
  expect(url.searchParams.get("token")).toBe(phone.token);
  expect(url.searchParams.get("url")).toBe(`http://${tailscaleAddress()}:47219`);
  expect(pairing.qrSvg.startsWith("<svg")).toBe(true);
  // The parser that main uses at startup accepts the written file.
  expect(parseRemoteDesktopHostConfig(config).clients).toHaveLength(2);

  // Not served yet: a restart is needed; once served, it is not.
  expect((await readPhoneAccess(options)).restartNeeded).toBe(true);
  served.push(pairing.phone.id);
  expect((await readPhoneAccess(options)).restartNeeded).toBe(false);

  await revokePhone(options, pairing.phone.id);
  const after = JSON.parse(await readFile(configPath, "utf8")) as {
    clients: { id: string }[];
    phoneAccess?: unknown;
  };
  expect(after.clients.map((client) => client.id)).toEqual(["mac-client"]);
  expect(after.phoneAccess).toBeUndefined();
  await expect(revokePhone(options, "mac-client")).rejects.toThrow("not paired");
});

test("pairing creates the config when none exists and refuses without Tailscale", async () => {
  const { configPath, options } = await setup();
  if (!tailscaleAddress()) {
    await expect(pairPhone(options, "Phone")).rejects.toThrow("Tailscale");
    return;
  }
  const pairing = await pairPhone(options, "");
  expect(pairing.phone.label).toBe("Phone");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { clients: unknown[] };
  expect(config.clients).toHaveLength(1);
});
