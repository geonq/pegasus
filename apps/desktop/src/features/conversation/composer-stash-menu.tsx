import { useEffect, useRef, useState } from "react";
import type { ComposerAttachment } from "../../../contracts/desktop-state";
import { formatRelativeTime } from "../../lib/string-utils";
import { ArchiveIcon, CloseIcon } from "../../ui/icons";
import { useComposerStash, type StashedDraft } from "./composer-stash";

const SNIPPET_MAX_CHARS = 90;

function draftSnippet(draft: StashedDraft): string {
  const text = draft.text.trim().replace(/\s+/g, " ");
  if (text) return text.length <= SNIPPET_MAX_CHARS ? text : `${text.slice(0, SNIPPET_MAX_CHARS)}…`;
  const count = draft.attachments.length;
  return `${count} attachment${count === 1 ? "" : "s"}`;
}

interface ComposerStashMenuProps {
  readonly chatKey: string;
  readonly draft: string;
  readonly attachments: readonly ComposerAttachment[];
  /** Empties the composer after its draft was parked. */
  readonly onParked: () => void;
  /** Puts a parked draft back; rejects (and keeps it parked) when its attachments are refused. */
  readonly onRestore: (draft: StashedDraft) => Promise<void>;
  readonly onError: (message: string) => void;
}

/** Parks the composer draft per chat and brings parked drafts back. */
export function ComposerStashMenu({
  chatKey,
  draft,
  attachments,
  onParked,
  onRestore,
  onError,
}: ComposerStashMenuProps) {
  const { drafts, stash, remove } = useComposerStash(chatKey);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const canPark = draft.trim().length > 0 || attachments.length > 0;

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const park = () => {
    if (!stash(draft, attachments)) {
      onError("This draft could not be parked: browser storage is full or unavailable.");
      return;
    }
    onParked();
    setOpen(false);
  };

  const restore = (entry: StashedDraft) => {
    onRestore(entry)
      .then(() => {
        remove(entry.id);
        setOpen(false);
      })
      .catch(() => undefined);
  };

  return (
    <span className="model-selector composer-stash" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={drafts.length ? `Parked drafts: ${drafts.length}` : "Parked drafts"}
        className="icon-button composer__attach composer-stash__trigger"
        data-testid="composer-stash-trigger"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <ArchiveIcon />
        {drafts.length ? (
          <span aria-hidden="true" className="composer-stash__count">
            {drafts.length}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="model-selector__dropdown composer-stash__menu"
          data-testid="composer-stash-menu"
          onWheel={(event) => event.stopPropagation()}
        >
          <button
            className="model-selector__item composer-stash__park"
            disabled={!canPark}
            type="button"
            onClick={park}
          >
            <ArchiveIcon />
            <span className="model-selector__item-label">Park current draft</span>
          </button>
          <div className="model-selector__group-title">Parked drafts</div>
          {drafts.length === 0 ? (
            <p className="model-selector__empty">
              Nothing parked yet. Park a draft to set it aside and come back to it later.
            </p>
          ) : (
            <ul aria-label="Parked drafts" className="composer-stash__list">
              {drafts.map((entry) => (
                <li className="composer-stash__row" key={entry.id}>
                  <button
                    aria-label={`Restore parked draft: ${draftSnippet(entry)}`}
                    className="model-selector__item model-selector__item--stacked"
                    type="button"
                    onClick={() => restore(entry)}
                  >
                    <span className="model-selector__item-label">{draftSnippet(entry)}</span>
                    <span className="model-selector__item-meta">
                      {formatRelativeTime(new Date(entry.stashedAt).toISOString())}
                      {entry.text.trim() && entry.attachments.length
                        ? ` · ${entry.attachments.length} attachment${entry.attachments.length === 1 ? "" : "s"}`
                        : ""}
                    </span>
                  </button>
                  <button
                    aria-label="Delete parked draft"
                    className="icon-button composer-stash__delete"
                    type="button"
                    onClick={() => remove(entry.id)}
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </span>
  );
}
