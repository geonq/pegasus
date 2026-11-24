import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Linking, Platform, Settings } from "react-native";
import {
  newSendId,
  PegasusClient,
  PegasusError,
  type EventStream,
  type StreamStatus,
} from "../api/client";
import { gateStatus } from "../api/stream-status";
import { initialLiveState, reduceLive, type LiveInput, type LiveState } from "../api/live-state";
import { parsePairingLink } from "../api/pairing";
import { TranscriptCache } from "../api/transcript-cache";
import type {
  AccountLimits,
  DesktopAppState,
  Pairing,
  PendingDialogAnswer,
  SelectedTranscript,
  StartThreadInput,
} from "../api/types";
import { forgetPairing, loadPairing, savePairing } from "../storage/pairing-store";

export interface ChatTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
}

interface PegasusContextValue {
  /** undefined while the Keychain is read; null when this phone is not paired. */
  readonly pairing: Pairing | null | undefined;
  /** Why the last pegasus://pair link could not pair this phone. */
  readonly linkError: string | null;
  readonly status: StreamStatus;
  readonly state: DesktopAppState | null;
  readonly transcript: SelectedTranscript | null;
  /** The last transcript seen for a chat this session, drawn while the live one loads. */
  readonly cachedTranscript: (target: ChatTarget) => SelectedTranscript | undefined;
  readonly pair: (pairing: Pairing) => Promise<void>;
  readonly forget: () => Promise<void>;
  /** Pulls the whole state now (pull to refresh) and reconnects a stream that is waiting to retry. */
  readonly refresh: () => Promise<void>;
  /** Opens the chat in this phone's own view on the PC; the transcript then streams in. */
  readonly openChat: (target: ChatTarget) => Promise<void>;
  /**
   * Sends to the chat open in this phone's view: `send` queues the text for the run's next turn,
   * `steer` reaches the running turn now.
   */
  readonly send: (text: string, mode: "send" | "steer") => Promise<void>;
  readonly stop: (target: ChatTarget) => Promise<void>;
  /** Answers a pending approval, question or editor in this phone's view of a chat. */
  readonly answer: (target: ChatTarget, answer: PendingDialogAnswer) => Promise<void>;
  readonly removeQueued: (messageId: string) => Promise<void>;
  readonly steerQueued: (messageId: string) => Promise<void>;
  readonly setPinned: (target: ChatTarget, pinned: boolean) => Promise<void>;
  readonly archive: (target: ChatTarget) => Promise<void>;
  readonly unarchive: (target: ChatTarget) => Promise<void>;
  readonly markRead: (target: ChatTarget) => Promise<void>;
  /** Asks the PC to load a project's models; they arrive in `runtimeByWorkspace`. */
  readonly loadRuntime: (workspaceId: string) => Promise<void>;
  /** Starts a chat in this phone's view and returns it (the PC selects the new chat). */
  readonly startThread: (input: StartThreadInput) => Promise<ChatTarget>;
  /** The PC's signed-in accounts and plan windows, for the Usage screen. */
  readonly accountLimits: () => Promise<readonly AccountLimits[]>;
}

const PegasusContext = createContext<PegasusContextValue | null>(null);

export function usePegasus(): PegasusContextValue {
  const value = useContext(PegasusContext);
  if (!value) throw new Error("usePegasus must be inside PegasusProvider");
  return value;
}

function isState(value: unknown): value is DesktopAppState {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { workspaces?: unknown }).workspaces) &&
    typeof (value as { revision?: unknown }).revision === "number"
  );
}

