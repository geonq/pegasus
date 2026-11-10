import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { RemoteDesktopHostClient } from "./remote-desktop-http-host";
import type { WorkspaceFolderRoot } from "../../contracts/workspace-folders";

const MAX_CONFIG_BYTES = 128 * 1024;

export interface RemoteDesktopHostFileConfig {
  readonly version: 1;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  /** No clients means the remote desktop API stays off (for example after revoking the last phone). */
  readonly clients: readonly RemoteDesktopHostClient[];
  readonly macFolders?: RemoteDesktopMacFoldersConfig;
  /** Also listen on this PC's Tailscale address, for paired phones. */
  readonly phoneAccess?: { readonly bind: "tailscale" };
}

export interface RemoteDesktopMacFoldersConfig {
  readonly modulePath: string;
  readonly configPath: string;
  readonly roots: readonly WorkspaceFolderRoot[];
}

export interface RemoteDesktopClientFileConfig {
  readonly version: 1;
  readonly baseUrl: string;
  readonly origin: string;
  readonly token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0")
  );
}

export function parseRemoteDesktopHostConfig(value: unknown): RemoteDesktopHostFileConfig {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["version", "port", "allowedOrigins", "clients", "macFolders", "phoneAccess"])
  ) {
    throw new Error("Remote desktop host configuration is invalid.");
  }
  if (
    value.version !== 1 ||
    !Number.isInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535 ||
    !Array.isArray(value.allowedOrigins) ||
    value.allowedOrigins.length === 0 ||
    value.allowedOrigins.some((origin) => typeof origin !== "string") ||
    !Array.isArray(value.clients) ||
    (value.phoneAccess !== undefined &&
      (!isRecord(value.phoneAccess) ||
        !exactKeys(value.phoneAccess, ["bind"]) ||
        value.phoneAccess.bind !== "tailscale"))
  ) {
    throw new Error("Remote desktop host configuration is invalid.");
  }
  const clientIds = new Set<string>();
  const clients = value.clients.map((candidate): RemoteDesktopHostClient => {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, [
        "id",
        "token",
        "workspaceIds",
        "folderRootWorkspaceIds",
        "initialWorkspaceId",
        "initialSessionId",
        "label",
      ]) ||
      (candidate.label !== undefined &&
        (typeof candidate.label !== "string" || candidate.label.length > 64)) ||
      !isIdentifier(candidate.id) ||
      clientIds.has(candidate.id) ||
      typeof candidate.token !== "string" ||
      !/^[A-Za-z0-9._~-]{32,256}$/u.test(candidate.token) ||
      !Array.isArray(candidate.workspaceIds) ||
      candidate.workspaceIds.length === 0 ||
      candidate.workspaceIds.some((id) => !isIdentifier(id)) ||
      new Set(candidate.workspaceIds).size !== candidate.workspaceIds.length ||
      (candidate.folderRootWorkspaceIds !== undefined &&
        (!Array.isArray(candidate.folderRootWorkspaceIds) ||
          candidate.folderRootWorkspaceIds.some((id) => !isIdentifier(id)) ||
          new Set(candidate.folderRootWorkspaceIds).size !==
            candidate.folderRootWorkspaceIds.length)) ||
      (candidate.initialWorkspaceId !== undefined && !isIdentifier(candidate.initialWorkspaceId)) ||
      (candidate.initialSessionId !== undefined && !isIdentifier(candidate.initialSessionId))
    ) {
      throw new Error("Remote desktop host client configuration is invalid.");
    }
    clientIds.add(candidate.id);
    if (
      candidate.initialWorkspaceId !== undefined &&
      !candidate.workspaceIds.includes(candidate.initialWorkspaceId)
    ) {
      throw new Error("Remote desktop initial workspace is not authorized.");
    }
    if (candidate.initialSessionId !== undefined && candidate.initialWorkspaceId === undefined) {
      throw new Error("Remote desktop initial session requires a workspace.");
    }
    return {
      id: candidate.id,
      token: candidate.token,
      workspaceIds: [...(candidate.workspaceIds as string[])],
      ...(candidate.folderRootWorkspaceIds !== undefined
        ? { folderRootWorkspaceIds: [...(candidate.folderRootWorkspaceIds as string[])] }
        : {}),
      ...(candidate.initialWorkspaceId !== undefined
        ? { initialWorkspaceId: candidate.initialWorkspaceId }
        : {}),
      ...(candidate.initialSessionId !== undefined
        ? { initialSessionId: candidate.initialSessionId }
        : {}),
      ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
    };
  });
  return {
    version: 1,
    port: value.port as number,
    allowedOrigins: [...(value.allowedOrigins as string[])],
    clients,
    ...(value.macFolders !== undefined
      ? { macFolders: parseMacFoldersConfig(value.macFolders) }
      : {}),
    ...(value.phoneAccess !== undefined ? { phoneAccess: { bind: "tailscale" as const } } : {}),
  };
}

