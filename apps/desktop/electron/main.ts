import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  protocol,
  shell,
  type Tray,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
} from "electron";
import { connectHost, isValidHttpBaseUrl, onHostEvent } from "@pi-gui/pi-sdk-driver";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type {
  AgentToolResult,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import {
  startAutomationIngress,
  type AutomationRoute,
  type NativeAutomationIngress,
} from "./automation/native-automation-ingress";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { augmentPosixPath } from "../scripts/augment-path.cjs";
import { DesktopAppStore, resolveAgentDir } from "./application/app-store";
import { handOffManagedWindowsLaunch } from "./platform/managed-windows-launch";
import { handOffManagedMacLaunch } from "./platform/managed-macos-launch";
import { WindowOwner } from "./windows/window-owner";
import { PendingComposerDraftFlusher } from "./windows/pending-draft-flush";
import { TurnCheckpointStore } from "./workbench/checkpoint-store";
import {
  DesktopExtensionViewOwner,
  DESKTOP_EXTENSION_SCHEME,
} from "./extensions/extension-view-owner";
import { performExtensionViewHostAction } from "./extensions/extension-view-actions";
import { extensionFrameDocument } from "./extensions/extension-frame-document";
import {
  findTouchedRepositories,
  ReviewOwner,
  taskTreeTouchedFiles,
} from "./workbench/review-owner";
import { promptTitle } from "./conversation/thread-title-constants";
import { assertComposerAttachmentPixels } from "./ipc/composer-attachment-pixels";
import { mainFrameHandler } from "./ipc/main-frame-ipc";
import { registerDesktopIpc } from "./ipc/register-desktop-ipc";
import {
  createOrchestrationRuntimeExtension,
  createOrchestrationRuntimeTools,
  type OrchestrationRuntimeBridge,
} from "./orchestration/orchestration-runtime";
import { createGenerativeUiRuntimeExtension } from "./generative-ui/generative-ui-runtime";
import {
  createScheduledTaskRuntimeExtension,
  createScheduledTaskRuntimeTools,
  type ScheduledTaskRuntimeBridge,
} from "./scheduled-tasks/scheduled-task-runtime";
import { getChangedFiles, getFileDiff, stageFile } from "./platform/files/app-store-diff";
import { listWorkspaceFiles, readWorkspaceFile } from "./platform/files/app-store-files";
import { readAccountLimits } from "./usage/account-limits";
import { readClaudeSlots } from "./usage/claude-slots";
import { readAccountStates } from "./usage/account-states";
import { limitResumeAt } from "./usage/limit-resume";
import { startSignInMonitor } from "./usage/sign-ins";
import { loadWindowState, trackWindowState } from "./platform/window-state";
import { collectUsage } from "./usage/collect-usage";
import { mapActiveRuns } from "./usage/active-runs";
import { resolveExistingWorkspacePath } from "./platform/files/workspace-paths";
import { MAIN_DEV_RELOAD_MARKER } from "./dev-reload-main-probe";
import { NotificationManager } from "./platform/notification-manager";
import { createRemoteNotificationStore } from "./platform/remote-notification-source";
import { NotificationPermissionService } from "./platform/notification-permission";
import { openReleasesPage } from "./platform/update-checker";
import { AppUpdater } from "./platform/update-installer";
import {
  consumeResume,
  resumeMessage,
  selfUpdateDir,
  watchQuitRequest,
  writeHealthy,
} from "./platform/self-update";
import { watchMainThreadStalls, watchRendererStalls } from "./platform/main-thread-stalls";
import { installAppTray } from "./platform/app-tray";
import { registerUpdateIpc } from "./platform/register-update-ipc";
import { ThemeManager } from "./platform/theme-manager";
import { windowBackgroundFor } from "../contracts/theme";
import { TerminalService } from "./platform/terminal-service";
import { RemoteDesktopBroker } from "./remote/remote-desktop-broker";
import {
  createWorkspaceFolderService,
  type WorkspaceFolderService,
  type WindowsWorkspaceFolderRootConfig,
} from "./remote/workspace-folder-service";
import { registerWorkspaceFolderIpc } from "./remote/register-workspace-folder-ipc";
import { createRemoteWorkspaceFolders } from "./remote/remote-workspace-folders";
import {
  parseRemoteDesktopClientConfig,
  parseRemoteDesktopHostConfig,
  readPrivateRemoteDesktopConfig,
  type RemoteDesktopHostFileConfig,
  type RemoteDesktopMacFoldersConfig,
} from "./remote/remote-desktop-config";
import { RemoteDesktopHttpClient } from "./remote/remote-desktop-http-client";
import {
  startRemoteDesktopHttpHost,
  type RemoteDesktopHttpHost,
} from "./remote/remote-desktop-http-host";
import {
  DEFAULT_REMOTE_DESKTOP_CLIENT_PREFERENCES,
  loadRemoteDesktopClientPreferences,
  persistRemoteDesktopClientPreferences,
  validateRemoteDesktopClientPreferencesPatch,
  type RemoteDesktopClientPreferences,
} from "./remote/remote-desktop-client-preferences";
import { remoteClientIpc, type RemoteDesktopEvent } from "./remote/remote-desktop-protocol";
import { remoteClientInvocationFromIpc } from "./remote/remote-desktop-client-preload";
import type { DesktopAppState, DesktopAppViewState } from "../contracts/desktop-state";
import {
  desktopCommands,
  desktopIpc,
  getDesktopCommandFromShortcut,
  isSinglePressCommand,
  isCloseFocusedSurfaceShortcut,
  getSidePanelTabCommand,
  platformShortcutModifier,
  type CustomProviderProbeInput,
  type CustomProviderProbeResult,
} from "../contracts/ipc";
import {
  assertComposerImageBytes,
  assertComposerImageFileSizes,
  assertComposerImagePixels,
  SUPPORTED_COMPOSER_IMAGE_TYPES,
  type ClipboardImageRead,
} from "../contracts/composer-attachments";
import type {
  ComposerAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "../contracts/desktop-state";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { GenerateThreadTitleOptions } from "@pi-gui/pi-sdk-driver";
import type { SessionRef, WorkspaceRef } from "@pi-gui/session-driver";
import type { WorkspaceFolderAdapter, WorkspaceFolderRoot } from "../contracts/workspace-folders";

const remoteDesktopDefaultsDisabled =
  process.env.PI_REMOTE_DESKTOP_CLIENT === "0" ||
  process.env.PI_APP_TEST_MODE !== undefined ||
  process.env.PI_APP_TEST_LANE !== undefined;
if (process.platform === "darwin" && !remoteDesktopDefaultsDisabled) {
  const clientConfigPath =
    process.env.PI_REMOTE_DESKTOP_CLIENT_CONFIG?.trim() ||
    path.join(homedir(), "Pi", "runtime", "remote-desktop", "client.json");
  if (existsSync(clientConfigPath)) {
    process.env.PI_REMOTE_DESKTOP_CLIENT = "1";
    process.env.PI_REMOTE_DESKTOP_CLIENT_CONFIG = clientConfigPath;
    process.env.PI_APP_USER_DATA_DIR ||= path.join(
      homedir(),
      "Pi",
      "runtime",
      "remote-desktop",
      "gui",
    );
    // A remote client must not run the managed local provider/profile preparation step.
    process.env.PI_GUI_INTEGRATED_LAUNCH = "1";
  }
}
if (process.platform === "win32" && !remoteDesktopDefaultsDisabled) {
  const hostConfigPath =
    process.env.PI_REMOTE_DESKTOP_HOST_CONFIG?.trim() ||
    "D:\\Pi\\pi-ecosystem\\.state\\remote-desktop\\host.json";
  if (existsSync(hostConfigPath)) process.env.PI_REMOTE_DESKTOP_HOST_CONFIG = hostConfigPath;
}
const remoteDesktopClientMode = process.env.PI_REMOTE_DESKTOP_CLIENT === "1";

function traceStartup(stage: string): void {
  if (process.env.PI_APP_STARTUP_TRACE === "1")
    console.info(`[startup] ${stage}: ${Math.round(performance.now())}ms`);
}
function traceStartupDuration(stage: string, startedAt: number): void {
  if (process.env.PI_APP_STARTUP_TRACE === "1")
    console.info(`[startup] ${stage}: ${Math.round(performance.now() - startedAt)}ms`);
}
traceStartup("main imports loaded");
handOffManagedWindowsLaunch();
handOffManagedMacLaunch();
traceStartup("managed profile ready");

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_EXTENSION_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const appTestMode = resolveAppTestMode(process.env.PI_APP_TEST_MODE);
const windowTestMode = appTestMode ?? "foreground";
let windowStateRestored = false;
const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";
const TURN_CAPTURE_BACKSTOP_MS = 10_000;
let store: DesktopAppStore;
let automationIngress: NativeAutomationIngress | undefined;
let extensionViewOwner: DesktopExtensionViewOwner | undefined;
let windowOwner: WindowOwner;
let remoteDesktopClient: RemoteDesktopHttpClient | undefined;
let remoteDesktopHost: RemoteDesktopHttpHost | undefined;
let remoteDesktopHostConfig: RemoteDesktopHostFileConfig | undefined;
let macWorkspaceFolderAdapter: WorkspaceFolderAdapter | undefined;
// Stand-ins for Mac folders opened as Pi projects (beside the Mac discovery file in .state).
let macProjectsPath: string | undefined;
let remoteDesktopClientPreferences: RemoteDesktopClientPreferences =
  DEFAULT_REMOTE_DESKTOP_CLIENT_PREFERENCES;
const remoteDesktopBrokers = new Set<RemoteDesktopBroker>();
const themeManager = new ThemeManager();
let mainWindow: BrowserWindow | null = null;
// Windows-only frame shown before the store starts; it receives the content afterwards.
let launchWindow: BrowserWindow | undefined;
let appTray: Tray | undefined;
let notificationManager: NotificationManager | undefined;
let remoteNotifications: ReturnType<typeof createRemoteNotificationStore> | undefined;
let notificationPermissionService: NotificationPermissionService | undefined;
let terminalService: TerminalService | undefined;
let integratedTerminalShell = "";
let applicationRelaunchRequested = false;

function requestApplicationRelaunch(): void {
  if (applicationRelaunchRequested) {
    return;
  }
  applicationRelaunchRequested = true;
  app.relaunch();
  app.quit();
}

function createWindowsWorkspaceFolderRoots(
  store: DesktopAppStore,
  rootIds: ReadonlySet<string>,
  createRootIds: ReadonlySet<string>,
) {
  const records = new Map(store.getWorkspaceRecords().map((record) => [record.id, record]));
  const roots: WindowsWorkspaceFolderRootConfig[] = [];
  for (const id of rootIds) {
    const record = records.get(id);
    if (!record || !existsSync(record.path)) {
      // A creation root is a parent folder for new projects ("D:\Pi\projects"); it need not be
      // a sidebar folder itself, so an unregistered root is used by its path.
      if (!record && createRootIds.has(id) && path.isAbsolute(id) && existsSync(id)) {
        roots.push({ id, label: path.basename(id), canCreate: true, path: id });
        continue;
      }
      if (createRootIds.has(id)) {
        throw new Error("A configured Windows folder root is unavailable.");
      }
      continue;
    }
    roots.push({
      id,
      label: record.name,
      workspaceId: id,
      canCreate: createRootIds.has(id),
      path: record.path,
    });
  }
  return roots;
}

async function loadMacWorkspaceFolderAdapter(
  config: RemoteDesktopMacFoldersConfig,
): Promise<WorkspaceFolderAdapter> {
  const discoveryPath = path.resolve(config.configPath);
  const discoveryDirectory = path.dirname(discoveryPath);
  if (
    path.basename(discoveryPath).toLowerCase() !== "mac-discovery.json" ||
    path.basename(discoveryDirectory).toLowerCase() !== ".state" ||
    path.basename(path.dirname(discoveryDirectory)).toLowerCase() !== "pi-ecosystem"
  ) {
    throw new Error("The configured Mac folder discovery path is not approved.");
  }
  const expectedPath = path.resolve(discoveryDirectory, "..", "src", "mac-folder-browser.mjs");
  const modulePath = path.resolve(config.modulePath);
  if (modulePath.toLowerCase() !== expectedPath.toLowerCase()) {
    throw new Error("The configured Mac folder adapter is not an approved host module.");
  }
  const [metadata, canonicalPath] = await Promise.all([lstat(modulePath), realpath(modulePath)]);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    canonicalPath.toLowerCase() !== modulePath.toLowerCase()
  ) {
    throw new Error("The configured Mac folder adapter is unavailable.");
  }
  const loaded = (await import(pathToFileURL(modulePath).href)) as {
    createMacWorkspaceFolderAdapter?: unknown;
  };
  if (typeof loaded.createMacWorkspaceFolderAdapter !== "function") {
    throw new Error("The configured Mac folder adapter has an invalid entry point.");
  }
  const adapter = await (
    loaded.createMacWorkspaceFolderAdapter as (input: {
      readonly configPath: string;
      readonly roots: readonly WorkspaceFolderRoot[];
    }) => Promise<WorkspaceFolderAdapter>
  )({ configPath: config.configPath, roots: config.roots });
  if (
    !adapter ||
    typeof adapter.listRoots !== "function" ||
    typeof adapter.list !== "function" ||
    typeof adapter.open !== "function" ||
    typeof adapter.create !== "function"
  ) {
    throw new Error("The configured Mac folder adapter is unavailable.");
  }
  return adapter;
}

interface OrchestrationRuntimeToolTestInput {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly sessionRef: SessionRef;
  readonly params: unknown;
}

interface ScheduledTaskRuntimeToolTestInput {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly sessionRef: SessionRef;
  readonly params: unknown;
}

function createStoreBackedScheduledTaskRuntimeBridge(): ScheduledTaskRuntimeBridge {
  return {
    createScheduledTask: async (ctx, input) => {
      await store.initialize();
      return store.createScheduledTaskToolResult(sessionRefFromExtensionContext(ctx), input);
    },
    listScheduledTasks: async () => {
      await store.initialize();
      return store.listScheduledTasksToolResult();
    },
    updateScheduledTask: async (_ctx, input) => {
      await store.initialize();
      return store.updateScheduledTaskToolResult(input);
    },
  };
}

async function runScheduledTaskRuntimeToolForTest(
  bridge: ScheduledTaskRuntimeBridge,
  input: ScheduledTaskRuntimeToolTestInput,
): Promise<AgentToolResult<unknown>> {
  await store.initialize();
  const tool = createScheduledTaskRuntimeTools(bridge, () => input.sessionRef.workspaceId).find(
    (entry) => entry.name === input.toolName,
  );
  if (!tool) {
    throw new Error(`Unknown scheduled-task runtime tool: ${input.toolName}`);
  }
  return tool.execute(
    input.toolCallId ?? `test-${input.toolName}`,
    input.params,
    undefined,
    undefined,
    createTestExtensionContext(input.sessionRef),
  );
}

let stopNotifications: (() => void) | undefined;
let stopUpdateChecker: (() => void) | undefined;
let appUpdater: AppUpdater | undefined;
let signIns: ReturnType<typeof startSignInMonitor> | undefined;
let stopLimitRefresh: (() => void) | undefined;
let stopPruningTerminals: (() => void) | undefined;
let retainedTerminalWorkspacePathSignature = "";
const terminalFocusedWebContentsIds = new Set<number>();
const sidePanelFocusedWebContentsIds = new Set<number>();
const surfaceCloseShortcutIds = new Set<number>();
// "flushing" while quit saves drafts and the store; "done" once quit may proceed.
let quitFlush: "idle" | "flushing" | "done" = "idle";

const SUPPORTED_IMAGE_TYPES = SUPPORTED_COMPOSER_IMAGE_TYPES;
const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>(
  SUPPORTED_IMAGE_TYPES.map((type) => type.mimeType),
);
const NEW_WINDOW_MENU_ITEM_ID = "file.new-window";

function createStoreBackedOrchestrationRuntimeBridge(): OrchestrationRuntimeBridge {
  return {
    createChildThread: async (ctx, input) => {
      await store.initialize();
      return store.createChildThreadToolResult(sessionRefFromExtensionContext(ctx), input);
    },
    listThreads: async (ctx) => {
      await store.initialize();
      return store.listThreadsToolResult(sessionRefFromExtensionContext(ctx));
    },
    readThread: async (ctx, threadId) => {
      await store.initialize();
      return store.readThreadToolResult(sessionRefFromExtensionContext(ctx), threadId);
    },
    sendMessageToThread: async (ctx, input) => {
      await store.initialize();
      return store.sendMessageToThreadToolResult(sessionRefFromExtensionContext(ctx), input);
    },
  };
}

function sessionRefFromExtensionContext(ctx: ExtensionContext): SessionRef {
  const sessionId = ctx.sessionManager.getSessionId();
  const cwd = path.resolve(ctx.sessionManager.getCwd?.() ?? ctx.cwd);
  const sessionRef = store.findSessionRefByCwdAndSessionId(cwd, sessionId);
  if (!sessionRef) {
    throw new Error(`Unable to resolve orchestration session for ${cwd}:${sessionId}`);
  }
  return sessionRef;
}

async function runOrchestrationRuntimeToolForTest(
  bridge: OrchestrationRuntimeBridge,
  input: OrchestrationRuntimeToolTestInput,
): Promise<AgentToolResult<unknown>> {
  await store.initialize();
  const tool = createOrchestrationRuntimeTools(bridge).find(
    (entry) => entry.name === input.toolName,
  );
  if (!tool) {
    throw new Error(`Unknown orchestration runtime tool: ${input.toolName}`);
  }
  return tool.execute(
    input.toolCallId ?? `test-${input.toolName}`,
    input.params,
    undefined,
    undefined,
    createTestExtensionContext(input.sessionRef),
  );
}

function createTestExtensionContext(sessionRef: SessionRef): ExtensionToolContext {
  const workspace = store
    .snapshot()
    .workspaces.find(
      (entry) =>
        entry.id === sessionRef.workspaceId &&
        entry.sessions.some((session) => session.id === sessionRef.sessionId),
    );
  if (!workspace) {
    throw new Error(`Unknown test session: ${sessionRef.workspaceId}:${sessionRef.sessionId}`);
  }

  return {
    hasUI: false,
    mode: "json",
    cwd: workspace.path,
    sessionManager: {
      getSessionId: () => sessionRef.sessionId,
      getCwd: () => workspace.path,
    } as ExtensionContext["sessionManager"],
    ui: {} as ExtensionContext["ui"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    scopedModels: [],
    model: undefined,
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
    tools: [],
    executeTool: () => Promise.reject(new Error("Nested tool calls are not available in tests")),
  };
}
const OPEN_FOLDER_MENU_ITEM_ID = "file.open-folder";
const CHECK_FOR_UPDATES_MENU_ITEM_ID = "app.check-for-updates";
const QUIT_FLUSH_TIMEOUT_MS = 5_000;
// Part of the quit budget above: renderers get this long to send their debounced drafts.
const DRAFT_FLUSH_TIMEOUT_MS = 2_000;
const composerDraftFlusher = new PendingComposerDraftFlusher(DRAFT_FLUSH_TIMEOUT_MS);
// Windows whose draft was flushed and whose close is now allowed through.
const windowsClosingAfterDraftFlush = new WeakSet<BrowserWindow>();

function getTerminalService(): TerminalService {
  if (!terminalService) {
    terminalService = new TerminalService({
      getWorkspacePath: (workspaceId) => store.getWorkspacePath(workspaceId),
      getIntegratedTerminalShell: () => integratedTerminalShell,
      connectHost,
      onHostEvent,
    });
  }
  return terminalService;
}

// Resolve the bundled application icon. In dev the repo's `resources/icon.png`
// sits two levels up from the compiled `out/main/main.js`; in a packaged build
// it is copied to `process.resourcesPath` via `extraResources` in
// electron-builder.yml. On macOS packaged builds the window/dock icon already
// comes from `icon.icns` in the app bundle, so we only need the PNG for dev
// and for Linux/Windows window chrome.
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.join(__dirname, "..", "..", "resources", "icon.png");
const appIcon = nativeImage.createFromPath(appIconPath);

function parseExternalWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function appRendererUrl(): string {
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    return process.env.ELECTRON_RENDERER_URL;
  }
  const indexPath = path.join(__dirname, "..", "renderer", "index.html");
  return pathToFileURL(indexPath).toString();
}

function isInAppNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const appUrl = new URL(appRendererUrl());
    return parsed.href === appUrl.href || (isDev && parsed.origin === appUrl.origin);
  } catch {
    return false;
  }
}

