import { randomUUID } from "node:crypto";
import { sharedHost } from "@pi-gui/host-protocol/shared";
import type { ComposerFileAttachment } from "../../../contracts/desktop-state";

/** How a folder reference is marked; the agent gets its path, never its contents. */
export const COMPOSER_FOLDER_MIME_TYPE = "inode/directory";

/**
 * Dropped folders as path references. The Rust host checks each path (crates/pegasus-host/src/files.rs);
 * a path that is gone or not a folder fails the whole drop with its name, so nothing is half-attached.
 */
export async function readComposerFolderAttachments(
  paths: readonly string[],
): Promise<ComposerFileAttachment[]> {
  if (paths.length === 0) return [];
  const host = await sharedHost(true);
  if (!host) throw new Error("Folders cannot be attached: the Pegasus host is not running.");
  const { files } = await host.call("files.describe", { paths: [...paths] });
  const notFolder = files.find((file) => file.kind !== "directory");
  if (notFolder) {
    throw new Error(
      notFolder.kind === "missing"
        ? `${notFolder.name} could not be read, so it was not attached.`
        : `${notFolder.name} is not a folder.`,
    );
  }
  return files.map((file) => ({
    id: randomUUID(),
    kind: "file",
    name: file.name,
    mimeType: COMPOSER_FOLDER_MIME_TYPE,
    fsPath: file.path,
  }));
}
