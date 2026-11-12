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
import { Linking, Platform, Settings } from "react-native";
import { PegasusClient, PegasusError, type StreamStatus } from "../api/client";
import { parsePairingLink } from "../api/pairing";
import {
  applyTranscriptDelta,
  type DesktopAppState,
  type Pairing,
  type SelectedTranscript,
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
  readonly pair: (pairing: Pairing) => Promise<void>;
  readonly forget: () => Promise<void>;
  /** Opens the chat in this phone's own view on the PC; the transcript then streams in. */
  readonly openChat: (target: ChatTarget) => Promise<void>;
  /** Sends to the chat open in this phone's view; `steer` reaches a running turn. */
  readonly send: (text: string, steer: boolean) => Promise<void>;
  readonly stop: (target: ChatTarget) => Promise<void>;
}

const PegasusContext = createContext<PegasusContextValue | null>(null);

export function usePegasus(): PegasusContextValue {
  const value = useContext(PegasusContext);
  if (!value) throw new Error("usePegasus must be inside PegasusProvider");
  return value;
}

export function PegasusProvider({ children }: { readonly children: ReactNode }) {
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [status, setStatus] = useState<StreamStatus>({ state: "connecting" });
  const [state, setState] = useState<DesktopAppState | null>(null);
  const [transcript, setTranscript] = useState<SelectedTranscript | null>(null);
  const clientRef = useRef<PegasusClient | null>(null);
  const transcriptSequenceRef = useRef(0);

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
    const stop = client.follow((event) => {
      if (event.type === "stateChanged") {
        // Revisions only grow; the host already drops stale snapshots, this keeps a reconnect honest.
        setState((current) =>
          current && current.revision > event.state.revision ? current : event.state,
        );
      } else if (event.type === "selectedTranscriptChanged") {
        transcriptSequenceRef.current = 0;
        setTranscript(event.transcript);
      } else if (event.type === "sessionTranscriptDelta") {
        const delta = event.delta;
        if (delta.sequence !== transcriptSequenceRef.current + 1) {
          void client
            .invoke("getSelectedTranscript")
            .then((value) => setTranscript(value as SelectedTranscript | null));
          transcriptSequenceRef.current = delta.sequence;
          return;
        }
        transcriptSequenceRef.current = delta.sequence;
        setTranscript((current) => applyTranscriptDelta(current, delta));
      }
    }, setStatus);
    return () => {
      stop();
      setState(null);
      setTranscript(null);
    };
  }, [pairing]);

  const client = useCallback((): PegasusClient => {
    const current = clientRef.current;
    if (!current) throw new PegasusError("This phone is not paired.", "unpaired");
    return current;
  }, []);

  const value = useMemo<PegasusContextValue>(
    () => ({
      pairing,
      linkError,
      status,
      state,
      transcript,
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
      openChat: async (target) => {
        await client().invoke("selectSession", target);
      },
      send: async (text, steer) => {
        await client().invoke("sendText", text, ...(steer ? [{ deliverAs: "steer" }] : []));
      },
      stop: async (target) => {
        await client().invoke("cancelCurrentRun", target);
      },
    }),
    [pairing, linkError, status, state, transcript, client],
  );

  return <PegasusContext.Provider value={value}>{children}</PegasusContext.Provider>;
}