function openExternalWebUrl(url: string): boolean {
  const parsed = parseExternalWebUrl(url);
  if (!parsed) {
    return false;
  }
  void shell.openExternal(parsed.toString()).catch((error) => {
    console.error(`Failed to open external URL: ${parsed.toString()}`, error);
  });
  return true;
}

/** MCP sign-in pages: any https URL, or http only on this machine (a local OAuth server). */
function openMcpSignInUrl(url: string): void {
  const parsed = parseExternalWebUrl(url);
  const loopback =
    parsed?.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
  if (!parsed || (parsed.protocol !== "https:" && !loopback)) {
    // Sign-in URLs carry state and codes in their query, so logs name the origin at most.
    console.error(
      `Refusing to open an MCP sign-in URL${parsed ? ` on ${parsed.origin}` : " that is not http or https"}`,
    );
    showMcpSignInUrl(url, "Pegasus opens only https links, or http links on this computer.");
    return;
  }
  shell.openExternal(parsed.toString()).catch((error: unknown) => {
    console.error(`Failed to open an MCP sign-in URL on ${parsed.origin}`, error);
    showMcpSignInUrl(parsed.toString(), "Pegasus could not open your browser.");
  });
}

/** When the browser cannot be opened, the link is shown so the person can copy it. */
function showMcpSignInUrl(url: string, reason: string): void {
  const window = mainWindow && canPublishToWindow(mainWindow) ? mainWindow : undefined;
  const options: MessageBoxOptions = {
    type: "warning",
    title: "Pegasus",
    message: "Open this MCP sign-in link yourself",
    detail: `${reason} Check the link before you open it:\n\n${url}`,
    buttons: ["Copy link", "Close"],
    defaultId: 0,
    cancelId: 1,
  };
  (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
    .then(({ response }) => {
      if (response === 0) clipboard.writeText(url);
    })
    .catch((error: unknown) => {
      console.error("Failed to show the MCP sign-in link", error);
    });
}

async function openExternalLink(url: string): Promise<void> {
  const parsed = parseExternalWebUrl(url);
  if (!parsed) {
    throw new Error(`Refusing to open unsupported URL: ${url}`);
  }
  await shell.openExternal(parsed.toString());
}

function readClipboardImageAttachment(): ClipboardImageRead {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return { ok: false };
  }

  const size = image.getSize();
  try {
    assertComposerImagePixels(size.width, size.height);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const png = image.toPNG();
  if (png.length === 0) {
    return { ok: false };
  }
  try {
    assertComposerImageBytes(png.length);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ok: true,
    attachment: {
      id: randomUUID(),
      kind: "image",
      name: "pasted-image.png",
      mimeType: "image/png",
      data: png.toString("base64"),
    },
  };
}

function dispatchCloseFocusedSurface(window: BrowserWindow, event: Electron.Event): void {
  event.preventDefault();
  const webContentsId = window.webContents.id;
  surfaceCloseShortcutIds.add(webContentsId);
  setImmediate(() => {
    surfaceCloseShortcutIds.delete(webContentsId);
  });
  window.webContents.send(desktopIpc.appCommand, desktopCommands.closeFocusedSurface);
}

// The native window colour matches the renderer's theme, so load, reload and
// resize never flash another theme's colour.
function currentWindowBackground(): string {
  return windowBackgroundFor(
    remoteDesktopClientMode
      ? remoteDesktopClientPreferences.themePresetId
      : (store?.snapshot().themePresetId ?? "default"),
    themeManager.getResolvedTheme(),
  );
}

function nativeWindowTransparencyEnabled(): boolean {
  return remoteDesktopClientMode
    ? remoteDesktopClientPreferences.enableTransparency
    : (store?.snapshot().enableTransparency ?? true);
}

function isDesktopAppState(value: unknown): value is DesktopAppState {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { readonly workspaces?: unknown }).workspaces)
  );
}

