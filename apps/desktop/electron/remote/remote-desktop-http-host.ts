import { createHash } from "node:crypto";
import type { HostClient, HostEvent, RemoteError } from "@pi-gui/host-protocol";
import { onSharedHostEvent, sharedHost } from "@pi-gui/host-protocol/shared";
import type { RemoteDesktopBroker } from "./remote-desktop-broker";
import { isRemoteDesktopMethod, type RemoteDesktopEvent } from "./remote-desktop-protocol";
import { RemoteWorkspaceFolderError } from "./remote-workspace-folders";
import { tailscaleAddress } from "./phone-access";

/**
 * The remote desktop API (the Mac client today, the phone next) is served by the Rust host
 * (crates/pegasus-host/src/remote.rs) on 127.0.0.1: same routes, auth, limits and SSE/Brotli wire
 * format as before. This side validates the client configuration, answers each `remoteInvoke`
 * through that device's broker, and forwards broker events. JSON encoding of replies and every SSE
 * frame, compression and stream bookkeeping run in the host, off Electron's main thread.
 */

const HOST = "127.0.0.1";

export interface RemoteDesktopHostClient {
  readonly id: string;
  readonly token: string;
  readonly workspaceIds: readonly string[];
  readonly folderRootWorkspaceIds?: readonly string[];
  readonly initialWorkspaceId?: string;
  readonly initialSessionId?: string;
  /** Shown in Settings › Phone for paired phones. */
  readonly label?: string;
}

export interface RemoteDesktopHttpHostConfig {
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly clients: readonly RemoteDesktopHostClient[];
  readonly brokers: ReadonlyMap<string, RemoteDesktopBroker>;
  /** Also listen on this PC's Tailscale address (paired phones). */
  readonly phoneAccess?: { readonly bind: "tailscale" };
}

export interface RemoteDesktopHttpHost {
  readonly origin: string;
  close(): Promise<void>;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0")
  );
}

function validateOrigins(values: readonly string[]): void {
  if (values.length === 0) throw new Error("Remote desktop origins are required.");
  for (const origin of values) {
    if (
      typeof origin !== "string" ||
      origin.length > 256 ||
      origin === "*" ||
      /[\r\n]/u.test(origin) ||
      (origin !== "file://" && !/^https?:\/\/127\.0\.0\.1(?::\d+)?$/u.test(origin))
    ) {
      throw new Error("Remote desktop origins must be exact file or loopback origins.");
    }
  }
}

