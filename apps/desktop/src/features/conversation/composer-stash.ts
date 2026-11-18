import { useCallback, useState } from "react";
import type { ComposerAttachment } from "../../../contracts/desktop-state";

/** A draft parked for later: its text and the attachments it carried. */
export interface StashedDraft {
  readonly id: string;
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly stashedAt: number;
}

export const COMPOSER_STASH_STORAGE_KEY = "pegasus.composerStash.v1";
/** Per chat; the oldest parked draft is dropped beyond this. */
export const MAX_STASHED_DRAFTS = 10;

type StashStore = Record<string, readonly StashedDraft[]>;

function isStashedDraft(value: unknown): value is StashedDraft {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.text === "string" &&
    typeof record.stashedAt === "number" &&
    Array.isArray(record.attachments)
  );
}

function readStore(): StashStore {
  try {
    const raw = localStorage.getItem(COMPOSER_STASH_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const store: StashStore = {};
    for (const [key, list] of Object.entries(parsed)) {
      if (Array.isArray(list)) store[key] = list.filter(isStashedDraft);
    }
    return store;
  } catch {
    return {};
  }
}

/**
 * False when the browser refuses the write (storage full or unavailable).
 * shortcut: images are kept inline as base64, so a few large ones can fill localStorage (~5 MB) and
 * the park is refused with an error; move them to the app's attachment store if that happens often.
 */
function writeStore(store: StashStore): boolean {
  try {
    const entries = Object.entries(store).filter(([, list]) => list.length > 0);
    localStorage.setItem(COMPOSER_STASH_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Drafts parked for one chat, newest first, kept in localStorage per chat. The composer is
 * remounted per chat, so the initial read is the only one needed.
 */
export function useComposerStash(chatKey: string) {
  const [drafts, setDrafts] = useState<readonly StashedDraft[]>(() => readStore()[chatKey] ?? []);

  const stash = useCallback(
    (text: string, attachments: readonly ComposerAttachment[]): boolean => {
      if (!text.trim() && attachments.length === 0) return false;
      const store = readStore();
      const entry: StashedDraft = {
        id: crypto.randomUUID(),
        text,
        attachments,
        stashedAt: Date.now(),
      };
      const next = [entry, ...(store[chatKey] ?? [])].slice(0, MAX_STASHED_DRAFTS);
      if (!writeStore({ ...store, [chatKey]: next })) return false;
      setDrafts(next);
      return true;
    },
    [chatKey],
  );

  const remove = useCallback(
    (id: string) => {
      const store = readStore();
      const next = (store[chatKey] ?? []).filter((entry) => entry.id !== id);
      writeStore({ ...store, [chatKey]: next });
      setDrafts(next);
    },
    [chatKey],
  );

  return { drafts, stash, remove };
}
