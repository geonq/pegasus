import { useCallback, useEffect, useRef, useState } from "react";
import type { PullRequestFeedbackResult } from "../../../contracts/git-actions";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { formatPullRequestFeedback, summarizePullRequestFeedback } from "./pr-feedback";

type Api = Pick<PiDesktopApi, "getPullRequestFeedback" | "openExternal">;
type Feedback = Extract<PullRequestFeedbackResult, { state: "feedback" }>;

const PENDING_POLL_MS = 20_000;

/**
 * The open pull request's checks and comments next to the git button. One click hands the failing
 * checks and the reviewers' comments to the chat as a message.
 */
export function ReviewPullRequestFeedback({
  api,
  reviewId,
  onSendToChat,
}: {
  readonly api: Api;
  readonly reviewId: string;
  /** Sends the text to the chat; resolves to an error message, or null when sent. */
  readonly onSendToChat: (text: string) => Promise<string | null>;
}) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const nonce = useRef(0);

  const load = useCallback(() => {
    const current = ++nonce.current;
    void api.getPullRequestFeedback({ reviewId }).then(
      (result) => {
        if (nonce.current === current) setFeedback(result.state === "feedback" ? result : null);
      },
      () => {
        if (nonce.current === current) setFeedback(null);
      },
    );
  }, [api, reviewId]);
  useEffect(() => {
    load();
    return () => {
      nonce.current += 1;
    };
  }, [load]);

  const pending = feedback?.checks.some((check) => check.state === "pending") ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(load, PENDING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, pending]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!feedback) return null;
  const summary = summarizePullRequestFeedback(feedback);
  const message = formatPullRequestFeedback(feedback);
  const shownChecks = feedback.checks.filter((check) => check.state !== "skipped");

  const reportFailure = (failure: unknown) =>
    setNote(failure instanceof Error ? failure.message : String(failure));
  const openLink = (url: string) => {
    api.openExternal(url).catch(reportFailure);
  };

  const send = async () => {
    if (!message) return;
    setSending(true);
    setNote(null);
    try {
      const error = await onSendToChat(message);
      setNote(error ?? "Sent to the chat.");
      if (!error) setOpen(false);
    } catch (failure: unknown) {
      setNote(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="review-pr" ref={root}>
      <button
        className={`button button--ghost review-pr__button review-pr__button--${summary.tone}`}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Pull request #${feedback.number}: ${summary.label}`}
        aria-label={`Pull request #${feedback.number}: ${summary.label}`}
        data-testid="review-pr-feedback"
        data-tone={summary.tone}
        onClick={() => {
          if (!open) load();
          setOpen(!open);
          setNote(null);
        }}
      >
        <span className="review-pr__dot" aria-hidden="true" />
        {summary.short}
        {feedback.comments.length > 0 ? (
          <span className="review-pr__count" aria-hidden="true">
            {feedback.comments.length}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="review-git__dialog review-pr__dialog"
          role="dialog"
          aria-label="Pull request feedback"
        >
          <button className="review-pr__title" type="button" onClick={() => openLink(feedback.url)}>
            Pull request #{feedback.number}
          </button>
          {shownChecks.length > 0 ? (
            <ul className="review-pr__list" aria-label="Checks">
              {shownChecks.map((check) => (
                <li
                  key={check.name}
                  className={`review-pr__check review-pr__check--${check.state}`}
                >
                  <span className="review-pr__dot" aria-hidden="true" />
                  {check.link ? (
                    <button
                      className="review-pr__link"
                      type="button"
                      onClick={() => openLink(check.link ?? feedback.url)}
                    >
                      {check.name}
                    </button>
                  ) : (
                    <span>{check.name}</span>
                  )}
                  <span className="review-pr__state">{check.state}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="review-git__note">No checks reported.</p>
          )}
          {feedback.comments.length > 0 ? (
            <ul className="review-pr__list" aria-label="Comments">
              {feedback.comments.map((comment, index) => (
                <li key={`${comment.url ?? ""}:${index}`} className="review-pr__comment">
                  <span className="review-pr__author">
                    @{comment.author}
                    {comment.path
                      ? ` · ${comment.path}${comment.line === null ? "" : `:${comment.line}`}`
                      : ""}
                  </span>
                  <span className="review-pr__body">{comment.body}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="review-git__note" aria-live="polite">
            {note ?? (message ? "" : "Nothing failing and no comments to send.")}
          </p>
          <div className="review-git__actions">
            <button className="button button--ghost" type="button" onClick={load}>
              Refresh
            </button>
            <button
              className="button button--primary"
              type="button"
              disabled={!message || sending}
              onClick={() => {
                send().catch(reportFailure);
              }}
            >
              {sending ? "Sending…" : "Send to chat"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