// Opaque windows track the current theme background while glass is disabled.
const opaqueAppWindows = new Set<BrowserWindow>();
const overlayAppWindows = new Set<BrowserWindow>();

function refreshWindowBackgrounds(): void {
  if (!store) return;
  const color = currentWindowBackground();
  for (const window of opaqueAppWindows) {
    if (!window.isDestroyed()) window.setBackgroundColor(color);
  }
  if (process.platform === "win32") {
    // Only app windows have a title bar overlay; sign-in and other popups throw "Titlebar overlay is not enabled".
    for (const window of overlayAppWindows) {
      if (!window.isDestroyed()) {
        window.setTitleBarOverlay(windowsTitleBarOverlay());
        setWindowTransparency(window, nativeWindowTransparencyEnabled());
      }
    }
  }
}

// The hidden Windows title bar keeps its caption buttons as an overlay at the
// topbar's height; their glyphs follow the theme, their background stays clear.
function windowsTitleBarOverlay(): Electron.TitleBarOverlayOptions {
  const dark = themeManager.getResolvedTheme() === "dark";
  return { color: "#00000000", symbolColor: dark ? "#ffffffd9" : "#000000d9", height: 48 };
}

function supportsNativeWindowGlass(): boolean {
  if (process.platform === "darwin") return true;
  if (process.platform !== "win32") return false;
  const build = Number(process.getSystemVersion().split(".")[2]);
  return Number.isInteger(build) && build >= 22621;
}

function setWindowTransparency(window: BrowserWindow, enabled: boolean): void {
  const nativeGlassEnabled = enabled && supportsNativeWindowGlass();
  window.setBackgroundColor(nativeGlassEnabled ? "#00000000" : currentWindowBackground());
  if (process.platform === "darwin") {
    window.setVibrancy(nativeGlassEnabled ? "under-window" : null);
  } else if (process.platform === "win32") {
    // Apply DWM material after updating the underlying window surface.
    window.setBackgroundMaterial(nativeGlassEnabled ? "acrylic" : "none");
  }
  if (nativeGlassEnabled) {
    opaqueAppWindows.delete(window);
  } else {
    opaqueAppWindows.add(window);
  }
}
function createWindow({ deferContent = false }: { deferContent?: boolean } = {}): BrowserWindow {
  const backgroundTestMode = windowTestMode === "background";
  const enableTransparency = nativeWindowTransparencyEnabled();
  const nativeGlassAvailable = supportsNativeWindowGlass();
  const nativeGlassEnabled = enableTransparency && nativeGlassAvailable;
  const macVibrancyEnabled = process.platform === "darwin" && nativeGlassEnabled;
  // Acrylic blurs what is behind the window (frosted, like Windows Terminal);
  // Mica only tints with the wallpaper.
  const windowsGlassMaterial =
    process.platform === "win32" ? (nativeGlassEnabled ? "acrylic" : "none") : undefined;
  // The first window of a launch reopens with the size and place it was closed in (not in tests).
  const restored =
    !appTestMode && !windowStateRestored ? loadWindowState(configuredUserDataDir) : undefined;
  windowStateRestored = true;
  const window = new BrowserWindow({
    ...(restored?.bounds ?? { width: 1480, height: 980 }),
    minWidth: 560,
    minHeight: 600,
    // Windows materials need no transparent window, and acrylic over one stops
    // drawing the web contents.
    transparent: process.platform === "darwin",
    vibrancy: macVibrancyEnabled ? "under-window" : undefined,
    visualEffectState: macVibrancyEnabled ? "followWindow" : undefined,
    backgroundMaterial: windowsGlassMaterial,
    titleBarStyle: process.platform === "win32" ? "hidden" : "hiddenInset",
    titleBarOverlay: process.platform === "win32" ? windowsTitleBarOverlay() : undefined,
    autoHideMenuBar: process.platform !== "darwin",
    backgroundColor: nativeGlassEnabled ? "#00000000" : currentWindowBackground(),
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep hidden test windows responsive so Playwright exercises the same UI flows.
      backgroundThrottling: !backgroundTestMode,
    },
  });

  if (process.platform === "win32") {
    overlayAppWindows.add(window);
    window.once("closed", () => overlayAppWindows.delete(window));
    const restoreMaterial = () => setWindowTransparency(window, nativeWindowTransparencyEnabled());
    window.webContents.on("did-finish-load", restoreMaterial);
    window.on("maximize", restoreMaterial);
    window.on("unmaximize", restoreMaterial);
    window.on("restore", restoreMaterial);
  }

  if (!appTestMode) trackWindowState(window, configuredUserDataDir);
  if (restored?.maximized)
    window.once("show", () =>
      queueMicrotask(() => {
        if (!window.isDestroyed()) window.maximize();
      }),
    );
  if (restored?.fullScreen)
    window.once("show", () =>
      queueMicrotask(() => {
        if (!window.isDestroyed()) window.setFullScreen(true);
      }),
    );

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInAppNavigationUrl(url)) {
      openExternalWebUrl(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    try {
      const url = new URL(event.url);
      if (
        url.protocol !== `${DESKTOP_EXTENSION_SCHEME}:` ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("Unexpected frame navigation");
      if (!extensionViewOwner) throw new Error("Extension host unavailable");
      extensionViewOwner.getConnectionContext(url.hostname, window.webContents.id);
    } catch {
      event.preventDefault();
    }
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isInAppNavigationUrl(url)) {
      return;
    }
    event.preventDefault();
    openExternalWebUrl(url);
  });

  window.on("close", (event) => {
    if (surfaceCloseShortcutIds.has(window.webContents.id)) {
      event.preventDefault();
      surfaceCloseShortcutIds.delete(window.webContents.id);
      return;
    }
    // Quit flushes every window's draft and then the store before it closes any window. A
    // close during that flush would drop this window's draft, and closing the last window
    // would re-enter quit and skip the store flush, so quit closes it once the flush ends.
    if (quitFlush === "flushing") {
      event.preventDefault();
      return;
    }
    if (quitFlush === "done" || windowsClosingAfterDraftFlush.delete(window)) return;
    // Otherwise hold this close until the renderer sends its debounced draft, since closing
    // the window would discard it.
    event.preventDefault();
    void composerDraftFlusher
      .flush([window])
      .finally(() => {
        if (window.isDestroyed()) return;
        windowsClosingAfterDraftFlush.add(window);
        window.close();
      })
      .catch((error: unknown) => {
        console.error("[main] Closing the window after its draft flush failed", error);
      });
  });
  if (deferContent) {
    // Windows only lets a fresh launch take the foreground until the user acts
    // elsewhere, so show the empty frame now instead of after startup finishes.
    if (windowTestMode === "inactive") window.showInactive();
    else {
      window.show();
      window.focus();
    }
  } else {
    window.once("ready-to-show", () => {
      if (windowTestMode === "inactive") {
        window.showInactive();
      } else if (!backgroundTestMode) {
        window.show();
        app.focus({ steal: true });
        window.focus();
      }
    });
  }
  window.webContents.on("before-input-event", (event, input) => {
    // A launch frame has no app content or window owner yet.
    if (input.type !== "keyDown" || !window.webContents.getURL()) {
      return;
    }

    // Side panel tab chords act from the terminal and extension views too. The
    // key is not consumed: that would also swallow the modifier's keyup, leaving
    // the tab hints up, and on Windows and Linux it would let the Alt release
    // open the hidden menu bar. The page takes no default action for these keys,
    // and the renderer's own handling of the same keydown is idempotent.
    const sidePanelTabCommand = getSidePanelTabCommand(process.platform, input);
    if (sidePanelTabCommand) {
      if (!input.isAutoRepeat) window.webContents.send(desktopIpc.appCommand, sidePanelTabCommand);
      return;
    }

    const lowerKey = input.key.toLowerCase();
    const platformModifier = platformShortcutModifier(process.platform, input);
    const command = getDesktopCommandFromShortcut({
      modifier: platformModifier,
      alt: input.alt,
      shift: input.shift,
      key: input.key,
      code: input.code,
    });
    const webContentsId = window.webContents.id;
    const terminalFocused = terminalFocusedWebContentsIds.has(webContentsId);
    const closeFocusedSurface =
      isCloseFocusedSurfaceShortcut({
        meta: input.meta,
        control: input.control,
        alt: input.alt,
        shift: input.shift,
        key: input.key,
        code: input.code,
        platform: process.platform,
      }) &&
      (terminalFocused || sidePanelFocusedWebContentsIds.has(webContentsId));
    if (terminalFocused) {
      // Control chords belong to the shell, so only macOS Command chords open
      // a palette or act on the thread from the terminal.
      if (process.platform === "darwin" && isSinglePressCommand(command)) {
        event.preventDefault();
        if (!input.isAutoRepeat) window.webContents.send(desktopIpc.appCommand, command);
      } else if (command === desktopCommands.toggleSidePanel) {
        event.preventDefault();
        window.webContents.send(desktopIpc.appCommand, command);
      } else if (closeFocusedSurface) {
        dispatchCloseFocusedSurface(window, event);
      }
      return;
    }
    if (closeFocusedSurface) {
      dispatchCloseFocusedSurface(window, event);
      return;
    }
    if (platformModifier && input.shift && lowerKey === "n") {
      event.preventDefault();
      createAppWindow(windowOwner.viewForWindow(window));
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "o") {
      event.preventDefault();
      void pickWorkspaceViaDialog(window).catch((error: unknown) => {
        console.error("[main] pickWorkspaceViaDialog failed", error);
      });
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "v") {
      const clipboardImage = readClipboardImageAttachment();
      if (clipboardImage.ok || clipboardImage.message) {
        event.preventDefault();
        window.webContents.send(desktopIpc.clipboardImagePasted, clipboardImage);
        return;
      }
    }

    if (command) {
      event.preventDefault();
      // Holding a palette chord would open and close it at the repeat rate.
      if (isSinglePressCommand(command) && input.isAutoRepeat) {
        return;
      }
      window.webContents.send(desktopIpc.appCommand, command);
    }
  });

  if (!deferContent) {
    loadAppRenderer(window);
  }

  window.once("closed", () => opaqueAppWindows.delete(window));
  if (!nativeGlassEnabled) {
    opaqueAppWindows.add(window);
  }

  return window;
}