export function PegasusProvider({ children }: { readonly children: ReactNode }) {
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [status, setStatus] = useState<StreamStatus>({ state: "connecting" });
  const [live, setLive] = useState<LiveState>(initialLiveState);
  const liveRef = useRef<LiveState>(initialLiveState);
  const clientRef = useRef<PegasusClient | null>(null);
  const streamRef = useRef<EventStream | null>(null);
  /** Feeds one input through the reducer; set while a client is connected. */
  const feedRef = useRef<(input: LiveInput) => void>(() => undefined);
  const cacheRef = useRef(new TranscriptCache());

  useEffect(() => {
    loadPairing()
      .then(setPairing)
      .catch(() => setPairing(null));
  }, []);

  // pegasus://pair… links (the iPhone Camera app opens them from the PC's QR code) pair an unpaired
  // phone directly. A paired phone ignores them: unpair first, so a stray link cannot repoint it.
  const [linkError, setLinkError] = useState<string | null>(null);
  useEffect(() => {
    if (pairing !== null) return;
    const handle = (url: string | null | undefined) => {
      if (!url?.startsWith("pegasus://pair")) return;
      let next: Pairing;
      try {
        next = parsePairingLink(url);
      } catch (reason) {
        setLinkError(reason instanceof Error ? reason.message : String(reason));
        return;
      }
      new PegasusClient(next)
        .invoke("getAppVersion")
        .then(() => savePairing(next))
        .then(() => setPairing(next))
        .catch((reason: unknown) =>
          setLinkError(reason instanceof Error ? reason.message : String(reason)),
        );
    };
    Linking.getInitialURL()
      .then(handle)
      .catch(() => undefined);
    // `-PegasusPairingLink <link>` at launch (iOS puts launch arguments in user defaults): how a
    // headless simulator test pairs, since opening a link there needs a tap. Only simctl or a
    // debugger can pass launch arguments.
    if (Platform.OS === "ios") {
      const fromLaunch: unknown = Settings.get("PegasusPairingLink");
      if (typeof fromLaunch === "string") handle(fromLaunch);
    }
    const subscription = Linking.addEventListener("url", (event) => handle(event.url));
    return () => subscription.remove();
  }, [pairing]);

  useEffect(() => {
    if (!pairing) {
      clientRef.current = null;
      return;
    }
    const client = new PegasusClient(pairing);
    clientRef.current = client;
    let active = true;
    const feed = (input: LiveInput) => {
      if (!active) return;
      const result = reduceLive(liveRef.current, input);
      liveRef.current = result.live;
      cacheRef.current.remember(result.live.transcript);
      setLive(result.live);
      if (result.pullTranscript) {
        client
          .invoke<SelectedTranscript | null>("getSelectedTranscript")
          .then((transcript) => feed({ kind: "pulledTranscript", transcript }))
          .catch(() => undefined);
      }
    };
    feedRef.current = feed;
    // A reconnect that is live again within a few seconds is not shown (stream-status.ts).
    const gate = gateStatus((next) => {
      if (active) setStatus(next);
    });
    const stream = client.follow(
      (event) => feed({ kind: "event", event }),
      (next) => {
        // `ready` comes before a new stream's first state: that state is a new baseline. A resumed
        // stream continues from the last event, so what the phone holds stays current.
        if (next.state === "live" && !next.resumed) feed({ kind: "streamOpened" });
        gate.push(next);
      },
    );
    streamRef.current = stream;
    // Back from the background: iOS froze the socket, so start a fresh stream (it opens with the
    // whole current state) instead of waiting for the silence watchdog or a backoff timer.
    let appState = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next) => {
      if (appState !== "active" && next === "active") stream.reconnect();
      appState = next;
    });
    return () => {
      active = false;
      subscription.remove();
      gate.stop();
      stream.stop();
      streamRef.current = null;
      feedRef.current = () => undefined;
      cacheRef.current.clear();
      liveRef.current = initialLiveState;
      setLive(initialLiveState);
      setStatus({ state: "connecting" });
    };
  }, [pairing]);

  const client = useCallback((): PegasusClient => {
    const current = clientRef.current;
    if (!current) throw new PegasusError("This phone is not paired.", "unpaired");
    return current;
  }, []);

  /** Runs a call that returns the PC's state after it, and shows that state at once. */
  const act = useCallback(
    async (method: string, ...args: readonly unknown[]): Promise<DesktopAppState | null> => {
      const result = await client().invoke<unknown>(method, ...args);
      if (!isState(result)) return null;
      feedRef.current({ kind: "actionState", state: result });
      return result;
    },
    [client],
  );

  const value = useMemo<PegasusContextValue>(
    () => ({
      pairing,
      linkError,
      status,
      state: live.state,
      transcript: live.transcript,
      cachedTranscript: (target) => cacheRef.current.get(target.workspaceId, target.sessionId),
      pair: async (next) => {
        // Prove the address and key work before keeping them.
        await new PegasusClient(next).invoke("getAppVersion");
        await savePairing(next);
        setPairing(next);
      },
      forget: async () => {
        await forgetPairing();
        setPairing(null);
      },
      refresh: async () => {
        if (status.state !== "live") streamRef.current?.reconnect();
        const state = await client().invoke<unknown>("getState");
        if (isState(state)) feedRef.current({ kind: "pulledState", state });
      },
      openChat: async (target) => {
        await client().invoke("selectSession", target);
      },
      send: async (text, mode) => {
        await client().invokeOnce(
          newSendId(),
          "sendText",
          text,
          ...(mode === "steer" ? [{ deliverAs: "steer" }] : []),
        );
      },
      stop: async (target) => {
        await client().invoke("cancelCurrentRun", target);
      },
      answer: async (target, response) => {
        await client().invoke(
          "respondToHostUiRequest",
          target.workspaceId,
          target.sessionId,
          response,
        );
      },
      removeQueued: async (messageId) => {
        await client().invoke("removeQueuedComposerMessage", messageId);
      },
      steerQueued: async (messageId) => {
        await client().invoke("steerQueuedComposerMessage", messageId);
      },
      setPinned: async (target, pinned) => {
        await act("setSessionPinned", target, pinned);
      },
      archive: async (target) => {
        await act("archiveSession", target);
      },
      unarchive: async (target) => {
        await act("unarchiveSession", target);
      },
      markRead: async (target) => {
        await act("markSessionRead", target);
      },
      loadRuntime: async (workspaceId) => {
        await act("loadWorkspaceRuntime", workspaceId);
      },
      startThread: async (input) => {
        const state = await act("startThread", input);
        // A foreground start selects the new chat in this phone's view (app-store-worktree.ts).
        if (!state?.selectedSessionId) {
          throw new PegasusError("The PC started the chat but did not open it.", "no_session");
        }
        return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
      },
      accountLimits: async () => {
        const limits = await client().invoke<readonly AccountLimits[]>("getAccountLimits");
        return limits;
      },
    }),
    [pairing, linkError, status, live, client, act],
  );

  return <PegasusContext.Provider value={value}>{children}</PegasusContext.Provider>;
}
