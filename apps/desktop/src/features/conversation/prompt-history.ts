/**
 * Sent-prompt history for the composer, like a shell: ArrowUp on the first line steps back to older
 * prompts (newest first), ArrowDown on the last line steps forward, and stepping past the newest
 * gives back the draft that was being typed. Stored per machine in localStorage.
 */
export const PROMPT_HISTORY_STORAGE_KEY = "pegasus.promptHistory.v1";
export const PROMPT_HISTORY_LIMIT = 200;

export interface PromptHistoryNavigation {
  /** -1 while editing the live draft; otherwise the index into history (0 = newest). */
  readonly index: number;
  /** The draft typed before navigation started, restored when stepping past the newest. */
  readonly stash: string;
}

export const idleNavigation: PromptHistoryNavigation = { index: -1, stash: "" };

/** Newest first; a repeat of the newest prompt is not stored twice. */
export function recordPrompt(history: readonly string[], prompt: string): readonly string[] {
  const text = prompt.trim();
  if (!text) return history;
  if (history[0] === prompt) return history;
  return [prompt, ...history].slice(0, PROMPT_HISTORY_LIMIT);
}

/**
 * One chat's own prompts, newest first, from its transcript: what ArrowUp recalls in that chat. It comes
 * from the chat itself, so it is the same on every machine showing it (a Mac remote client included).
 */
export function chatPromptHistory(
  transcript: readonly { readonly kind: string; readonly role?: string; readonly text?: string }[],
): readonly string[] {
  let prompts: readonly string[] = [];
  for (const item of transcript) {
    if (item.kind === "message" && item.role === "user" && typeof item.text === "string") {
      prompts = recordPrompt(prompts, item.text);
    }
  }
  return prompts;
}

/** Whether the caret allows leaving the text upwards (first line) or downwards (last line). */
export function caretAllowsHistory(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  direction: "older" | "newer",
): boolean {
  if (selectionStart !== selectionEnd) return false;
  return direction === "older"
    ? !value.slice(0, selectionStart).includes("\n")
    : !value.slice(selectionEnd).includes("\n");
}

/**
 * One step through history. Returns the draft to show and the new navigation, or null when there is
 * nowhere to go (no older prompt, or already on the live draft).
 */
export function stepPromptHistory(
  history: readonly string[],
  navigation: PromptHistoryNavigation,
  draft: string,
  direction: "older" | "newer",
): { readonly draft: string; readonly navigation: PromptHistoryNavigation } | null {
  // A recalled prompt that was edited becomes the new live draft.
  const current =
    navigation.index >= 0 && history[navigation.index] !== draft ? idleNavigation : navigation;
  if (direction === "older") {
    const index = current.index + 1;
    if (index >= history.length) return null;
    return {
      draft: history[index]!,
      navigation: { index, stash: current.index < 0 ? draft : current.stash },
    };
  }
  if (current.index < 0) return null;
  const index = current.index - 1;
  return index < 0
    ? { draft: current.stash, navigation: idleNavigation }
    : { draft: history[index]!, navigation: { index, stash: current.stash } };
}

export function loadPromptHistory(): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PROMPT_HISTORY_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, PROMPT_HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function savePromptHistory(history: readonly string[]): void {
  try {
    localStorage.setItem(PROMPT_HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Storage can be unavailable (private profile); history then lasts for this window only.
  }
}