function loadAppRenderer(window: BrowserWindow): void {
  traceStartup("renderer load started");
  window.webContents.once("did-finish-load", () => traceStartup("renderer loaded"));
  if (isDev) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL as string).catch((error: unknown) => {
      console.error("[main] loadURL failed", error);
    });
    if (process.env.PI_APP_OPEN_DEVTOOLS !== "0") {
      window.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void window.loadURL(appRendererUrl()).catch((error: unknown) => {
      console.error("[main] loadURL failed", error);
    });
  }
}

function createAppWindow(sourceView?: DesktopAppViewState, frame?: BrowserWindow): BrowserWindow {
  const window = frame ?? createWindow();
  if (frame) {
    // The frame was built before saved settings loaded; apply them, then load content.
    setWindowTransparency(frame, nativeWindowTransparencyEnabled());
    loadAppRenderer(frame);
  }
  const webContentsId = window.webContents.id;
  windowOwner.add(window, sourceView);
  themeManager.trackWindow(window);

  window.once("closed", () => {
    windowOwner.remove(window);
    terminalFocusedWebContentsIds.delete(webContentsId);
    sidePanelFocusedWebContentsIds.delete(webContentsId);
    surfaceCloseShortcutIds.delete(webContentsId);
    terminalService?.disposeWebContents(webContentsId);
    void store
      .cancelPendingDialogsWithoutVisibleWindow((sessionRef) =>
        windowOwner.isSessionVisibleInAnotherWindow(sessionRef),
      )
      .catch((error: unknown) => {
        console.error("[main] cancelPendingDialogsWithoutVisibleWindow failed", error);
      });
    if (windowOwner.size() === 0) {
      terminalService?.dispose();
      terminalService = undefined;
    }
  });

  return window;
}

function canPublishToWindow(window: BrowserWindow): boolean {
  return (
    !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed()
  );
}

// "inactive": visible and painting (frame and input timings are real) but never takes focus, so
// perf runs on the owner's PC do not pull them out of a fullscreen app.
function resolveAppTestMode(
  value: string | undefined,
): "foreground" | "background" | "inactive" | undefined {
  return value === "foreground" || value === "background" || value === "inactive"
    ? value
    : undefined;
}

function resolveDialogWindow(parentWindow?: BrowserWindow | null): BrowserWindow | undefined {
  return windowOwner.resolveDialogWindow(parentWindow);
}

async function stateForWindow(window?: BrowserWindow | null): Promise<DesktopAppState> {
  return windowOwner.stateForWindow(window);
}

function runWindowScopedForWindow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
  options: { readonly forceActiveWindow?: boolean } = {},
): Promise<DesktopAppState> {
  return windowOwner.runStateAction(window, action, options);
}

async function pickWorkspacePathViaDialog(
  parentWindow?: BrowserWindow | null,
): Promise<string | undefined> {
  const window = resolveDialogWindow(parentWindow);
  const result = window
    ? await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
        title: "Open workspace folder",
      })
    : await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Open workspace folder",
      });
  if (result.canceled || result.filePaths.length === 0) {
    return undefined;
  }
  return result.filePaths[0] as string;
}

async function addPickedWorkspace(
  window: BrowserWindow | null | undefined,
  workspacePath: string,
): Promise<DesktopAppState> {
  const nextState = await store.addWorkspace(workspacePath);
  if (!nextState.selectedWorkspaceId) {
    return nextState;
  }
  const newThreadState =
    nextState.activeView === "new-thread" ? nextState : await store.setActiveView("new-thread");
  if (window) {
    window.webContents.send(desktopIpc.workspacePicked, nextState.selectedWorkspaceId);
  }
  return newThreadState;
}

async function pickWorkspaceViaDialog(
  parentWindow?: BrowserWindow | null,
  createNew = false,
): Promise<DesktopAppState> {
  const window = resolveDialogWindow(parentWindow);
  let workspacePath: string | undefined;
  if (createNew) {
    const options = { title: "Create project folder", buttonLabel: "Create folder" };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (!result.canceled && result.filePath) {
      // Never replace an existing file/directory, or create unchosen parents.
      try {
        await mkdir(result.filePath);
        workspacePath = result.filePath;
      } catch {
        const message = {
          type: "error" as const,
          title: "Pegasus",
          message:
            "Couldn't create this folder. Choose a new name in an existing folder, or use Open folder for an existing project.",
        };
        if (window) await dialog.showMessageBox(window, message);
        else await dialog.showMessageBox(message);
      }
    }
  } else {
    workspacePath = await pickWorkspacePathViaDialog(window);
  }
  if (!workspacePath) {
    return stateForWindow(window);
  }
  return runWindowScopedForWindow(window, () => addPickedWorkspace(window, workspacePath));
}

/** One updater per app; the Mac client also learns its Windows host's version through it. */
function createAppUpdater(): AppUpdater {
  appUpdater ??= new AppUpdater({
    canInstall: app.isPackaged && !isDev && process.env.PI_APP_TEST_MODE === undefined,
    ...(remoteDesktopClientMode
      ? {
          getHostVersion: async () => {
            const version = await remoteDesktopClient?.invoke("getAppVersion", []);
            return typeof version === "string" ? version : undefined;
          },
        }
      : {}),
  });
  return appUpdater;
}

