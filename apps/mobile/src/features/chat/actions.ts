import { useMemo } from "react";
import { PegasusClient, PegasusError } from "../../api/client";
import { usePegasus } from "../../state/PegasusProvider";
import type { ImageAttachment, SessionPermission, UiAnswer } from "./wire";

/**
 * Chat calls the provider does not wrap, each one a method of the PC's remote API
 * (apps/desktop/electron/remote/remote-desktop-policy.ts validates the same arguments).
 * The new state arrives over the event stream; nothing here is applied optimistically.
 */
export interface ChatActions {
  /**
   * Sends to the chat open in this phone's view: `followUp` waits for a running turn to end (the PC
   * queues it), `steer` reaches the running turn now. Photos travel as base64 bytes.
   */
  readonly send: (
    text: string,
    mode: "followUp" | "steer",
    images: readonly ImageAttachment[],
  ) => Promise<void>;
  readonly setModel: (provider: string, modelId: string) => Promise<void>;
  readonly setThinking: (level: string) => Promise<void>;
  readonly setPermission: (permission: SessionPermission) => Promise<void>;
  readonly setPinned: (pinned: boolean) => Promise<void>;
  readonly archive: () => Promise<void>;
  readonly unarchive: () => Promise<void>;
  readonly answerQuestion: (callId: string, answer: UiAnswer) => Promise<void>;
  /** Asks the PC to load the project's models; they arrive with the next state. */
  readonly loadRuntime: () => Promise<void>;
}

export function useChatActions(workspaceId: string, sessionId: string): ChatActions {
  const { pairing } = usePegasus();
  return useMemo(() => {
    const call = async (method: string, ...args: readonly unknown[]) => {
      if (!pairing) throw new PegasusError("This phone is not paired.", "unpaired");
      await new PegasusClient(pairing).invoke(method, ...args);
    };
    const target = { workspaceId, sessionId };
    return {
      send: (text, mode, images) => {
        const options = {
          ...(mode === "steer" ? { deliverAs: "steer" } : {}),
          ...(images.length > 0 ? { attachments: images } : {}),
        };
        return Object.keys(options).length > 0
          ? call("sendText", text, options)
          : call("sendText", text);
      },
      setModel: (provider, modelId) =>
        call("setSessionModel", workspaceId, sessionId, provider, modelId),
      setThinking: (level) => call("setSessionThinkingLevel", workspaceId, sessionId, level),
      setPermission: (permission) =>
        call("setSessionPermission", workspaceId, sessionId, permission),
      setPinned: (pinned) => call("setSessionPinned", target, pinned),
      archive: () => call("archiveSession", target),
      unarchive: () => call("unarchiveSession", target),
      answerQuestion: (callId, answer) =>
        call("answerGenerativeUi", workspaceId, sessionId, callId, answer),
      loadRuntime: () => call("loadWorkspaceRuntime", workspaceId),
    };
  }, [pairing, workspaceId, sessionId]);
}

export function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
