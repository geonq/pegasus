import type { DiffLine } from "../../ui/diff-inline";

/** A note on a run of diff lines, waiting to be sent to the agent with the others of its review. */
export interface DiffComment {
  readonly id: string;
  readonly path: string;
  /** Row keys of the first and last commented line, so the note finds its lines after a refresh. */
  readonly startKey: string;
  readonly endKey: string;
  /** `path:12-15`, the reference the agent reads. */
  readonly label: string;
  /** The commented lines as diff text, each with its `+`, `-` or space. */
  readonly quote: string;
  readonly text: string;
}

export type CommentableLine = DiffLine & { readonly type: "added" | "removed" | "context" };

export function isCommentable(line: DiffLine): line is CommentableLine {
  return line.type === "added" || line.type === "removed" || line.type === "context";
}

/** New-file lines are `n12`, removed lines (which have no new number) are `o7`. */
export function rowKey(line: DiffLine): string {
  return line.type === "removed" ? `o${line.oldNumber ?? 0}` : `n${line.lineNumber ?? 0}`;
}

const PREFIX = { added: "+", removed: "-", context: " " } as const;

/** Builds the comment for rows `start..end` (inclusive) of `lines`; null if none can be commented. */
export function buildComment(
  path: string,
  lines: readonly DiffLine[],
  start: number,
  end: number,
  text: string,
): DiffComment | null {
  const rows = lines.slice(Math.min(start, end), Math.max(start, end) + 1).filter(isCommentable);
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last || !text.trim()) return null;
  const newNumbers = rows.flatMap((row) => (row.type === "removed" ? [] : [row.lineNumber ?? 0]));
  const oldNumbers = rows.flatMap((row) => (row.type === "removed" ? [row.oldNumber ?? 0] : []));
  const span = (numbers: readonly number[]) =>
    numbers[0] === numbers.at(-1) ? `${numbers[0]}` : `${numbers[0]}-${numbers.at(-1)}`;
  const label =
    newNumbers.length > 0
      ? `${path}:${span(newNumbers)}`
      : `${path}:${span(oldNumbers)} (removed lines)`;
  return {
    id: crypto.randomUUID(),
    path,
    startKey: rowKey(first),
    endKey: rowKey(last),
    label,
    quote: rows.map((row) => `${PREFIX[row.type]}${row.content}`).join("\n"),
    text: text.trim(),
  };
}

/** The one prompt that sends every comment to the agent. */
export function formatCommentsPrompt(comments: readonly DiffComment[]): string {
  const blocks = comments.map((comment, index) => {
    const longestRun = Math.max(0, ...(comment.quote.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    return [
      `${index + 1}. ${comment.label}`,
      `${fence}diff`,
      comment.quote,
      fence,
      comment.text,
    ].join("\n");
  });
  const count = comments.length;
  return [
    `Review comments on the current changes (${count} ${count === 1 ? "comment" : "comments"}). Address each one, then say what you changed.`,
    ...blocks,
  ].join("\n\n");
}

// Comments live in memory per comparison so they survive switching files or panel tabs.
const store = new Map<string, readonly DiffComment[]>();

export function readStoredComments(key: string): readonly DiffComment[] {
  return store.get(key) ?? [];
}

export function writeStoredComments(key: string, comments: readonly DiffComment[]): void {
  if (comments.length === 0) store.delete(key);
  else store.set(key, comments);
}
