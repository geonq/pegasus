import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import {
  caretAllowsHistory,
  idleNavigation,
  loadPromptHistory,
  recordPrompt,
  savePromptHistory,
  stepPromptHistory,
  type PromptHistoryNavigation,
} from "../prompt-history";

// One history for every composer in this window; it is re-read so other windows' prompts appear.
let sharedHistory: readonly string[] | undefined;
const history = () => (sharedHistory ??= loadPromptHistory());

/**
 * ArrowUp/ArrowDown recall of sent prompts for one composer textarea. With `chatPrompts` (an open
 * chat's own prompts, newest first) only that chat's prompts are recalled, on any machine; without
 * it (the new-thread composer) the window-wide history is used.
 */
export function usePromptHistory(chatPrompts?: readonly string[], chatKey?: string) {
  const navigation = useRef<PromptHistoryNavigation>(idleNavigation);
  const chatPromptsRef = useRef(chatPrompts);
  chatPromptsRef.current = chatPrompts;

  // Switching chats starts from that chat's live draft, not mid-way through another chat's prompts.
  useEffect(() => {
    navigation.current = idleNavigation;
  }, [chatKey]);

  const recordSentPrompt = useCallback((prompt: string) => {
    sharedHistory = recordPrompt(loadPromptHistory(), prompt);
    savePromptHistory(sharedHistory);
    navigation.current = idleNavigation;
  }, []);

  /** Handles the key when it moves through history; returns true when it did. */
  const handlePromptHistoryKeyDown = useCallback(
    (
      event: KeyboardEvent<HTMLTextAreaElement>,
      draft: string,
      setDraft: (draft: string) => void,
    ): boolean => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
      if (event.nativeEvent.isComposing) return false;
      const direction = event.key === "ArrowUp" ? "older" : "newer";
      const textarea = event.currentTarget;
      if (!caretAllowsHistory(draft, textarea.selectionStart, textarea.selectionEnd, direction)) {
        return false;
      }
      const own = chatPromptsRef.current;
      if (!own && direction === "older") sharedHistory = loadPromptHistory();
      const step = stepPromptHistory(own ?? history(), navigation.current, draft, direction);
      if (!step) return false;
      event.preventDefault();
      navigation.current = step.navigation;
      setDraft(step.draft);
      // The caret goes to the end, so ArrowUp walks through a long prompt before the next one.
      requestAnimationFrame(() => {
        textarea.setSelectionRange(step.draft.length, step.draft.length);
      });
      return true;
    },
    [],
  );

  return { recordSentPrompt, handlePromptHistoryKeyDown };
}
