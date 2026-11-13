import { useEffect, useRef } from "react";

// Typing or pasting while focus rests on the transcript (or nowhere) goes to the composer, as in
// T3 Code (composerFocusRedirect.ts, usePasteToFocusComposer.ts). Re-implemented for Pegasus.

const EDITABLE = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  "[role='textbox']",
  // The terminal and editors own their keys even when the event lands on a wrapper.
  ".xterm",
  ".monaco-editor",
].join(",");

const INTERACTIVE = [
  "button",
  "a[href]",
  "summary",
  "[role='button']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
  "[role='slider']",
  "[role='separator']",
].join(",");

// Open layers that read keys themselves: dialogs, menus, and expanded popups such as the model picker.
const OPEN_LAYER = [
  "[aria-modal='true']",
  "[role='menu']",
  "[role='listbox']",
  "[aria-haspopup][aria-expanded='true']",
].join(",");

function pathMatches(event: Event, selector: string): boolean {
  return event
    .composedPath()
    .some((target) => target instanceof Element && target.closest(selector) !== null);
}

// Only keys that land on the page itself or on the chat transcript move. The side panel has its
// own single-letter keys (the review diff's "c" comments a line), so it is never redirected.
function restsOnChat(event: Event): boolean {
  const target = event.target;
  if (target === document.body || target === document.documentElement || target === document)
    return true;
  return target instanceof Element && target.closest(".timeline-surface") !== null;
}

function canRedirect(event: Event): boolean {
  if (event.defaultPrevented || !restsOnChat(event)) return false;
  if (pathMatches(event, EDITABLE) || pathMatches(event, INTERACTIVE)) return false;
  return document.querySelector(OPEN_LAYER) === null;
}

function usableComposer(composer: HTMLTextAreaElement | null): composer is HTMLTextAreaElement {
  return composer !== null && composer.isConnected && !composer.disabled && !composer.readOnly;
}

function focusAtEnd(composer: HTMLTextAreaElement): void {
  composer.focus({ preventScroll: true });
  const end = composer.value.length;
  composer.setSelectionRange(end, end);
}

/**
 * `getComposer` returns the visible composer textarea, or null where there is none. Listeners
 * attach once and read the latest getter through a ref, so this adds no renders.
 */
export function useTypeToFocusComposer(getComposer: () => HTMLTextAreaElement | null): void {
  const getter = useRef(getComposer);
  getter.current = getComposer;

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      // Space keeps scrolling the transcript; only visible characters are typed.
      if (event.key.length !== 1 || event.key === " ") return;
      if (!canRedirect(event)) return;
      const composer = getter.current();
      if (!usableComposer(composer)) return;
      // Focus moves before the key's default action, so the browser types it into the composer.
      focusAtEnd(composer);
    };
    const paste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      // Files and images keep their own paste path.
      if (!data || data.files.length > 0) return;
      const text = data.getData("text/plain");
      if (!text || !canRedirect(event)) return;
      const composer = getter.current();
      if (!usableComposer(composer)) return;
      event.preventDefault();
      focusAtEnd(composer);
      // insertText goes through the textarea's input event (React sees it) and keeps undo.
      document.execCommand("insertText", false, text);
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("paste", paste, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("paste", paste, true);
    };
  }, []);
}
