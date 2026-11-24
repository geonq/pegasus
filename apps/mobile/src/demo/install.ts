import { Platform, Settings } from "react-native";
import type { WorkspaceRecord } from "../api/types";
import {
  DEMO_URL,
  demoAccountLimits,
  demoGit,
  demoPatch,
  demoReview,
  demoRuntime,
  demoState,
  demoTranscript,
  demoTurns,
  demoUsageReport,
  demoWorkspaces,
} from "./demo-data";

/**
 * Dev-only demo mode, for screenshots on a simulator with no PC: a stand-in PC answers the app's
 * own calls at the network boundary (fetch for /v1/invoke, XMLHttpRequest for /v1/events), so
 * the real provider, client and screens run unchanged. It is compiled in only when the bundle is
 * built with EXPO_PUBLIC_PEGASUS_DEMO=1 (Expo inlines the variable); release builds and published
 * updates never set it, so there it is off. Pair with the launch argument
 * `-PegasusPairingLink <DEMO_PAIRING_LINK>`; `-PegasusDemoScreen Chat|Review|Settings|NewChat|Usage`
 * opens a screen and `-PegasusDemoOverlay menu|sheet|confirm` shows a floating layer on it.
 */
export const DEMO_ENABLED = process.env.EXPO_PUBLIC_PEGASUS_DEMO === "1";

/** What the launch arguments ask the demo to show, or null outside demo mode. */
export function demoLaunch(): { screen?: string; overlay?: string } | null {
  if (!DEMO_ENABLED || Platform.OS !== "ios") return null;
  const screen: unknown = Settings.get("PegasusDemoScreen");
  const overlay: unknown = Settings.get("PegasusDemoOverlay");
  return {
    ...(typeof screen === "string" ? { screen } : {}),
    ...(typeof overlay === "string" ? { overlay } : {}),
  };
}

type Listener = (frame: string) => void;

function installDemo() {
  const now = Date.now();
  let workspaces: WorkspaceRecord[] = demoWorkspaces(now);
  let revision = 1;
  let selected = { workspaceId: "pegasus", sessionId: "phone-design" };
  let announced = false;
  const streams = new Set<Listener>();
  const state = () => demoState(now, workspaces, revision, selected);
  const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
  const publish = () => {
    revision += 1;
    for (const send of streams) send(frame({ type: "stateChanged", state: state() }));
  };
  const editSession = (target: { workspaceId: string; sessionId: string }, edit: object) => {
    workspaces = workspaces.map((workspace) =>
      workspace.id !== target.workspaceId
        ? workspace
        : {
            ...workspace,
            sessions: workspace.sessions.map((session) =>
              session.id === target.sessionId ? { ...session, ...edit } : session,
            ),
          },
    );
    publish();
    return state();
  };

  const invoke = (method: string, args: readonly unknown[]): unknown => {
    const target = args[0] as { workspaceId: string; sessionId: string };
    switch (method) {
      case "getAppVersion":
        return "1.1.2";
      case "getState":
        return state();
      case "selectSession":
        // Like the PC: only a change of selection sends a new transcript.
        if (
          selected.workspaceId === target.workspaceId &&
          selected.sessionId === target.sessionId &&
          announced
        ) {
          return null;
        }
        selected = target;
        announced = true;
        for (const send of streams) {
          send(
            frame({
              type: "selectedTranscriptChanged",
              transcript: demoTranscript(now, target.workspaceId, target.sessionId),
            }),
          );
        }
        return null;
      case "getSelectedTranscript":
        return demoTranscript(now, selected.workspaceId, selected.sessionId);
      case "setSessionPinned":
        return editSession(target, { pinnedAt: args[1] ? new Date().toISOString() : undefined });
      case "archiveSession":
        return editSession(target, { archivedAt: new Date().toISOString() });
      case "unarchiveSession":
        return editSession(target, { archivedAt: undefined });
      case "markSessionRead":
        return editSession(target, { hasUnseenUpdate: false });
      case "loadWorkspaceRuntime":
      case "setDefaultModel":
      case "setDefaultThinkingLevel":
        return { ...state(), runtimeByWorkspace: { [String(args[0])]: demoRuntime() } };
      case "getAccountLimits":
        return demoAccountLimits(now);
      case "getUsageReport":
        return demoUsageReport(now);
      case "getClaudeSlots":
        return [
          { slot: 1, signedIn: true, name: "georg", plan: "Max" },
          { slot: 2, signedIn: true, name: "work", plan: "Pro" },
        ];
      case "getTurnChanges":
        return demoTurns;
      case "getReview":
        return demoReview((args[0] as { scope: { kind: string } }).scope.kind);
      case "getReviewFile":
        return {
          state: "available",
          reviewId: "r",
          fileId: "f",
          patch: demoPatch,
          coverage: { state: "complete", notes: [] },
        };
      case "getGitActions":
        return demoGit;
      default:
        // Sends, model changes, answers: accepted, with no visible effect in the demo.
        return null;
    }
  };

  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(DEMO_URL)) return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; args?: unknown[] };
    const result = invoke(body.method, body.args ?? []);
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const RealXhr = globalThis.XMLHttpRequest;
  class DemoEventStream {
    status = 0;
    responseText = "";
    onprogress: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    onload: (() => void) | null = null;
    private listener: Listener | null = null;
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 200;
      const push: Listener = (chunk) => {
        this.responseText += chunk;
        this.onprogress?.();
      };
      this.listener = push;
      streams.add(push);
      setTimeout(() => {
        push("event: ready\ndata: {}\n\n");
        push(frame({ type: "stateChanged", state: state() }));
        push(
          frame({
            type: "selectedTranscriptChanged",
            transcript: demoTranscript(now, selected.workspaceId, selected.sessionId),
          }),
        );
      }, 120);
    }
    abort() {
      if (this.listener) streams.delete(this.listener);
      this.listener = null;
      this.onabort?.();
    }
  }
  const DemoXhr = function (this: unknown) {
    const real = new RealXhr();
    let demo: DemoEventStream | null = null;
    return new Proxy(real, {
      get(target, key) {
        if (key === "open") {
          return (method: string, url: string, ...rest: unknown[]) => {
            if (url.startsWith(DEMO_URL)) {
              demo = new DemoEventStream();
              return undefined;
            }
            return (target.open as (...a: unknown[]) => void)(method, url, ...rest);
          };
        }
        const source = (demo ?? target) as unknown as Record<PropertyKey, unknown>;
        const value = source[key];
        return typeof value === "function" ? (value as () => void).bind(source) : value;
      },
      set(target, key, value) {
        ((demo ?? target) as unknown as Record<PropertyKey, unknown>)[key] = value;
        return true;
      },
    });
  } as unknown as typeof XMLHttpRequest;
  globalThis.XMLHttpRequest = DemoXhr;
}

if (DEMO_ENABLED) installDemo();