function validateClients(
  configs: readonly RemoteDesktopHostClient[],
  brokers: ReadonlyMap<string, RemoteDesktopBroker>,
): Map<string, RemoteDesktopBroker> {
  if (configs.length === 0) throw new Error("At least one remote desktop client is required.");
  const clients = new Map<string, RemoteDesktopBroker>();
  const tokenDigests = new Set<string>();
  for (const config of configs) {
    if (!isIdentifier(config.id) || clients.has(config.id)) {
      throw new Error("Remote desktop client IDs must be unique.");
    }
    if (typeof config.token !== "string" || !/^[A-Za-z0-9._~-]{32,256}$/u.test(config.token)) {
      throw new Error("Remote desktop tokens must be 32 to 256 URL-safe characters.");
    }
    if (
      !Array.isArray(config.workspaceIds) ||
      config.workspaceIds.length === 0 ||
      config.workspaceIds.some((workspaceId) => !isIdentifier(workspaceId)) ||
      new Set(config.workspaceIds).size !== config.workspaceIds.length
    ) {
      throw new Error("Each remote desktop client requires a unique workspace allowlist.");
    }
    if (
      config.folderRootWorkspaceIds !== undefined &&
      (!Array.isArray(config.folderRootWorkspaceIds) ||
        config.folderRootWorkspaceIds.some((workspaceId) => !isIdentifier(workspaceId)) ||
        new Set(config.folderRootWorkspaceIds).size !== config.folderRootWorkspaceIds.length)
    ) {
      throw new Error("Each remote desktop client requires unique folder roots.");
    }
    if (config.initialWorkspaceId && !config.workspaceIds.includes(config.initialWorkspaceId)) {
      throw new Error("The initial workspace must be authorized for that client.");
    }
    if (config.initialSessionId && !config.initialWorkspaceId) {
      throw new Error("An initial session requires an initial workspace.");
    }
    const broker = brokers.get(config.id);
    if (!broker) throw new Error("A passive native view is required for each remote client.");
    const digest = tokenDigest(config.token);
    if (tokenDigests.has(digest)) throw new Error("Remote desktop tokens must be unique.");
    tokenDigests.add(digest);
    clients.set(config.id, broker);
  }
  return clients;
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** How a broker failure reaches the device: same statuses and codes as the old HTTP host. */
function remoteError(error: unknown): RemoteError {
  if (error instanceof RemoteWorkspaceFolderError) {
    const status =
      error.code === "ROOT_UNAVAILABLE"
        ? 403
        : error.code === "NOT_FOUND"
          ? 404
          : error.code === "CONFLICT"
            ? 409
            : error.code === "INVALID_PATH"
              ? 400
              : 500;
    return { status, code: error.code.toLowerCase(), message: error.message };
  }
  return {
    status: 400,
    code: "operation_failed",
    message: error instanceof TypeError ? error.message : "The remote native operation failed.",
  };
}

/** One authenticated loopback API. All actions are forwarded through the per-device native view. */
export async function startRemoteDesktopHttpHost(
  config: RemoteDesktopHttpHostConfig,
): Promise<RemoteDesktopHttpHost> {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error("The remote desktop port is invalid.");
  }
  validateOrigins(config.allowedOrigins);
  const clients = validateClients(config.clients, config.brokers);
  const host = await sharedHost(true);
  if (!host) throw new Error("The Pegasus host is not running, so the remote desktop API is off.");

  // A device's events are produced only while it listens. Its event stream opens with a getState
  // request, which starts the relay; the host answers a publish nobody received with
  // delivered: false, which stops it. Unrelayed, a broker page stops receiving app state, so an
  // absent device costs nothing per state change. (An older host answers {}: the relay stays on.)
  const relays = new Map<string, () => void>();
  const stopRelay = (clientId: string) => {
    relays.get(clientId)?.();
    relays.delete(clientId);
  };
  const startRelay = (clientId: string, broker: RemoteDesktopBroker) => {
    if (relays.has(clientId)) return;
    relays.set(
      clientId,
      broker.subscribe((event: RemoteDesktopEvent) => {
        host
          .call("remote.publish", { clientId, event })
          .then((result) => {
            if ((result as { delivered?: unknown } | undefined)?.delivered === false) {
              stopRelay(clientId);
            }
          })
          .catch((error: unknown) => {
            console.warn(`[remote] event for ${clientId} was not delivered:`, error);
          });
      }),
    );
  };

  const answer = async (client: HostClient, event: HostEvent): Promise<void> => {
    if (event.event !== "remoteInvoke") return;
    const { requestId, clientId, method, args } = event.data;
    const broker = clients.get(clientId);
    if (broker) startRelay(clientId, broker);
    try {
      if (!broker || !isRemoteDesktopMethod(method) || !Array.isArray(args)) {
        await client.call("remote.reply", {
          requestId,
          ok: false,
          error: {
            status: 400,
            code: "invalid_request",
            message: "The remote method request is invalid.",
          },
        });
        return;
      }
      const value = await broker.invoke(method, args);
      await client.call("remote.reply", { requestId, ok: true, value });
    } catch (error) {
      await client
        .call("remote.reply", { requestId, ok: false, error: remoteError(error) })
        .catch((replyError: unknown) => {
          console.warn("[remote] could not answer a device request:", replyError);
        });
    }
  };
  const offInvoke = onSharedHostEvent((event) => {
    answer(host, event).catch((error: unknown) => {
      console.warn("[remote] device request failed:", error);
    });
  });
  const stopRelays = () => {
    for (const clientId of [...relays.keys()]) stopRelay(clientId);
  };
  const tailscale = config.phoneAccess ? tailscaleAddress() : null;
  if (config.phoneAccess && !tailscale) {
    console.warn(
      "[remote] phone access is on but this PC has no Tailscale address; phones cannot connect",
    );
  }
  try {
    await host.call("remote.serve", {
      port: config.port,
      allowedOrigins: [...config.allowedOrigins],
      ...(tailscale ? { extraBinds: [tailscale] } : {}),
      clients: config.clients.map((client) => ({
        id: client.id,
        tokenSha256: tokenDigest(client.token),
      })),
    });
  } catch (error) {
    offInvoke();
    stopRelays();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    origin: `http://${HOST}:${config.port}`,
    close: () => {
      closePromise ??= (async () => {
        offInvoke();
        stopRelays();
        await host.call("remote.stop", {}).catch(() => undefined);
      })();
      return closePromise;
    },
  };
}