function parseMacFoldersConfig(value: unknown): RemoteDesktopMacFoldersConfig {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["modulePath", "configPath", "roots"]) ||
    typeof value.modulePath !== "string" ||
    !path.isAbsolute(value.modulePath) ||
    path.basename(value.modulePath) !== "mac-folder-browser.mjs" ||
    typeof value.configPath !== "string" ||
    !path.isAbsolute(value.configPath) ||
    !Array.isArray(value.roots) ||
    value.roots.length === 0 ||
    value.roots.length > 16
  ) {
    throw new Error("Remote Mac folder configuration is invalid.");
  }
  const seen = new Set<string>();
  const roots = value.roots.map((candidate): WorkspaceFolderRoot => {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, ["id", "label", "workspaceId", "canCreate"]) ||
      !isIdentifier(candidate.id) ||
      seen.has(candidate.id) ||
      typeof candidate.label !== "string" ||
      candidate.label.trim().length === 0 ||
      Buffer.byteLength(candidate.label, "utf8") > 120 ||
      typeof candidate.canCreate !== "boolean" ||
      (candidate.workspaceId !== undefined && !isIdentifier(candidate.workspaceId))
    ) {
      throw new Error("Remote Mac folder root configuration is invalid.");
    }
    seen.add(candidate.id);
    return {
      id: candidate.id,
      label: candidate.label,
      ...(candidate.workspaceId !== undefined ? { workspaceId: candidate.workspaceId } : {}),
      canCreate: candidate.canCreate,
    };
  });
  return {
    modulePath: value.modulePath,
    configPath: value.configPath,
    roots,
  };
}

export function parseRemoteDesktopClientConfig(value: unknown): RemoteDesktopClientFileConfig {
  if (!isRecord(value) || !exactKeys(value, ["version", "baseUrl", "origin", "token"])) {
    throw new Error("Remote desktop client configuration is invalid.");
  }
  if (
    value.version !== 1 ||
    typeof value.baseUrl !== "string" ||
    typeof value.origin !== "string" ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9._~-]{32,256}$/u.test(value.token)
  ) {
    throw new Error("Remote desktop client configuration is invalid.");
  }
  let url: URL;
  try {
    url = new URL(value.baseUrl);
  } catch {
    throw new Error("Remote desktop client endpoint is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value.origin !== "file://"
  ) {
    throw new Error("Remote desktop client endpoint must use the configured loopback tunnel.");
  }
  return { version: 1, baseUrl: url.origin, origin: value.origin, token: value.token };
}

export async function readPrivateRemoteDesktopConfig<T>(
  filePath: string,
  platform: NodeJS.Platform,
  parse: (value: unknown) => T,
): Promise<T> {
  if (!path.isAbsolute(filePath)) throw new Error("Remote desktop config path must be absolute.");
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) {
    throw new Error("Remote desktop config file is invalid.");
  }
  if (platform === "darwin" && (info.mode & 0o077) !== 0) {
    throw new Error("Remote desktop config file permissions must be owner-only.");
  }
  const raw = await readFile(filePath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Remote desktop config file is not valid JSON.");
  }
  return parse(value);
}
