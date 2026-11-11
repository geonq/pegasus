import { nativeTheme, type BrowserWindow } from "electron";
import { desktopIpc } from "../../contracts/ipc";
import type { ThemeMode } from "../../contracts/desktop-state";

export class ThemeManager {
  private mode: ThemeMode = "system";
  private readonly windows = new Set<BrowserWindow>();
  private readonly listeners = new Set<() => void>();

  constructor() {
    nativeTheme.on("updated", () => {
      this.broadcast();
    });
  }

  trackWindow(win: BrowserWindow) {
    if (win.isDestroyed() || this.windows.has(win)) {
      return;
    }
    this.windows.add(win);
    win.once("closed", () => {
      this.windows.delete(win);
    });
  }

  /**
   * Runs after every change of the resolved theme source: the app's own setMode and system changes.
   * Windows does not emit nativeTheme "updated" when the app sets themeSource itself.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getMode(): ThemeMode {
    return this.mode;
  }

  getResolvedTheme(): "light" | "dark" {
    if (this.mode === "system") {
      return nativeTheme.shouldUseDarkColors ? "dark" : "light";
    }
    return this.mode;
  }

  setMode(mode: ThemeMode) {
    this.mode = mode;
    if (mode === "system") {
      nativeTheme.themeSource = "system";
    } else {
      nativeTheme.themeSource = mode;
    }
    this.broadcast();
  }

  private broadcast() {
    for (const listener of this.listeners) listener();
    for (const window of this.windows) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(desktopIpc.themeChanged, this.getResolvedTheme());
      }
    }
  }
}
