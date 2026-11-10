import { useState } from "react";
import { MessageMarkdown } from "./message-markdown";

/** What the orchestration owner sends the lead when a child thread ends (app-store-orchestration.ts). */
export interface ChildReport {
  readonly title: string;
  readonly failed: boolean;
  readonly childThreadId: string;
  /** "repo (branch): 2 commit(s)…" lines, each with the commits listed under it. */
  readonly git: readonly { readonly summary: string; readonly commits: readonly string[] }[];
  readonly reply: string;
}

const HEADER = /^\[Child thread report\] "(.*)" (failed|finished)\.$/;

/** Reads the report text back into parts. Anything that does not match stays an ordinary message. */
export function parseChildReport(text: string): ChildReport | null {
  if (!text.startsWith("[Child thread report]")) return null;
  const lines = text.split(/\r?\n/);
  const header = HEADER.exec(lines[0] ?? "");
  const id = /^childThreadId: (\S+)$/.exec(lines[1] ?? "");
  const replyAt = lines.indexOf("Last reply:");
  if (!header || !id || replyAt < 0) return null;
  const git: { summary: string; commits: string[] }[] = [];
  if (lines[2] === "Git:") {
    for (const line of lines.slice(3, replyAt)) {
      if (line.startsWith("- ")) git.push({ summary: line.slice(2), commits: [] });
      else if (line.startsWith("  - ") && git.length) git.at(-1)?.commits.push(line.slice(4));
    }
  }
  const reply = lines
    .slice(replyAt + 1)
    .join("\n")
    .trim();
  return {
    title: header[1] ?? "",
    failed: header[2] === "failed",
    childThreadId: id[1] ?? "",
    git,
    reply: reply.startsWith("(no reply;") ? "" : reply,
  };
}

const COLLAPSE_LINES = 4;

function isLong(reply: string): boolean {
  return reply.split("\n").length > COLLAPSE_LINES || reply.length > 320;
}

async function openChildThread(childThreadId: string): Promise<void> {
  const app = window.piApp;
  const state = await app?.getState();
  const child = state?.orchestrationChildren.find((entry) => entry.id === childThreadId);
  if (!app || !child) return;
  await app.selectSession({ workspaceId: child.childWorkspaceId, sessionId: child.childSessionId });
}

/** A finished or failed child thread as a compact status card instead of a user bubble. */
export function ChildReportCard({ report }: { readonly report: ChildReport }) {
  const [open, setOpen] = useState(false);
  const long = isLong(report.reply);
  const state = report.failed ? "failed" : "finished";
  return (
    <article
      className={`child-report child-report--${state}`}
      data-testid="child-report"
      data-state={state}
    >
      <header className="child-report__header">
        <span aria-hidden="true" className="child-report__dot" />
        <span className="child-report__title" title={report.title}>
          {report.title}
        </span>
        <span className="child-report__state">{report.failed ? "Failed" : "Finished"}</span>
        <button
          className="child-report__open"
          type="button"
          onClick={() => void openChildThread(report.childThreadId)}
        >
          Open thread
        </button>
      </header>
      {report.git.length ? (
        <ul className="child-report__git" aria-label="Git summary">
          {report.git.map((entry) => (
            <li key={entry.summary}>
              <span>{entry.summary}</span>
              {entry.commits.map((commit) => (
                <code key={commit}>{commit}</code>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      {report.reply ? (
        <div className="child-report__reply" data-collapsed={long && !open ? "" : undefined}>
          <MessageMarkdown text={report.reply} />
        </div>
      ) : (
        <p className="child-report__empty">No reply from the thread.</p>
      )}
      {long ? (
        <button
          aria-expanded={open}
          className="child-report__toggle"
          type="button"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </article>
  );
}