async function runManualUpdateCheck(): Promise<void> {
  const window = mainWindow && canPublishToWindow(mainWindow) ? mainWindow : undefined;
  const showDialog = (options: MessageBoxOptions) =>
    window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);

  try {
    const status = await (appUpdater ?? createAppUpdater()).check();

    if (status.phase === "available" && status.latestVersion) {
      // The manual menu path always confirms with a dialog — a notification may
      // be silently suppressed if the OS permission is denied.
      const choice = await showDialog({
        type: "info",
        title: "Pegasus",
        message: `Version ${status.latestVersion} is available.`,
        detail: status.canInstall
          ? `You have ${status.currentVersion}. Pegasus restarts to finish the update.`
          : `You have ${status.currentVersion}.`,
        buttons: [status.canInstall ? "Update now" : "Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response === 0) {
        if (status.canInstall) await appUpdater?.install();
        else if (status.releaseUrl) await openReleasesPage(status.releaseUrl);
      }
      return;
    }

    if (!status.message) {
      await showDialog({
        type: "info",
        title: "Pegasus",
        message: `You're up to date on version ${status.currentVersion}.`,
        buttons: ["OK"],
      });
      return;
    }

    await showDialog({
      type: "warning",
      title: "Pegasus",
      message: "Could not check for updates right now.",
      detail: status.message,
      buttons: ["OK"],
    });
  } catch (error) {
    console.error("pi-gui: manual update check failed:", error);
    await showDialog({
      type: "warning",
      title: "Pegasus",
      message: "Could not check for updates right now.",
      detail: error instanceof Error ? error.message : String(error),
      buttons: ["OK"],
    }).catch(() => undefined);
  }
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          id: CHECK_FOR_UPDATES_MENU_ITEM_ID,
          label: "Check for Updates…",
          click: () => {
            void runManualUpdateCheck().catch((error: unknown) => {
              console.error("[main] runManualUpdateCheck failed", error);
            });
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Thread",
          accelerator: "CommandOrControl+N",
          click: () => {
            const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
            window?.webContents.send(desktopIpc.appCommand, desktopCommands.openNewThread);
          },
        },
        {
          id: NEW_WINDOW_MENU_ITEM_ID,
          label: "New Window",
          accelerator: "CommandOrControl+Shift+N",
          click: () => {
            createAppWindow(windowOwner.foregroundView());
          },
        },
        { type: "separator" },
        {
          id: OPEN_FOLDER_MENU_ITEM_ID,
          label: "Open Folder…",
          accelerator: "Command+O",
          click: () => {
            void pickWorkspaceViaDialog(mainWindow).catch((error: unknown) => {
              console.error("[main] pickWorkspaceViaDialog failed", error);
            });
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        // Cmd+R toggles Review and Shift+Cmd+R renames the thread, so neither
        // reload has a shortcut.
        {
          label: "Reload",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.reload(),
        },
        {
          label: "Force Reload",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.reloadIgnoringCache(),
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Ensure npm (and other Homebrew/npm-global binaries) are available even when
// pi-gui is launched via Finder/Dock (which hands the process a minimal PATH).
// POSIX-only; on Windows the PATH is left untouched (see augmentPosixPath).
// Tests that need an exact PATH (no gh, say, on a Mac runner whose Homebrew has one) opt out.
const augmentedPath = augmentPosixPath();
if (augmentedPath.changed && !(appTestMode && process.env.PI_APP_TEST_EXACT_PATH === "1")) {
  process.env.PATH = augmentedPath.path;
}

app.setName("Pegasus");
// The Rust host (pegasus-host) outlives windows; a packaged app replaces a host built for another
// version once it is idle. Dev runs leave this unset and accept any host.
if (app.isPackaged) process.env.PEGASUS_APP_VERSION ??= app.getVersion();

const configuredUserDataDir = process.env.PI_APP_USER_DATA_DIR?.trim() || app.getPath("userData");
app.setPath("userData", configuredUserDataDir);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // app.quit() before ready can leave a windowless macOS process alive.
  // Duplicate instances have no store or windows, so exit immediately.
  app.exit(0);
}

/** Brings a Pegasus window forward, opening one if every window was closed (to the tray). */
function showAppWindow(): void {
  // A repeat launch can arrive before the window owner exists.
  const window = windowOwner?.foreground() ?? launchWindow;
  if (!window) {
    if (windowOwner && windowOwner.size() === 0) createAppWindow();
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

app.on("second-instance", showAppWindow);

app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstanceLock) {
      return;
    }
    if (remoteDesktopClientMode) {
      if (process.platform !== "darwin") {
        throw new Error("Remote desktop client mode is supported only on macOS.");
      }
      const configPath = process.env.PI_REMOTE_DESKTOP_CLIENT_CONFIG?.trim();
      if (!configPath) throw new Error("Remote desktop client configuration is unavailable.");
      const config = await readPrivateRemoteDesktopConfig(
        configPath,
        process.platform,
        parseRemoteDesktopClientConfig,
      );
      remoteDesktopClientPreferences =
        await loadRemoteDesktopClientPreferences(configuredUserDataDir);
      remoteDesktopClient = new RemoteDesktopHttpClient(config);
    }
    traceStartup("electron ready");
    watchMainThreadStalls(path.join(configuredUserDataDir, "logs"));
    if (process.platform === "win32" && windowTestMode !== "background") {
      launchWindow = createWindow({ deferContent: true });
      const startupHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Pegasus startup</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#111;color:#bbb;font:14px system-ui;color-scheme:dark}.status{display:flex;align-items:center;gap:12px}.spinner{width:16px;height:16px;border:2px solid #444;border-top-color:#ddd;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}</style></head><body><div class="status" role="status"><span class="spinner" aria-hidden="true"></span><span>Opening your workspace...</span></div></body></html>`;
      await launchWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupHtml)}`);
      // A minimized or occluded window may never receive animation frames.
      // The loaded shell can paint while async initialization prepares its runtime.
      traceStartup("startup shell loaded");
    }

    // On macOS, packaged builds already render the dock icon from `icon.icns`
    // in the app bundle. In dev we override the generic Electron dock icon with
    // the real PNG so the running app looks right end-to-end.
    if (process.platform === "darwin" && !app.isPackaged) {
      app.dock?.setIcon(appIcon);
    }

    let generateThreadTitleOverride:
      | ((
          workspace: WorkspaceRef,
          options: GenerateThreadTitleOptions,
        ) => Promise<string | null | undefined>)
      | undefined;
    let deferredThreadTitle:
      | {
          resolve: (title: string | null) => void;
          reject: (error: Error) => void;
        }
      | undefined;
    const orchestrationRuntimeBridge = createStoreBackedOrchestrationRuntimeBridge();
    const scheduledTaskRuntimeBridge = createStoreBackedScheduledTaskRuntimeBridge();
    const checkpoints = new TurnCheckpointStore(configuredUserDataDir);
    const extensionViews: DesktopExtensionViewOwner = new DesktopExtensionViewOwner({
      frameDocument: extensionFrameDocument,
      hostAssets: {
        "frame-bridge.js": {
          body: await readFile(
            createRequire(__filename).resolve("@pi-gui/extension-ui/frame-bridge"),
            "utf8",
          ),
          contentType: "text/javascript; charset=utf-8",
        },
      },
      onHostAction: (context) =>
        performExtensionViewHostAction(
          {
            store,
            windows: windowOwner,
            views: extensionViews,
            openExternal: openExternalLink,
            saveComposerDraft: (window) => composerDraftFlusher.flush([window]),
          },
          context,
        ),
      onDiagnostic: (target, source, message) =>
        console.error("[extension-view]", target.sessionId, source, message),
    });
    extensionViewOwner = extensionViews;
    protocol.handle(DESKTOP_EXTENSION_SCHEME, (request) =>
      extensionViews.assetResponse(request.url),
    );
    const driverOptions: NonNullable<
      ConstructorParameters<typeof DesktopAppStore>[0]["driverOptions"]
    > = {
      onTurnCaptureBoundary: (boundary, signal) => checkpoints.recordBoundary(boundary, signal),
      // The store bounds each capture from when it starts; this only stops a stuck boundary,
      // including one waiting behind another run's capture in the same checkout.
      turnCaptureTimeoutMs: TURN_CAPTURE_BACKSTOP_MS,
      desktopExtensions: {
        onChanged: (runtime) => extensionViews.replaceRuntime(runtime),
        onInvalidated: ({ target, generation }) =>
          extensionViews.invalidateRuntime(target, generation),
      },
      openUrl: openMcpSignInUrl,
      builtinExtensions: [
        {
          name: "pi-gui-thread-orchestration",
          displayName: "Thread orchestration",
          description: "Lets pi start, read and message other pi-gui threads",
          factory: createOrchestrationRuntimeExtension(orchestrationRuntimeBridge),
        },
        {
          name: "pi-gui-generative-ui",
          displayName: "Interactive cards",
          description:
            "Lets pi show checklists, tables and diagrams, and ask with clickable options",
          factory: createGenerativeUiRuntimeExtension({
            questions: () => store.generativeUiQuestions,
            sessionRef: sessionRefFromExtensionContext,
          }),
        },
        {
          name: "pi-gui-scheduled-tasks",
          displayName: "Scheduled tasks",
          description: "Lets pi create and update local pi-gui scheduled tasks",
          factory: createScheduledTaskRuntimeExtension(scheduledTaskRuntimeBridge, (ctx) => {
            try {
              return sessionRefFromExtensionContext(ctx).workspaceId;
            } catch {
              return undefined;
            }
          }),
        },
      ],
    };
    store = new DesktopAppStore({
      userDataDir: configuredUserDataDir,
      initialWorkspacePaths: resolveInitialWorkspacePaths(),
      getWindow: () => mainWindow,
      shouldKeepSessionDialogs: (sessionRef) =>
        windowOwner?.isSessionVisibleInAnotherWindow(sessionRef) ?? false,
      driverOptions,
      // With model titles switched off, the first sentence of the prompt still names the chat.
      generateThreadTitleOverride: async (workspace, options) =>
        process.env.PI_APP_GENERATE_THREAD_TITLES === "0"
          ? promptTitle(options.prompt)
          : generateThreadTitleOverride?.(workspace, options),
      // A turn stopped by the Claude limit continues once an account resets (see limit-resume.ts).
      ...(remoteDesktopClientMode || process.env.PI_APP_TEST_MODE
        ? {}
        : {
            limitResumeAt: async () => {
              const [states, limits] = await Promise.all([
                readAccountStates(),
                readAccountLimits(path.join(path.dirname(resolveAgentDir()), "claude")).catch(
                  () => [],
                ),
              ]);
              return limitResumeAt(states, limits, Date.now());
            },
          }),
    });
    windowOwner = new WindowOwner(store, {
      onActiveWindowChanged: (window) => {
        mainWindow = window;
        notificationManager?.trackWindow(window);
        notificationPermissionService?.trackWindow(window);
      },
    });
    watchRendererStalls(path.join(configuredUserDataDir, "logs"), windowOwner);
    traceStartup("store initialization started");
    if (!remoteDesktopClientMode) {
      await store.initialize();
      traceStartup("store initialized");
    } else {
      traceStartup("remote client skipped local store initialization");
    }
    if (!remoteDesktopClientMode && process.platform === "win32") {
      const hostConfigPath = process.env.PI_REMOTE_DESKTOP_HOST_CONFIG?.trim();
      if (hostConfigPath) {
        remoteDesktopHostConfig = await readPrivateRemoteDesktopConfig(
          hostConfigPath,
          process.platform,
          parseRemoteDesktopHostConfig,
        );
      }
      if (remoteDesktopHostConfig?.macFolders) {
        const macFolderAdapterStarted = performance.now();
        macWorkspaceFolderAdapter = await loadMacWorkspaceFolderAdapter(
          remoteDesktopHostConfig.macFolders,
        );
        traceStartupDuration("Mac folder adapter", macFolderAdapterStarted);
        macProjectsPath = path.join(
          path.dirname(path.resolve(remoteDesktopHostConfig.macFolders.configPath)),
          "workspaces",
          "mac",
        );
      }

      const createRootIds = new Set(
        remoteDesktopHostConfig?.clients.flatMap((client) => client.folderRootWorkspaceIds ?? []) ??
          [],
      );
      const allWorkspaceIds = new Set(store.getWorkspaceRecords().map((record) => record.id));
      const localFolderService: WorkspaceFolderService = createWorkspaceFolderService({
        windowsRoots: createWindowsWorkspaceFolderRoots(
          store,
          new Set([...allWorkspaceIds, ...createRootIds]),
          createRootIds,
        ),
        ...(macWorkspaceFolderAdapter ? { mac: macWorkspaceFolderAdapter, macProjectsPath } : {}),
        addWorkspacePath: (workspacePath) => store.addWorkspace(workspacePath),
      });
      registerWorkspaceFolderIpc(windowOwner, localFolderService.adapters);
    }
    const automationManifest = process.env.PI_APP_AUTOMATION_MANIFEST;
    const automationDescriptor = process.env.PI_APP_AUTOMATION_DESCRIPTOR;
    if (automationManifest && automationDescriptor) {
      if (!path.isAbsolute(automationManifest) || !path.isAbsolute(automationDescriptor)) {
        throw new Error("Automation setup paths must be absolute.");
      }
      automationIngress = await startAutomationIngress({
        userDataDir: configuredUserDataDir,
        config: {
          loadRoutes: async () => {
            const parsed: unknown = JSON.parse(await readFile(automationManifest, "utf8"));
            if (!parsed || typeof parsed !== "object" || !("routes" in parsed)) {
              throw new Error("Automation routes are unavailable.");
            }
            const routes = parsed.routes;
            if (!routes || typeof routes !== "object" || Array.isArray(routes)) {
              throw new Error("Automation routes are invalid.");
            }
            const result: Record<string, AutomationRoute> = {};
            for (const [routeId, value] of Object.entries(routes as Record<string, unknown>)) {
              if (
                !/^\d+\/\d+$/.test(routeId) ||
                !value ||
                typeof value !== "object" ||
                !("workspacePath" in value) ||
                typeof value.workspacePath !== "string" ||
                !path.isAbsolute(value.workspacePath)
              ) {
                throw new Error("Automation route binding is invalid.");
              }
              result[routeId] = {
                workspacePath: value.workspacePath,
                title:
                  "title" in value && typeof value.title === "string" ? value.title : undefined,
                allowThreads: "allowThreads" in value && value.allowThreads === true,
              };
            }
            return result;
          },
        },
        store: {
          getState: () => store.getState(),
          createSession: async (input) => {
            const created = await store.createSession(input);
            if (created.selectedWorkspaceId !== input.workspaceId || !created.selectedSessionId) {
              throw new Error("Native thread creation did not return its reference.");
            }
            return { workspaceId: input.workspaceId, sessionId: created.selectedSessionId };
          },
          ensureSessionReady: (ref) => store.ensureSessionReady(ref),
          submitComposer: (ref, text) => store.submitComposer(ref, text),
          cancelCurrentRun: (ref) => store.cancelCurrentRun(ref),
          subscribeToSessionEvents: (listener) => store.subscribeToSessionEvents(listener),
        },
      });
      await writeFile(
        automationDescriptor,
        JSON.stringify({
          origin: automationIngress.origin,
          token: automationIngress.token,
        }),
        { mode: 0o600 },
      );
    }
    themeManager.setMode(
      remoteDesktopClientMode
        ? remoteDesktopClientPreferences.themeMode
        : store.snapshot().themeMode,
    );
    integratedTerminalShell = (await store.getState()).integratedTerminalShell;
    nativeTheme.on("updated", refreshWindowBackgrounds);
    let windowBackgroundPresetId = store.snapshot().themePresetId;
    let preparedCheckoutId: string | undefined;
    stopPruningTerminals = store.subscribe((state) => {
      integratedTerminalShell = state.integratedTerminalShell;
      if (state.selectedWorkspaceId !== preparedCheckoutId) {
        preparedCheckoutId = state.selectedWorkspaceId;
        const selectedPath = store.getWorkspacePath(preparedCheckoutId);
        if (selectedPath) checkpoints.prepare(selectedPath);
      }
      if (state.themePresetId !== windowBackgroundPresetId) {
        windowBackgroundPresetId = state.themePresetId;
        refreshWindowBackgrounds();
      }
      const workspacePaths = state.workspaces.map((workspace) => workspace.path);
      const workspacePathSignature = workspacePaths.join("\0");
      if (workspacePathSignature !== retainedTerminalWorkspacePathSignature) {
        retainedTerminalWorkspacePathSignature = workspacePathSignature;
        terminalService?.retainWorkspacePaths(workspacePaths);
      }
    });
    installApplicationMenu();
    if (process.env.PI_APP_TEST_MODE) {
      Object.assign(globalThis, {
        __PI_APP_TEST_HOOKS: {
          emitSessionEvent: (event: SessionDriverEvent) => store.emitTestSessionEvent(event),
          handleWindowActivation: () => {
            if (mainWindow) {
              windowOwner.activate(mainWindow);
            }
          },
          promptForText: (message: string, placeholder?: string, allowEmpty?: boolean) =>
            promptForText(mainWindow, message, placeholder ?? "", allowEmpty ?? false),
          runOrchestrationRuntimeTool: (input: OrchestrationRuntimeToolTestInput) =>
            runOrchestrationRuntimeToolForTest(orchestrationRuntimeBridge, input),
          // Windows get child threads without goal, transcript and evidence (see forWindow).
          orchestrationChildren: () => store.snapshot().orchestrationChildren,
          runScheduledTaskRuntimeTool: (input: ScheduledTaskRuntimeToolTestInput) =>
            runScheduledTaskRuntimeToolForTest(scheduledTaskRuntimeBridge, input),
          fireDueScheduledTasks: (nowIso?: string) =>
            store.fireDueScheduledTasks(nowIso ? new Date(nowIso) : undefined),
          setDeferredThreadTitleMode: () => {
            generateThreadTitleOverride = () =>
              new Promise<string | null>((resolve, reject) => {
                deferredThreadTitle = { resolve, reject };
              });
          },
          hasDeferredThreadTitle: () => Boolean(deferredThreadTitle),
          resolveDeferredThreadTitle: (title: string) => {
            if (!deferredThreadTitle) {
              throw new Error("Deferred thread-title request is unavailable");
            }
            const pending = deferredThreadTitle;
            deferredThreadTitle = undefined;
            pending.resolve(title);
          },
          rejectDeferredThreadTitle: () => {
            if (!deferredThreadTitle) {
              throw new Error("Deferred thread-title request is unavailable");
            }
            const pending = deferredThreadTitle;
            deferredThreadTitle = undefined;
            pending.reject(new Error("Deferred thread-title rejected by test"));
          },
        },
      });
    }
    registerUpdateIpc(windowOwner, createAppUpdater());
    notificationPermissionService = new NotificationPermissionService(() => mainWindow);
    notificationPermissionService.subscribe((status) => {
      for (const window of windowOwner.allWindows()) {
        if (canPublishToWindow(window)) {
          window.webContents.send(desktopIpc.notificationPermissionStatusChanged, status);
        }
      }
    });
    // A remote client runs no sessions: its notifications come from the host's snapshots, and
    // clicking one opens the chat on the host.
    remoteNotifications = remoteDesktopClient
      ? createRemoteNotificationStore({
          selectSession: async (target) => {
            const state = (await remoteDesktopClient!.invoke("selectSession", [
              target,
            ])) as DesktopAppState;
            const shown = { ...state, ...remoteDesktopClientPreferences };
            for (const window of windowOwner.allWindows()) {
              if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
                window.webContents.send(remoteClientIpc.stateChanged, shown);
              }
            }
            return shown;
          },
        })
      : undefined;
    notificationManager = new NotificationManager(
      remoteNotifications ?? store,
      () => mainWindow,
      notificationPermissionService,
      remoteNotifications
        ? undefined
        : async (sessionRef) => {
            const window = windowOwner.foreground();
            await runWindowScopedForWindow(window, () => store.selectSession(sessionRef), {
              forceActiveWindow: true,
            });
          },
    );
    stopNotifications = notificationManager.start();
    if (!isDev) {
      stopUpdateChecker = createAppUpdater().start();
    }
    if (!remoteDesktopClientMode && !isDev && !process.env.PI_APP_TEST_MODE) {
      const piState = path.dirname(resolveAgentDir());
      // Every provider's sign-in, hourly; one notification when one stops working or is about to.
      signIns = startSignInMonitor(
        {
          stateDir: piState,
          memoryFile: path.join(app.getPath("userData"), "sign-in-notices.json"),
          claudeCommand: process.env.PI_CLAUDE_CODE_COMMAND,
        },
        (problem) => {
          if (!Notification.isSupported()) return;
          const notice = new Notification({
            title:
              problem.state === "expiring"
                ? `${problem.name}: sign-in ends soon`
                : `${problem.name}: signed out`,
            body: problem.fix ?? "Sign in again to keep using it in Pi.",
          });
          notice.on("click", () => {
            showAppWindow();
            void store.setActiveView("usage").catch(() => undefined);
          });
          notice.show();
        },
      );
      // Plan limits hourly too, so "Limited until …" shows everywhere without the Usage page open.
      const refreshLimits = () =>
        void readAccountLimits(path.join(piState, "claude")).catch(() => undefined);
      const firstLimits = setTimeout(refreshLimits, 25_000);
      const hourlyLimits = setInterval(refreshLimits, 60 * 60_000);
      stopLimitRefresh = () => {
        clearTimeout(firstLimits);
        clearInterval(hourlyLimits);
      };
    }

    registerDesktopIpc({
      windows: windowOwner,
      owners: {
        state: store,
        workbench: store,
        extensionViews,
        review: new ReviewOwner({
          checkpoints,
          userDataDir: app.getPath("userData"),
          resolveCheckoutPath: (checkoutId) => store.getWorkspacePath(checkoutId),
          sendInstruction: (target, text) => store.deliverRemoteInstruction(target, text),
          draftText: (target, system, prompt, signal) =>
            store.generateSessionText(target, system, prompt, signal),
          // shortcut: only file tools' paths count, not files a shell command changed; add shell cwd if that misses repos.
          touchedRepositories: (target, checkoutPath) =>
            findTouchedRepositories(taskTreeTouchedFiles(store.snapshot(), target), checkoutPath),
          validateTask: (target) =>
            store
              .snapshot()
              .workspaces.some(
                (workspace) =>
                  workspace.id === target.workspaceId &&
                  workspace.sessions.some((session) => session.id === target.sessionId),
              ),
        }),
        workspace: store,
        conversation: store,
        orchestration: store,
        scheduledTasks: store,
        settings: store,
        composerDraftFlush: composerDraftFlusher,
      },
      capabilities: {
        ping: () =>
          devReloadMarkersEnabled
            ? `pi desktop ready:${MAIN_DEV_RELOAD_MARKER}`
            : "pi desktop ready",
        theme: themeManager,
        openExternal: openExternalLink,
        pickWorkspace: (window, createNew) => pickWorkspaceViaDialog(window, createNew),
        createLoginCallbacks: (window) => createRuntimeLoginCallbacks(window),
        probeCustomProviderModels,
        notificationPermission: () => notificationPermissionService,
        terminal: getTerminalService,
        optionalTerminal: () => terminalService,
        setTerminalFocused: (webContentsId, focused) => {
          if (focused) {
            terminalFocusedWebContentsIds.add(webContentsId);
          } else {
            terminalFocusedWebContentsIds.delete(webContentsId);
          }
        },
        setSidePanelFocused: (webContentsId, focused) => {
          if (focused) {
            sidePanelFocusedWebContentsIds.add(webContentsId);
          } else {
            sidePanelFocusedWebContentsIds.delete(webContentsId);
          }
        },
        setTransparency: (enabled) => {
          if (process.platform !== "darwin" && process.platform !== "win32") {
            return;
          }
          for (const window of windowOwner.allWindows()) {
            if (!window.isDestroyed()) {
              setWindowTransparency(window, enabled);
            }
          }
        },
        pickComposerAttachments: async (window, existing = []) => {
          const parent = resolveDialogWindow(window);
          const result = parent
            ? await dialog.showOpenDialog(parent, {
                properties: ["openFile", "multiSelections"],
                title: "Attach files",
              })
            : await dialog.showOpenDialog({
                properties: ["openFile", "multiSelections"],
                title: "Attach files",
              });
          if (result.canceled || result.filePaths.length === 0) {
            return undefined;
          }
          return readComposerAttachmentsFromPaths(result.filePaths, existing);
        },
        readClipboardImage: readClipboardImageAttachment,
        validateComposerAttachments: (attachments) =>
          attachments.flatMap(validateComposerAttachmentPayload),
        listWorkspaceFiles,
        readWorkspaceFile,
        getUsageReport: () => collectUsage(),
        getAccountStates: () => readAccountStates(),
        getAccountLimits: (cachedOnly) =>
          readAccountLimits(path.join(path.dirname(resolveAgentDir()), "claude"), { cachedOnly }),
        getClaudeSlots: () => readClaudeSlots(path.join(path.dirname(resolveAgentDir()), "claude")),
        getSignIns: () => signIns?.current() ?? [],
        revealWorkspaceFile: async (workspacePath, filePath) => {
          const resolved = await resolveExistingWorkspacePath(workspacePath, filePath);
          shell.showItemInFolder(resolved);
        },
        getChangedFiles,
        getFileDiff,
        stageFile,
        relaunchApplication: requestApplicationRelaunch,
      },
    });

    if (remoteDesktopClient) {
      const handleMainFrame = mainFrameHandler(windowOwner);
      handleMainFrame(
        remoteClientIpc.invoke,
        remoteClientInvocationFromIpc,
        async ({ method, args }) => {
          const result = await remoteDesktopClient!.invoke(method, args);
          return isDesktopAppState(result)
            ? { ...result, ...remoteDesktopClientPreferences }
            : result;
        },
      );
      handleMainFrame(
        remoteClientIpc.getLocalPreferences,
        () => undefined,
        () => remoteDesktopClientPreferences,
      );
      handleMainFrame(
        remoteClientIpc.setLocalPreferences,
        validateRemoteDesktopClientPreferencesPatch,
        async (patch) => {
          const next = { ...remoteDesktopClientPreferences, ...patch };
          await persistRemoteDesktopClientPreferences(configuredUserDataDir, next);
          remoteDesktopClientPreferences = next;
          if (patch.themeMode !== undefined) {
            themeManager.setMode(next.themeMode);
            refreshWindowBackgrounds();
          }
          if (patch.themePresetId !== undefined) refreshWindowBackgrounds();
          if (patch.enableTransparency !== undefined) {
            for (const currentWindow of windowOwner.allWindows()) {
              if (!currentWindow.isDestroyed()) {
                setWindowTransparency(currentWindow, next.enableTransparency);
              }
            }
          }
          return remoteDesktopClientPreferences;
        },
      );
      // A host that restarted may run a new build; the version banner should not wait hours for it.
      remoteDesktopClient.onReady(() => {
        void createAppUpdater()
          .refreshHostVersion()
          .catch((error: unknown) => {
            console.error("[updater] Host version refresh failed", error);
          });
      });
      remoteDesktopClient.subscribe((event: RemoteDesktopEvent) => {
        if (event.type === "stateChanged") {
          remoteNotifications?.publish({ ...event.state, ...remoteDesktopClientPreferences });
        }
        for (const window of windowOwner.allWindows()) {
          if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
          if (event.type === "stateChanged") {
            window.webContents.send(remoteClientIpc.stateChanged, {
              ...event.state,
              ...remoteDesktopClientPreferences,
            });
          } else if (event.type === "selectedTranscriptChanged") {
            window.webContents.send(remoteClientIpc.selectedTranscriptChanged, event.transcript);
          } else {
            window.webContents.send(remoteClientIpc.terminalEvent, event);
          }
        }
      });
      remoteDesktopClient.startEvents();
    }

    if (remoteDesktopHostConfig) {
      const remoteDesktopBrokerStarted = performance.now();
      if (process.platform !== "win32") {
        throw new Error("Remote desktop host mode is supported only on Windows.");
      }
      const hostConfig = remoteDesktopHostConfig;
      const brokers = new Map<string, RemoteDesktopBroker>();
      try {
        for (const client of hostConfig.clients) {
          const folderRootIds = new Set(client.folderRootWorkspaceIds ?? []);
          const visibleRootIds = new Set([...client.workspaceIds, ...folderRootIds]);
          const clientFolderService = createWorkspaceFolderService({
            windowsRoots: createWindowsWorkspaceFolderRoots(store, visibleRootIds, folderRootIds),
            ...(macWorkspaceFolderAdapter
              ? { mac: macWorkspaceFolderAdapter, macProjectsPath }
              : {}),
            addWorkspacePath: (workspacePath) => store.addWorkspace(workspacePath),
          });
          const authorizedWorkspaceIds = new Set(client.workspaceIds);
          const futureWorkspaceRootPaths = new Map<string, string>();
          for (const rootId of folderRootIds) {
            const rootPath = clientFolderService.windowsRootPaths.get(rootId);
            if (!rootPath) throw new Error("A configured Windows folder root is unavailable.");
            futureWorkspaceRootPaths.set(rootId, rootPath);
            const containment = createRemoteWorkspaceFolders(new Map([[rootId, rootPath]]));
            for (const record of store.getWorkspaceRecords()) {
              try {
                if (await containment.contains(rootId, record.path, true)) {
                  authorizedWorkspaceIds.add(record.id);
                }
              } catch {
                // Missing and non-canonical paths are not eligible descendants of a trusted root.
              }
            }
          }
          // Mac projects opened earlier stay available to the Mac after a restart.
          if (macProjectsPath && macWorkspaceFolderAdapter) {
            const macProjects = createRemoteWorkspaceFolders(
              new Map([["macProjects", macProjectsPath]]),
            );
            for (const record of store.getWorkspaceRecords()) {
              try {
                if (await macProjects.contains("macProjects", record.path)) {
                  authorizedWorkspaceIds.add(record.id);
                }
              } catch {
                // A removed stand-in folder is simply no longer a Mac project.
              }
            }
          }
          const pageUrl = process.env.ELECTRON_RENDERER_URL
            ? new URL(
                "remote-broker.html",
                `${process.env.ELECTRON_RENDERER_URL.replace(/\/$/u, "")}/`,
              ).href
            : pathToFileURL(path.join(__dirname, "..", "renderer", "remote-broker.html")).href;
          const broker = await RemoteDesktopBroker.create({
            clientId: client.id,
            workspaceIds: [...authorizedWorkspaceIds],
            workspaceFolders: clientFolderService.adapters,
            windowsFolderRootPaths: clientFolderService.windowsRootPaths,
            futureWorkspaceRootPaths,
            initialWorkspaceId: client.initialWorkspaceId,
            initialSessionId: client.initialSessionId,
            preloadPath: path.join(__dirname, "..", "preload", "remote-broker-preload.js"),
            pageUrl,
            windows: windowOwner,
            sendText: ({ sessionRef, text, deliverAs, attachments = [] }) => {
              assertComposerAttachmentPixels(attachments);
              return store.deliverRemoteInstruction(sessionRef, text, deliverAs, attachments);
            },
            getActiveRuns: () => mapActiveRuns(store.readState()),
          });
          brokers.set(client.id, broker);
          remoteDesktopBrokers.add(broker);
        }
        remoteDesktopHost = await startRemoteDesktopHttpHost({ ...hostConfig, brokers });
      } catch (error) {
        for (const broker of brokers.values()) broker.close();
        remoteDesktopBrokers.clear();
        throw error;
      }
      traceStartupDuration(
        `remote desktop broker setup (${remoteDesktopHostConfig.clients.length} clients)`,
        remoteDesktopBrokerStarted,
      );
    }

    // A launch frame closed during startup means the app is already quitting.
    if (!launchWindow) {
      createAppWindow();
    } else if (!launchWindow.isDestroyed()) {
      createAppWindow(undefined, launchWindow);
    }
    launchWindow = undefined;
    // Agent-driven self-update (platform/self-update.ts): quit when the helper waits, and once this
    // start is up, tell the helper and continue the chat that scheduled the update.
    if (!remoteDesktopClientMode && !appTestMode) {
      const updateDir = selfUpdateDir(configuredUserDataDir);
      watchQuitRequest(updateDir, () => app.quit());
      void (async () => {
        const pending = await consumeResume(updateDir);
        await writeHealthy(updateDir, app.getVersion());
        if (!pending) return;
        const thread = store
          .snapshot()
          .workspaces.flatMap((workspace) =>
            workspace.sessions.map((session) => ({
              workspaceId: workspace.id,
              sessionId: session.id,
            })),
          )
          .find((ref) => ref.sessionId === pending.marker.sessionId);
        if (!thread) return;
        await runWindowScopedForWindow(windowOwner.foreground(), () => store.selectSession(thread));
        await store.submitComposer(
          thread,
          resumeMessage(pending.marker, pending.result, app.getVersion()),
        );
      })().catch((error: unknown) => console.error("[self-update] resume failed", error));
    }
    void notificationPermissionService.getCurrentStatus().catch((error: unknown) => {
      console.error("[main] getCurrentStatus failed", error);
    });
    // Closing the window keeps Pegasus in the tray on Windows; test launches still quit with it.
    if (process.platform === "win32" && appTestMode === undefined) {
      appTray = installAppTray({ icon: appIcon, onOpen: showAppWindow, onQuit: () => app.quit() });
    }

    app.on("activate", () => {
      if ((windowOwner?.size() ?? BrowserWindow.getAllWindows().length) === 0) {
        createAppWindow();
        if (notificationPermissionService) {
          void notificationPermissionService.getCurrentStatus().catch((error: unknown) => {
            console.error("[main] getCurrentStatus failed", error);
          });
        }
      }
    });
  })
  .catch((error: unknown) => {
    console.error("[main] Application startup failed", error);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  // The tray keeps Pegasus running; its Quit item (or a system shutdown) ends it.
  if (appTray) return;
  // macOS normally keeps the app alive after its final window closes. The
  // Electron harness closes windows to end each isolated run, so let explicit
  // test-mode launches quit instead of leaving their process behind forever.
  if (process.platform !== "darwin" || appTestMode !== undefined) {
    stopNotifications?.();
    stopNotifications = undefined;
    notificationManager = undefined;
    notificationPermissionService?.dispose();
    notificationPermissionService = undefined;
    stopUpdateChecker?.();
    stopUpdateChecker = undefined;
    signIns?.stop();
    stopLimitRefresh?.();
    stopPruningTerminals?.();
    stopPruningTerminals = undefined;
    terminalService?.dispose();
    terminalService = undefined;
    app.quit();
  }
});

app.on("before-quit", (event) => {
  stopNotifications?.();
  stopNotifications = undefined;
  notificationManager = undefined;
  notificationPermissionService?.dispose();
  notificationPermissionService = undefined;
  stopUpdateChecker?.();
  stopUpdateChecker = undefined;
  signIns?.stop();
  stopLimitRefresh?.();
  stopPruningTerminals?.();
  stopPruningTerminals = undefined;
  terminalService?.dispose();
  terminalService = undefined;
  remoteDesktopClient?.close();
  if (quitFlush === "done" || !store) {
    return;
  }

  event.preventDefault();
  // A second quit request during the flush waits for the one already running.
  if (quitFlush === "flushing") return;
  quitFlush = "flushing";
  const quittingStore = store;
  const stopRemoteTransport = Promise.all([
    remoteDesktopHost?.close(),
    ...[...remoteDesktopBrokers].map(async (broker) => broker.close()),
  ]).then(() => {
    remoteDesktopHost = undefined;
    remoteDesktopBrokers.clear();
  });
  // Renderers send their debounced drafts first so the store flush below includes them.
  const flush = composerDraftFlusher
    .flush(windowOwner.allWindows())
    .then(async () => {
      await automationIngress?.close();
      await stopRemoteTransport;
      return Promise.all([
        remoteDesktopClientMode ? Promise.resolve() : quittingStore.flushPersistence(),
        extensionViewOwner?.dispose(),
      ]);
    })
    .catch((error: unknown) => {
      console.error("pi-gui: persistence flush failed during quit:", error);
    });
  // Never let a hung flush block quit forever — quit after a bounded wait.
  const flushDeadline = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.warn("pi-gui: persistence flush timed out during quit; quitting anyway.");
      resolve();
    }, QUIT_FLUSH_TIMEOUT_MS);
  });
  void Promise.race([flush, flushDeadline])
    .finally(() => {
      quitFlush = "done";
      app.quit();
    })
    .catch((error: unknown) => {
      console.error("[main] Quit after persistence flush failed", error);
    });
});

function resolveInitialWorkspacePaths(): readonly string[] {
  const raw = process.env.PI_APP_INITIAL_WORKSPACES;
  if (raw !== undefined) {
    return raw
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

async function readComposerAttachmentsFromPaths(
  filePaths: readonly string[],
  existing: readonly ComposerAttachment[] = [],
): Promise<ComposerAttachment[]> {
  const planned = filePaths.map((filePath) => ({
    filePath,
    mimeType: mimeTypeForPath(filePath),
  }));
  const imageSizes = await Promise.all(
    planned
      .filter((entry) => entry.mimeType.startsWith("image/"))
      .map(async (entry) => (await stat(entry.filePath)).size),
  );
  assertComposerImageFileSizes(imageSizes, existing);
  return Promise.all(planned.map((entry) => readComposerAttachment(entry.filePath)));
}

async function readComposerAttachment(filePath: string): Promise<ComposerAttachment> {
  const mimeType = mimeTypeForPath(filePath);
  if (mimeType.startsWith("image/")) {
    return readComposerImageAttachment(filePath, mimeType);
  }

  const stats = await stat(filePath);
  return {
    id: randomUUID(),
    kind: "file",
    name: path.basename(filePath),
    mimeType,
    fsPath: filePath,
    ...(typeof stats.size === "number" ? { sizeBytes: stats.size } : {}),
  };
}

async function readComposerImageAttachment(
  filePath: string,
  mimeType: string,
): Promise<ComposerImageAttachment> {
  const stats = await stat(filePath);
  assertComposerImageBytes(stats.size);
  const buffer = await readFile(filePath);
  assertComposerImageBytes(buffer.length);
  const image = nativeImage.createFromBuffer(buffer);
  if (!image.isEmpty()) {
    const size = image.getSize();
    assertComposerImagePixels(size.width, size.height);
  }
  return {
    id: randomUUID(),
    kind: "image",
    name: path.basename(filePath),
    mimeType,
    data: buffer.toString("base64"),
  };
}

function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const supported = SUPPORTED_IMAGE_TYPES.find((type) => type.extension === extension);
  if (supported) {
    return supported.mimeType;
  }
  return "application/octet-stream";
}

function validateComposerAttachmentPayload(attachment: ComposerAttachment): ComposerAttachment[] {
  if (attachment.kind === "image") {
    if (
      typeof attachment.data !== "string" ||
      typeof attachment.mimeType !== "string" ||
      !SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mimeType)
    ) {
      return [];
    }
    return [
      {
        ...attachment,
        kind: "image",
      },
    ];
  }

  if (
    attachment.kind !== "file" ||
    typeof attachment.fsPath !== "string" ||
    typeof attachment.mimeType !== "string" ||
    typeof attachment.name !== "string"
  ) {
    return [];
  }

  const normalized: ComposerFileAttachment = {
    ...attachment,
    kind: "file",
    fsPath: attachment.fsPath.trim(),
    name: attachment.name.trim() || path.basename(attachment.fsPath),
  };
  if (!normalized.fsPath) {
    return [];
  }
  return [normalized];
}

function createRuntimeLoginCallbacks(window?: BrowserWindow | null) {
  return {
    onAuth: async ({
      url,
      instructions,
    }: {
      readonly url: string;
      readonly instructions?: string;
    }) => {
      await shell.openExternal(url);
      if (instructions?.trim()) {
        await showLoginInstructions(window, instructions.trim());
      }
    },
    onPrompt: async ({
      message,
      placeholder,
      allowEmpty,
    }: {
      readonly message: string;
      readonly placeholder?: string;
      readonly allowEmpty?: boolean;
    }) => promptForText(window, message, placeholder, allowEmpty ?? false),
  };
}

async function showLoginInstructions(
  parentWindow: BrowserWindow | null | undefined,
  message: string,
): Promise<void> {
  const window = resolveDialogWindow(parentWindow);
  if (!window) {
    throw new Error("Main window is not available for login instructions.");
  }
  window.show();
  window.focus();
  await window.webContents.executeJavaScript(`window.alert(${JSON.stringify(message)})`, true);
}

// Electron does not implement window.prompt(), so provider-login text prompts
// are served by a small dedicated modal window instead.
async function promptForText(
  parentWindow: BrowserWindow | null | undefined,
  message: string,
  placeholder = "",
  allowEmpty = false,
): Promise<string> {
  const parent = resolveDialogWindow(parentWindow);
  if (!parent) {
    throw new Error("Main window is not available for login.");
  }
  parent.show();
  parent.focus();

  const modal = new BrowserWindow({
    parent,
    modal: true,
    show: false,
    width: 460,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: process.platform !== "darwin",
    title: "Pegasus",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });

  try {
    await modal.loadURL(promptDataUrl(message, placeholder));
    modal.show();
    modal.focus();

    const result = await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      // Closing the window (title-bar close) counts as a cancel.
      modal.once("closed", () => finish(null));
      // The page wires its own buttons on load and exposes the outcome as a
      // promise; awaiting it here avoids any handler-attachment race.
      modal.webContents
        .executeJavaScript("window.__piPromptResult", true)
        .then((value) => finish(typeof value === "string" ? value : null))
        .catch(() => finish(null));
    });

    if (result === null) {
      throw new Error("Login cancelled.");
    }
    const trimmedResult = result.trim();
    if (!allowEmpty && trimmedResult.length === 0) {
      throw new Error("Login cancelled.");
    }
    return trimmedResult;
  } finally {
    if (!modal.isDestroyed()) {
      modal.destroy();
    }
  }
}

function promptDataUrl(message: string, placeholder: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px 20px; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f4f5f7; color: #1b1d22; display: flex; flex-direction: column; gap: 14px; height: 100vh; }
  @media (prefers-color-scheme: dark) { body { background: #23262d; color: #e7e9ee; } input { background: #171a1f; color: #e7e9ee; border-color: #3a3f4a; } }
  .msg { line-height: 1.4; white-space: pre-wrap; }
  input { width: 100%; padding: 8px 10px; font-size: 13px; border: 1px solid #c3c8d0; border-radius: 6px;
    background: #fff; color: inherit; }
  input:focus { outline: 2px solid #4a8cff; outline-offset: 0; border-color: #4a8cff; }
  .row { margin-top: auto; display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 6px 16px; font-size: 13px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; }
  #pi-prompt-cancel { background: transparent; border-color: #b7bdc7; color: inherit; }
  #pi-prompt-ok { background: #2f6ae0; color: #fff; }
</style></head>
<body>
  <div class="msg">${escapeHtml(message)}</div>
  <input id="pi-prompt-input" type="text" placeholder="${escapeHtml(placeholder)}" autofocus />
  <div class="row">
    <button id="pi-prompt-cancel" type="button">Cancel</button>
    <button id="pi-prompt-ok" type="button">OK</button>
  </div>
  <script>
    (function () {
      var resolveResult;
      window.__piPromptResult = new Promise(function (resolve) { resolveResult = resolve; });
      function wire() {
        var input = document.getElementById('pi-prompt-input');
        var ok = document.getElementById('pi-prompt-ok');
        var cancel = document.getElementById('pi-prompt-cancel');
        if (!input || !ok || !cancel) { resolveResult(null); return; }
        ok.addEventListener('click', function () { resolveResult(input.value); });
        cancel.addEventListener('click', function () { resolveResult(null); });
        input.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') { event.preventDefault(); resolveResult(input.value); }
          else if (event.key === 'Escape') { event.preventDefault(); resolveResult(null); }
        });
        input.focus();
        document.body.dataset.piReady = '1';
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
      } else {
        wire();
      }
    })();
  </script>
</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function probeCustomProviderModels(
  input: CustomProviderProbeInput,
): Promise<CustomProviderProbeResult> {
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl || !isValidHttpBaseUrl(baseUrl)) {
    return { ok: false, error: "Base URL must start with http:// or https://" };
  }
  const target = `${baseUrl.replace(/\/+$/, "")}/models`;
  const apiKey = input.apiKey?.trim();
  try {
    const response = await net.fetch(target, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText} from ${target}` };
    }
    const payload = (await response.json()) as unknown;
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      return { ok: false, error: `Response from ${target} is missing a "data" array` };
    }
    const models = data
      .map((entry) => {
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as { id?: unknown }).id === "string"
        ) {
          return (entry as { id: string }).id;
        }
        return undefined;
      })
      .filter((id): id is string => Boolean(id && id.length > 0));
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: describeProbeError(error, target) };
  }
}

function describeProbeError(error: unknown, target: string): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `Timed out after 5s contacting ${target}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
