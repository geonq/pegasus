import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { GitActionInput, GitActionState } from "../../../contracts/git-actions";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { nextGitStep } from "./review-git-step";

type Api = Pick<PiDesktopApi, "getGitActions" | "draftGitText" | "runGitAction" | "openExternal">;

interface Dialog {
  readonly kind: "commit" | "pr";
  readonly title: string;
  readonly body: string;
  readonly drafting: boolean;
  readonly edited: boolean;
  readonly note: string;
}

const BUSY_LABEL = {
  stage: "Staging…",
  commit: "Committing…",
  push: "Pushing…",
  pr: "Creating PR…",
} as const;

/**
 * One button that follows the repository: Stage all, Commit, Push, then Create PR. Commit and PR
 * open a small form with text the chat's model drafted from the diff; both stay editable.
 */
export function ReviewGitActions({
  api,
  reviewId,
  onChanged,
}: {
  readonly api: Api;
  readonly reviewId: string;
  /** Called after a change so the review reloads. */
  readonly onChanged: () => void;
}) {
  const [state, setState] = useState<GitActionState | null>(null);
  const [busy, setBusy] = useState<keyof typeof BUSY_LABEL | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const draftNonce = useRef(0);
  const titleId = useId();
  const bodyId = useId();

  const loadNonce = useRef(0);
  const loadState = useCallback(() => {
    const nonce = ++loadNonce.current;
    void api.getGitActions({ reviewId }).then(
      (next) => {
        if (loadNonce.current === nonce) setState(next.state === "available" ? next : null);
      },
      () => {
        if (loadNonce.current === nonce) setState(null);
      },
    );
  }, [api, reviewId]);
  useEffect(() => {
    loadState();
    return () => {
      loadNonce.current += 1;
    };
  }, [loadState]);

  const closeDialog = useCallback(() => {
    draftNonce.current += 1;
    setDialog(null);
    button.current?.focus();
  }, []);
  useEffect(() => {
    if (!dialog) return;
    const onPointerDown = (event: PointerEvent) => {
      if (busy === null && event.target instanceof Node && !root.current?.contains(event.target))
        closeDialog();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busy === null) closeDialog();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, closeDialog, dialog]);

  if (!state) return null;
  const step = nextGitStep(state);

  const run = async (input: GitActionInput, label: keyof typeof BUSY_LABEL) => {
    setBusy(label);
    setError(null);
    try {
      const result = await api.runGitAction(input);
      if (result.state === "done" || result.state === "pull-request") {
        if (result.state === "pull-request") await api.openExternal(result.url);
        draftNonce.current += 1;
        setDialog(null);
        loadState();
        onChanged();
        return;
      }
      setError(result.message);
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const openDialog = (kind: "commit" | "pr") => {
    const nonce = ++draftNonce.current;
    setError(null);
    setDialog({ kind, title: "", body: "", drafting: true, edited: false, note: "" });
    void api.draftGitText({ reviewId, kind }).then(
      (draft) => {
        if (draftNonce.current !== nonce) return;
        setDialog((current) => {
          if (!current) return current;
          if (draft.state !== "drafted")
            return { ...current, drafting: false, note: "Could not draft text. Write it here." };
          return {
            ...current,
            drafting: false,
            note: draft.fallback ? "The model was unavailable, so this is a plain summary." : "",
            ...(current.edited ? {} : { title: draft.title, body: draft.body }),
          };
        });
      },
      () => {
        if (draftNonce.current === nonce)
          setDialog((current) =>
            current
              ? { ...current, drafting: false, note: "Could not draft text. Write it here." }
              : current,
          );
      },
    );
  };

  const onClick = () => {
    if (step.kind === "stage") void run({ reviewId, action: "stage-all" }, "stage");
    else if (step.kind === "push") void run({ reviewId, action: "push" }, "push");
    else if (step.kind === "commit" || step.kind === "pr") openDialog(step.kind);
    else if (step.kind === "view-pr" && state.pullRequest)
      void api
        .openExternal(state.pullRequest.url)
        .catch((failure: unknown) =>
          setError(failure instanceof Error ? failure.message : String(failure)),
        );
  };

  const submit = () => {
    if (!dialog || !dialog.title.trim()) return;
    void run(
      { reviewId, action: dialog.kind, title: dialog.title, body: dialog.body },
      dialog.kind,
    );
  };

  return (
    <div className="review-git" ref={root}>
      <button
        ref={button}
        className={`button review-git__button${step.kind === "none" ? "" : " button--primary"}`}
        type="button"
        disabled={step.kind === "none" || busy !== null}
        title={step.hint}
        aria-haspopup={step.kind === "commit" || step.kind === "pr" ? "dialog" : undefined}
        aria-expanded={dialog ? true : undefined}
        data-testid="review-git-button"
        data-step={step.kind}
        onClick={onClick}
      >
        {busy ? BUSY_LABEL[busy] : step.label}
      </button>
      {dialog ? (
        <form
          className="review-git__dialog"
          role="dialog"
          aria-label={dialog.kind === "commit" ? "Commit message" : "Pull request"}
          data-testid="review-git-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        >
          <label className="review-git__label" htmlFor={titleId}>
            {dialog.kind === "commit" ? "Commit message" : "Pull request title"}
          </label>
          <input
            id={titleId}
            className="review-git__field"
            autoFocus
            autoComplete="off"
            spellCheck
            value={dialog.title}
            placeholder={dialog.drafting ? "Writing from the diff…" : "Summarize the change…"}
            onChange={(event) => setDialog({ ...dialog, title: event.target.value, edited: true })}
          />
          <label className="review-git__label" htmlFor={bodyId}>
            {dialog.kind === "commit" ? "Details (optional)" : "Description"}
          </label>
          <textarea
            id={bodyId}
            className="review-git__field review-git__body"
            rows={dialog.kind === "commit" ? 4 : 7}
            autoComplete="off"
            spellCheck
            value={dialog.body}
            onChange={(event) => setDialog({ ...dialog, body: event.target.value, edited: true })}
          />
          <p className="review-git__note" aria-live="polite">
            {dialog.drafting ? "Writing from the diff…" : dialog.note}
          </p>
          {error ? (
            <p className="review-git__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="review-git__actions">
            <button
              className="button button--ghost"
              type="button"
              onClick={closeDialog}
              disabled={busy !== null}
            >
              Cancel
            </button>
            <button className="button button--primary" type="submit" disabled={busy !== null}>
              {busy
                ? BUSY_LABEL[busy]
                : dialog.kind === "commit"
                  ? "Commit"
                  : state.ghAvailable
                    ? "Create PR"
                    : "Open PR page"}
            </button>
          </div>
        </form>
      ) : error ? (
        <div className="review-git__dialog review-git__dialog--error" role="alert">
          <p className="review-git__error">{error}</p>
          <div className="review-git__actions">
            <button className="button" type="button" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
