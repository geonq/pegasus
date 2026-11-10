import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { HighlightedLine } from "../../ui/highlighted-line";
import { parseDiff } from "../../ui/diff-inline";
import { MAX_HIGHLIGHTED_LINES } from "../../ui/syntax-highlight";
import { buildComment, isCommentable, rowKey, type DiffComment } from "./diff-comments";

interface Range {
  readonly anchor: number;
  readonly focus: number;
}

/**
 * The review diff with line comments. Drag over the gutter (or Shift-click) to pick lines with
 * the mouse; with the keyboard, focus a line, use Up/Down (Shift extends) and press C or Enter.
 */
export function AnnotatableDiff({
  diff,
  language,
  path,
  comments,
  onAdd,
  onRemove,
}: {
  readonly diff: string;
  readonly language?: string;
  readonly path: string;
  readonly comments: readonly DiffComment[];
  readonly onAdd: (comment: DiffComment) => void;
  readonly onRemove: (id: string) => void;
}) {
  const lines = useMemo(() => parseDiff(diff, true), [diff]);
  const highlight = language !== undefined && lines.length <= MAX_HIGHLIGHTED_LINES;
  const commentable = useMemo(
    () => lines.flatMap((line, index) => (isCommentable(line) ? [index] : [])),
    [lines],
  );
  const [selection, setSelection] = useState<Range | null>(null);
  const [composing, setComposing] = useState<Range | null>(null);
  const selectionRef = useRef<Range | null>(null);
  const dragging = useRef(false);
  const rootRef = useRef<HTMLPreElement>(null);

  const select = (next: Range | null) => {
    selectionRef.current = next;
    setSelection(next);
  };
  useEffect(() => {
    select(null);
    setComposing(null);
  }, [diff]);

  const focusRow = (index: number) =>
    rootRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.focus();
  const compose = (range: Range) => {
    if (!lines.slice(Math.min(range.anchor, range.focus), Math.max(range.anchor, range.focus) + 1).some(isCommentable))
      return;
    setComposing(range);
  };

  const finishDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (selectionRef.current) compose(selectionRef.current);
  };
  const beginDrag = (index: number, event: PointerEvent) => {
    if (event.button !== 0) return;
    // Keeps the browser from starting a text selection and moving focus off the diff.
    event.preventDefault();
    const previous = selectionRef.current;
    select(
      event.shiftKey && previous
        ? { anchor: previous.anchor, focus: index }
        : { anchor: index, focus: index },
    );
    dragging.current = true;
    window.addEventListener("pointerup", finishDrag, { once: true });
  };
  const extendDrag = (index: number) => {
    const current = selectionRef.current;
    if (dragging.current && current) select({ anchor: current.anchor, focus: index });
  };

  const onRowKeyDown = (index: number, event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    // A selection only counts while it ends on the focused line; otherwise start from this line.
    const held = selectionRef.current;
    const previous = held && held.focus === index ? held : { anchor: index, focus: index };
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step !== 0) {
      const at = commentable.indexOf(index);
      const next = commentable[at + step];
      if (next === undefined) return;
      event.preventDefault();
      select(
        event.shiftKey
          ? { anchor: previous.anchor, focus: next }
          : { anchor: next, focus: next },
      );
      focusRow(next);
      rootRef.current
        ?.querySelector(`[data-row="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
    } else if ((event.key === "c" || event.key === "Enter") && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      select(previous);
      compose(previous);
    } else if (event.key === "Escape") {
      select(null);
    }
  };

  const rowByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const index of commentable) {
      const line = lines[index];
      if (line) map.set(rowKey(line), index);
    }
    return map;
  }, [commentable, lines]);
  const { placed, outdated } = useMemo(() => {
    const at = new Map<number, DiffComment[]>();
    const lost: DiffComment[] = [];
    for (const comment of comments) {
      const start = rowByKey.get(comment.startKey);
      const end = rowByKey.get(comment.endKey);
      if (start === undefined || end === undefined) {
        lost.push(comment);
        continue;
      }
      at.set(end, [...(at.get(end) ?? []), comment]);
    }
    return { placed: at, outdated: lost };
  }, [comments, rowByKey]);

  const low = selection ? Math.min(selection.anchor, selection.focus) : -1;
  const high = selection ? Math.max(selection.anchor, selection.focus) : -1;
  const rovingIndex = selection?.focus ?? commentable[0];
  const composeLabel = composing
    ? (buildComment(path, lines, composing.anchor, composing.focus, "x")?.label ?? path)
    : "";

  if (lines.length === 0) return null;
  return (
    <pre
      ref={rootRef}
      className="diff-inline diff-inline--annotatable"
      role="group"
      aria-label="Diff. Focus a line, then use Up and Down to move, Shift to extend, and C to comment."
      data-language={highlight ? language : undefined}
    >
      {lines.map((line, index) => {
        const canComment = isCommentable(line);
        const number = line.type === "removed" ? undefined : line.lineNumber;
        return (
          <Fragment key={index}>
            <div
              className={`diff-line diff-line--${line.type}${
                index >= low && index <= high && canComment ? " diff-line--selected" : ""
              }`}
              data-row={canComment ? index : undefined}
              tabIndex={canComment ? (index === rovingIndex ? 0 : -1) : undefined}
              onKeyDown={canComment ? (event) => onRowKeyDown(index, event) : undefined}
              onPointerEnter={canComment ? () => extendDrag(index) : undefined}
              onFocus={
                canComment
                  ? (event) => {
                      if (
                        event.currentTarget.matches(":focus-visible") &&
                        !dragging.current &&
                        selectionRef.current?.focus !== index
                      )
                        select({ anchor: index, focus: index });
                    }
                  : undefined
              }
            >
              <span className="diff-line__number">
                {canComment ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className="diff-line__add"
                    aria-label={`Comment on ${number === undefined ? "removed line" : `line ${number}`}`}
                    onPointerDown={(event) => beginDrag(index, event)}
                  >
                    +
                  </button>
                ) : null}
                {number}
              </span>
              <span className="diff-line__content">
                {highlight && line.type !== "header" && line.type !== "unmodified" ? (
                  <HighlightedLine content={line.content} language={language!} />
                ) : (
                  line.content
                )}
              </span>
            </div>
            {composing && Math.max(composing.anchor, composing.focus) === index ? (
              <CommentComposer
                label={composeLabel}
                onCancel={() => {
                  setComposing(null);
                  focusRow(index);
                }}
                onSubmit={(text) => {
                  const comment = buildComment(path, lines, composing.anchor, composing.focus, text);
                  if (comment) onAdd(comment);
                  setComposing(null);
                  focusRow(index);
                }}
              />
            ) : null}
            {placed.get(index)?.map((comment) => (
              <CommentCard key={comment.id} comment={comment} onRemove={onRemove} />
            ))}
          </Fragment>
        );
      })}
      {outdated.map((comment) => (
        <CommentCard key={comment.id} comment={comment} outdated onRemove={onRemove} />
      ))}
    </pre>
  );
}

function CommentComposer({
  label,
  onSubmit,
  onCancel,
}: {
  readonly label: string;
  readonly onSubmit: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const submit = () => {
    if (text.trim()) onSubmit(text);
  };
  return (
    <form
      className="diff-comment diff-comment--composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="diff-comment__label" htmlFor={id} translate="no">
        Comment on {label}
      </label>
      <textarea
        id={id}
        className="diff-comment__input"
        rows={3}
        autoFocus
        autoComplete="off"
        value={text}
        placeholder="What should change?…"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="diff-comment__actions">
        <button className="button button--ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="button button--primary" type="submit">
          Add comment
        </button>
      </div>
    </form>
  );
}

function CommentCard({
  comment,
  outdated = false,
  onRemove,
}: {
  readonly comment: DiffComment;
  readonly outdated?: boolean;
  readonly onRemove: (id: string) => void;
}) {
  return (
    <div className="diff-comment" data-testid="diff-comment">
      <div className="diff-comment__head">
        <span className="diff-comment__label" translate="no">
          {comment.label}
          {outdated ? " · line changed" : ""}
        </span>
        <button
          className="diff-comment__remove"
          type="button"
          aria-label={`Remove comment on ${comment.label}`}
          title="Remove comment"
          onClick={() => onRemove(comment.id)}
        >
          ×
        </button>
      </div>
      <p className="diff-comment__text">{comment.text}</p>
    </div>
  );
}
