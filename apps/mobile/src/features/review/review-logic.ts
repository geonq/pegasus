// Pure review logic (no React Native imports) so node --test can run it.
import type {
  GitActionState,
  ReviewFileEntry,
  ReviewFileStatus,
  ReviewLineCounts,
  ReviewScope,
  TurnChangeSummary,
} from "./types.ts";

export type DiffRow =
  | { readonly kind: "added"; readonly text: string; readonly newNumber: number }
  | { readonly kind: "removed"; readonly text: string; readonly oldNumber: number }
  | {
      readonly kind: "context";
      readonly text: string;
      readonly oldNumber: number;
      readonly newNumber: number;
    }
  /** Unchanged lines the patch leaves out between hunks (or before the first one). */
  | { readonly kind: "gap"; readonly count: number }
  /** "\ No newline at end of file", "Binary files … differ" and similar notes. */
  | { readonly kind: "note"; readonly text: string };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Turns a unified patch into rows for a phone: hunk headers become "N unmodified lines" gaps
 * counted from the new-file numbers, file headers are dropped.
 */
export function parsePatch(patch: string): DiffRow[] {
  const lines = patch.split("\n");
  // A patch ends with a newline; that last empty piece is not a blank context line.
  if (lines.at(-1) === "") lines.pop();
  const rows: DiffRow[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let nextUnshown = 1;
  // File headers only come before a file's first hunk; inside one, "---" is a removed "--" line.
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("diff ")) {
      inHunk = false;
      nextUnshown = 1;
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      inHunk = true;
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[3]);
      // A hunk that only deletes reports the new-file line before it.
      const deletesOnly = hunk[4] === "0";
      const start = deletesOnly ? newNumber + 1 : newNumber;
      const skipped = start - nextUnshown;
      if (skipped > 0) rows.push({ kind: "gap", count: skipped });
      newNumber = start;
      nextUnshown = start;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("Binary files")) rows.push({ kind: "note", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "added", text: line.slice(1), newNumber });
      newNumber += 1;
      nextUnshown = newNumber;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "removed", text: line.slice(1), oldNumber });
      oldNumber += 1;
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "note", text: line.slice(1).trim() });
    } else if (line.startsWith(" ") || line === "") {
      rows.push({ kind: "context", text: line.slice(1), oldNumber, newNumber });
      oldNumber += 1;
      newNumber += 1;
      nextUnshown = newNumber;
    }
  }
  return rows;
}

/** Longest row text in characters (tabs as 4), so the diff knows how wide to scroll. */
export function longestRow(rows: readonly DiffRow[]): number {
  let longest = 0;
  for (const row of rows) {
    if (row.kind === "gap") continue;
    longest = Math.max(longest, row.text.replace(/\t/g, "    ").length);
  }
  return longest;
}

export interface PathParts {
  readonly name: string;
  /** The folder with a trailing slash, or "" at the root. */
  readonly folder: string;
}

export function splitPath(path: string): PathParts {
  const cut = path.lastIndexOf("/");
  return cut < 0
    ? { name: path, folder: "" }
    : { name: path.slice(cut + 1), folder: path.slice(0, cut + 1) };
}

export interface FileTotals extends ReviewLineCounts {
  readonly files: number;
  readonly reviewed: number;
}

export function totals(
  files: readonly { readonly lines: ReviewLineCounts | null; readonly reviewed?: boolean }[],
): FileTotals {
  let added = 0;
  let removed = 0;
  let reviewed = 0;
  for (const file of files) {
    added += file.lines?.added ?? 0;
    removed += file.lines?.removed ?? 0;
    if (file.reviewed) reviewed += 1;
  }
  return { files: files.length, added, removed, reviewed };
}

/** Files sorted by folder, then name, so one folder's files sit together. */
export function sortFiles<T extends { readonly path: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => {
    const left = splitPath(a.path);
    const right = splitPath(b.path);
    return left.folder === right.folder
      ? left.name.localeCompare(right.name)
      : left.folder.localeCompare(right.folder);
  });
}

const STATUS: Record<ReviewFileStatus, { readonly letter: string; readonly label: string }> = {
  added: { letter: "A", label: "Added" },
  copied: { letter: "C", label: "Copied" },
  deleted: { letter: "D", label: "Deleted" },
  modified: { letter: "M", label: "Modified" },
  renamed: { letter: "R", label: "Renamed" },
  untracked: { letter: "U", label: "New, untracked" },
  conflicted: { letter: "!", label: "Conflicted" },
  typechanged: { letter: "T", label: "Type changed" },
};

export function statusOf(status: ReviewFileStatus) {
  return STATUS[status];
}

