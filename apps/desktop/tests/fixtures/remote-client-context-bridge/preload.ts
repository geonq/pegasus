import { contextBridge } from "electron";
import type { RemoteDesktopEvent } from "../../../electron/remote/remote-desktop-protocol";
import { forwardRemoteTranscript } from "../../../electron/remote/remote-transcript-forwarder";
import { transcriptDelta } from "../../../electron/remote/remote-state-delta";
import type { SelectedTranscriptRecord } from "../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { createRemoteDesktopClientApi } from "../../../electron/remote/remote-desktop-client-preload";
import type { RemoteDesktopClientPreferences } from "../../../electron/remote/remote-desktop-client-preferences";

let preferences: RemoteDesktopClientPreferences = {
  enableTransparency: false,
  themeMode: "light",
  themePresetId: "default",
};
const listeners = new Set<(event: RemoteDesktopEvent) => void>();
let streamStarted = false;
const localApi = {
  platform: process.platform,
  versions: process.versions,
  ping: async () => "pong",
  getState: async () => ({}),
  onSelectedTranscriptChanged: () => () => undefined,
  onSessionTranscriptDelta: () => () => undefined,
} as unknown as PiDesktopApi;
const api = createRemoteDesktopClientApi(
  localApi,
  async (method) => {
    if (method === "getState") {
      return { themeMode: "dark", enableTransparency: true, composerDraft: "host draft" };
    }
    return undefined;
  },
  (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  async () => preferences,
  async (patch) => {
    preferences = { ...preferences, ...patch };
    return preferences;
  },
);

contextBridge.exposeInMainWorld("piApp", api);
// A button starts deterministic host-side increments through the production broker/client adapters.
contextBridge.exposeInMainWorld("startTranscriptStream", () => {
  if (streamStarted) return;
  streamStarted = true;
  let full: (record: SelectedTranscriptRecord | null) => void = () => undefined;
  let delta: Parameters<PiDesktopApi["onSessionTranscriptDelta"]>[0] = () => undefined;
  let current: SelectedTranscriptRecord = { workspaceId: "w", sessionId: "s", transcript: [] };
  const emit = (event: RemoteDesktopEvent) => {
    for (const listener of listeners) listener(event);
  };
  let previous: SelectedTranscriptRecord | null = null;
  let sequence = 0;
  forwardRemoteTranscript(
    {
      onSelectedTranscriptChanged: (listener) => {
        full = listener;
        return () => undefined;
      },
      onSessionTranscriptDelta: (listener) => {
        delta = listener;
        return () => undefined;
      },
      getSelectedTranscript: async () => current,
    },
    (record) => {
      const patch = record && previous ? transcriptDelta(previous, record, ++sequence) : null;
      previous = record;
      if (patch) emit({ type: "sessionTranscriptDelta", delta: patch });
      else {
        sequence = 0;
        emit({ type: "selectedTranscriptChanged", transcript: record });
      }
    },
  );
  full(current);
  let step = 0;
  const timer = setInterval(() => {
    const next: SelectedTranscriptRecord = {
      ...current,
      transcript: [
        {
          kind: "activity",
          id: "reply",
          createdAt: "2026-11-13T00:00:00.000Z",
          label: "Streaming" + ".".repeat(++step),
        },
      ],
    };
    delta(transcriptDelta(current, next, step)!);
    current = next;
    if (step === 5) clearInterval(timer);
  }, 40);
});
