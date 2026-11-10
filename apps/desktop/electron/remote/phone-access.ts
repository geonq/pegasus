import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";
import QRCode from "qrcode";
import type { PairedPhone, PhoneAccessState, PhonePairing } from "../../contracts/phone-access";

/**
 * Phone access to this PC's remote desktop API. A phone is one more client in the remote host
 * config (its own bearer token and workspace allowlist); the Rust host also listens on this PC's
 * Tailscale address, so the phone reaches it over the tailnet (WireGuard-encrypted, never the LAN).
 * Pairing shows a QR code with the address and the token; adding or revoking takes effect after a
 * restart, because each client gets its own broker view at startup.
 */

export const DEFAULT_REMOTE_PORT = 47_219;
const PAIRING_SCHEME = "pegasus://pair";

/** This PC's Tailscale IPv4 address (100.64.0.0/10), or null without Tailscale. */
export function tailscaleAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const [a, b] = address.address.split(".").map(Number);
      if (a === 100 && b !== undefined && b >= 64 && b < 128) return address.address;
    }
  }
  return null;
}

interface RawConfig {
  version: 1;
  port: number;
  allowedOrigins: string[];
  clients: RawClient[];
  phoneAccess?: { bind: "tailscale" };
  [key: string]: unknown;
}

interface RawClient {
  id: string;
  token: string;
  workspaceIds: string[];
  label?: string;
  [key: string]: unknown;
}

async function readConfig(configPath: string): Promise<RawConfig | null> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as RawConfig;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Atomic write with a timestamped backup of the previous file. */
async function writeConfig(configPath: string, config: RawConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  const previous = await readConfig(configPath);
  if (previous) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(configPath, `${configPath}.bak-${stamp}`);
  }
  const temporary = `${configPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, configPath);
}

function isPhone(client: RawClient): boolean {
  return client.id.startsWith("phone-");
}

export interface PhoneAccessOptions {
  readonly configPath: string;
  /** Workspaces a new phone may use: all of this PC's workspaces at pairing time. */
  readonly workspaceIds: () => readonly string[];
  /** Whether the running remote host already serves the phones in the file. */
  readonly servedPhoneIds: () => readonly string[];
}

export async function readPhoneAccess(options: PhoneAccessOptions): Promise<PhoneAccessState> {
  const config = await readConfig(options.configPath);
  const phones: PairedPhone[] = (config?.clients ?? []).filter(isPhone).map((client) => ({
    id: client.id,
    label: typeof client.label === "string" && client.label ? client.label : "Phone",
  }));
  const served = new Set(options.servedPhoneIds());
  return {
    tailscaleAddress: tailscaleAddress(),
    port: config?.port ?? DEFAULT_REMOTE_PORT,
    phones,
    restartNeeded:
      phones.some((phone) => !served.has(phone.id)) ||
      [...served].some((id) => !phones.some((phone) => phone.id === id)),
  };
}

export async function pairPhone(options: PhoneAccessOptions, label: string): Promise<PhonePairing> {
  const address = tailscaleAddress();
  if (!address) {
    throw new Error("Tailscale is not running on this PC, so a phone cannot reach it.");
  }
  const name = label.trim().slice(0, 64) || "Phone";
  const workspaceIds = [...new Set(options.workspaceIds())];
  if (workspaceIds.length === 0) throw new Error("Add a project folder before pairing a phone.");
  const config: RawConfig = (await readConfig(options.configPath)) ?? {
    version: 1,
    port: DEFAULT_REMOTE_PORT,
    allowedOrigins: ["file://"],
    clients: [],
  };
  const token = randomBytes(32).toString("base64url");
  const id = `phone-${randomBytes(4).toString("hex")}`;
  config.clients = [...config.clients, { id, token, workspaceIds, label: name }];
  config.phoneAccess = { bind: "tailscale" };
  await writeConfig(options.configPath, config);
  const url = new URL(PAIRING_SCHEME);
  url.searchParams.set("v", "1");
  url.searchParams.set("url", `http://${address}:${config.port}`);
  url.searchParams.set("token", token);
  url.searchParams.set("name", hostname());
  const pairingUrl = url.toString();
  return {
    phone: { id, label: name },
    pairingUrl,
    qrSvg: await QRCode.toString(pairingUrl, { type: "svg", errorCorrectionLevel: "M", margin: 1 }),
  };
}

export async function revokePhone(options: PhoneAccessOptions, phoneId: string): Promise<void> {
  const config = await readConfig(options.configPath);
  if (!config || !config.clients.some((client) => client.id === phoneId && isPhone(client))) {
    throw new Error("That phone is not paired.");
  }
  config.clients = config.clients.filter((client) => client.id !== phoneId);
  if (!config.clients.some(isPhone)) delete config.phoneAccess;
  if (config.clients.length === 0) {
    // The host config requires a client; with none left the remote API simply stays off.
    await writeConfig(options.configPath, { ...config, clients: [] });
    return;
  }
  await writeConfig(options.configPath, config);
}
