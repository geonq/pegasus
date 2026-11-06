import { app } from "electron";
import { mainFrameHandler } from "../ipc/main-frame-ipc";
import { desktopIpc } from "../../contracts/ipc";
import type { WindowOwner } from "../windows/window-owner";
import type { AppUpdater } from "./update-installer";

/**
 * Update and version IPC. Registered in host and Mac client mode alike: each app updates itself,
 * and every window hears status changes (progress, errors) for the banner.
 */
export function registerUpdateIpc(windows: WindowOwner, updater: AppUpdater): () => void {
  const handle = mainFrameHandler(windows);
  handle(
    desktopIpc.getAppVersion,
    () => undefined,
    () => {
      return app.getVersion();
    },
  );
  handle(
    desktopIpc.getUpdateStatus,
    () => undefined,
    () => {
      return updater.getStatus();
    },
  );
  handle(
    desktopIpc.checkForAppUpdate,
    () => undefined,
    () => {
      return updater.check();
    },
  );
  handle(
    desktopIpc.installAppUpdate,
    () => undefined,
    () => {
      return updater.install();
    },
  );
  return updater.subscribe((status) => {
    for (const window of windows.allWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(desktopIpc.updateStatusChanged, status);
      }
    }
  });
}