export interface TurnOption {
  readonly checkpointId: string;
  readonly checkoutId: string;
  readonly label: string;
  readonly totals: FileTotals;
}

/**
 * The turn picker, newest first. Assumes the PC lists turns oldest first (its checkpoint store
 * keeps them in capture order).
 */
export function turnOptions(turns: readonly TurnChangeSummary[]): TurnOption[] {
  return turns
    .map((turn, index) => ({
      checkpointId: turn.checkpointId,
      checkoutId: turn.checkoutId,
      label: index === turns.length - 1 ? "Last turn" : `Turn ${index + 1}`,
      totals: totals(turn.files),
    }))
    .reverse();
}

/** The index moves a file allows in this comparison: only those whose content it shows. */
export function stageActionsFor(
  scope: ReviewScope,
  file: ReviewFileEntry,
): readonly ("stage" | "unstage")[] {
  const allowed =
    scope.kind === "uncommitted"
      ? ["stage", "unstage"]
      : scope.kind === "staged"
        ? ["unstage"]
        : scope.kind === "unstaged"
          ? ["stage"]
          : [];
  return (["stage", "unstage"] as const).filter(
    (action) =>
      allowed.includes(action) &&
      (action === "stage" ? file.hasUnstagedChanges : file.hasStagedChanges),
  );
}

export type GitStep =
  | {
      readonly kind: "stage" | "commit" | "push" | "pr" | "view-pr";
      readonly label: string;
      readonly hint: string;
    }
  | { readonly kind: "none"; readonly label: string; readonly hint: string };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Same order as the desktop's review button: stage, commit, push, then pull request. */
export function nextGitStep(state: GitActionState): GitStep {
  if (state.conflicted > 0)
    return {
      kind: "none",
      label: "Resolve conflicts",
      hint: "Fix the merge conflicts on the PC first.",
    };
  if (!state.branch)
    return { kind: "none", label: "Detached HEAD", hint: "Check out a branch to commit and push." };
  if (state.staged === 0 && state.unstaged > 0)
    return {
      kind: "stage",
      label: "Stage all",
      hint: `${plural(state.unstaged, "changed file")} not staged`,
    };
  if (state.staged > 0)
    return {
      kind: "commit",
      label: "Commit",
      hint:
        state.unstaged > 0
          ? `${plural(state.staged, "file")} staged, ${state.unstaged} left out`
          : `${plural(state.staged, "file")} staged`,
    };
  const onBase = state.branch === state.base;
  const unpublished = !state.upstream && state.aheadOfBase > 0 && !onBase;
  if (state.ahead > 0 || unpublished) {
    if (!state.remote)
      return {
        kind: "none",
        label: "No remote",
        hint: "This repository has no remote to push to.",
      };
    return {
      kind: "push",
      label: "Push",
      hint: state.upstream
        ? `${plural(state.ahead, "commit")} to ${state.upstream}`
        : `Publish ${state.branch} to ${state.remote}`,
    };
  }
  if (state.pullRequest)
    return {
      kind: "view-pr",
      label: `View PR #${state.pullRequest.number}`,
      hint: "Open it in the browser",
    };
  if (state.upstream && !onBase && state.aheadOfBase > 0)
    return {
      kind: "pr",
      label: state.ghAvailable ? "Create PR" : "Open PR page",
      hint: state.base ? `Into ${state.base}` : "On your Git host",
    };
  return { kind: "none", label: "Up to date", hint: "Nothing to commit or push." };
}

export type CommentableRow = Extract<DiffRow, { kind: "added" | "removed" | "context" }>;

export function isCommentable(row: DiffRow): row is CommentableRow {
  return row.kind === "added" || row.kind === "removed" || row.kind === "context";
}

/** A note on one diff line, waiting to be sent to the chat with the others. */
export interface LineComment {
  readonly id: string;
  /** `path:12`, the reference the agent reads. */
  readonly label: string;
  /** The line as diff text with its `+`, `-` or space. */
  readonly quote: string;
  readonly text: string;
}

const PREFIX = { added: "+", removed: "-", context: " " } as const;

export function buildComment(
  path: string,
  row: CommentableRow,
  text: string,
  id: string,
): LineComment | null {
  if (!text.trim()) return null;
  const label =
    row.kind === "removed" ? `${path}:${row.oldNumber} (removed line)` : `${path}:${row.newNumber}`;
  return { id, label, quote: `${PREFIX[row.kind]}${row.text}`, text: text.trim() };
}

/** The one message that sends every comment to the chat; same shape as the desktop's. */
export function formatCommentsPrompt(comments: readonly LineComment[]): string {
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
