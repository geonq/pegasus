import {
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import type { WindowOwner } from "../windows/window-owner";

export interface MainFrameRequest {
  readonly event: IpcMainInvokeEvent;
  readonly window: BrowserWindow;
  readonly contents: WebContents;
}

export type MainFrameHandler = <Input, Result>(
  channel: string,
  decode: (raw: unknown) => Input,
  handler: (input: Input, request: MainFrameRequest) => Result,
) => void;

/**
 * Registers invoke handlers that accept only an owned window's main frame.
 * Extension iframes share that window's webContents, so `event.sender` alone
 * does not identify the app renderer. A missing `senderFrame` (navigated or
 * destroyed frame) is rejected. The sender is checked before `decode` runs.
 */
export function mainFrameHandler(windows: Pick<WindowOwner, "windowForSender">): MainFrameHandler {
  return (channel, decode, handler) => {
    ipcMain.handle(channel, (event, raw: unknown) => {
      const request = mainFrameRequest(windows, channel, event);
      return handler(decode(raw), request);
    });
  };
}

/**
 * The same main-frame gate for channels whose preload passes several positional
 * arguments; each handler validates its own raw arguments after the check.
 */
export function mainFrameArgsHandler(windows: Pick<WindowOwner, "windowForSender">) {
  return <Result>(
    channel: string,
    handler: (request: MainFrameRequest, ...raw: unknown[]) => Result,
  ): void => {
    ipcMain.handle(channel, (event, ...raw: unknown[]) =>
      handler(mainFrameRequest(windows, channel, event), ...raw),
    );
  };
}

/** For one-way `send` messages from a window the caller created and owns. */
export function isMainFrameSender(event: IpcMainEvent, contents: WebContents): boolean {
  return event.sender === contents && event.senderFrame === contents.mainFrame;
}

/** One-way reports are ignored unless they come from an owned window's main frame. */
export function mainFrameListener(
  windows: Pick<WindowOwner, "windowForSender">,
  channel: string,
  listener: (raw: unknown) => void,
): void {
  ipcMain.on(channel, (event, raw: unknown) => {
    let window: BrowserWindow;
    try {
      window = windows.windowForSender(event.sender);
    } catch {
      return;
    }
    if (window.isDestroyed() || !isMainFrameSender(event, window.webContents)) return;
    listener(raw);
  });
}

function mainFrameRequest(
  windows: Pick<WindowOwner, "windowForSender">,
  channel: string,
  event: IpcMainInvokeEvent,
): MainFrameRequest {
  const window = windows.windowForSender(event.sender);
  const contents = window.isDestroyed() ? undefined : window.webContents;
  if (!contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) {
    throw new Error(`${channel} must originate from the window's main frame.`);
  }
  return { event, window, contents };
}
