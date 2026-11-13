import { useMemo, useRef, useState } from "react";
import { StateOrb } from "../../app/activity-indicator";
import { activityForTool } from "../../../contracts/agent-activity";
import type {
  SessionTranscriptCustomMessage,
  SessionTranscriptMessage,
} from "@pi-gui/session-driver";
import type {
  DisplayTimelineItem,
  TimelineActivity,
  TimelineToolCall,
  TimelineSummary,
  TimelineTurnMarker,
} from "../../../contracts/timeline-types";
import type { ScheduledTaskOrigin } from "../../../contracts/scheduled-tasks";
import { extensionToolRowLabel, humanToolName } from "../../../contracts/tool-labels";
import {
  canDrawGenerativeUi,
  GenerativeUiToolItem,
} from "../generative-ui/generative-ui-tool-item";
import { useExtensionToolLabel } from "../extensions/extension-tool-labels";
import {
  AnnotationMarkers,
  type AnnotationMarker,
  type OpenAnnotation,
} from "./annotations/annotation-markers";
import { parseAnnotatedPrompt } from "./annotations/annotation-prompt";
import { SentAnnotations } from "./annotations/sent-annotations";
import { ExtensionCardItem, type RunExtensionAction } from "./extension-card";
import { ImageAttachmentThumb } from "./image-attachment-thumb";
import { ErrorText } from "../../ui/error-text";
import { ChildReportCard, parseChildReport } from "./child-report";
import { MessageMarkdown } from "./message-markdown";
import { stringifyToolValue, toolOutputImageSrc, toolOutputImages } from "./tool-output-images";
import { TurnChangesCard, type OpenTurnChange } from "./turn-changes-card";
import type { WorkspaceFileLine } from "./workspace-file-line";
import { InlineDiff, extractDiffFromOutput } from "../../ui/diff-inline";
import {
  ChevronRightIcon,
  CopyIcon,
  DiffIcon,
  FileIcon,
  ForkIcon,
  ExtensionIcon,
  TerminalIcon,
} from "../../ui/icons";
import { extensionToLanguage } from "../../ui/syntax-highlight";
import { CopyButton } from "../../ui/copy-button";
import { UserMessageFold } from "./user-message-fold";

export function TimelineItem({
  item,
  expandedToolCallIds,
  onToggleToolCall,
  onViewFileInDiff,
  sourceMessageIndex,
  onForkFromMessage,
  onOpenTurnChange,
  scheduledOrigin,
  workspacePath,
  onOpenWorkspaceFileLine,
  onExtensionAction,
  annotationMarkers,
  onOpenAnnotation,
}: {
  readonly item: DisplayTimelineItem;
  readonly expandedToolCallIds?: ReadonlySet<string>;
  readonly onToggleToolCall?: (callId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly sourceMessageIndex?: number;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
  readonly onOpenTurnChange?: OpenTurnChange;
  readonly scheduledOrigin?: ScheduledTaskOrigin;
  readonly workspacePath?: string;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
  readonly onExtensionAction?: RunExtensionAction;
  readonly annotationMarkers?: readonly AnnotationMarker[];
  readonly onOpenAnnotation?: OpenAnnotation;
}) {
  switch (item.kind) {
    case "turn-marker":
      return <TimelineTurnMarkerItem item={item} />;
    case "turn-changes":
      return <TurnChangesCard turn={item.turn} onOpen={onOpenTurnChange} />;
    case "message": {
      const childReport = item.role === "user" ? parseChildReport(item.text) : null;
      if (childReport) return <ChildReportCard report={childReport} />;
      return (
        <TimelineMessage
          item={item}
          sourceMessageIndex={sourceMessageIndex}
          onForkFromMessage={onForkFromMessage}
          onOpenWorkspaceFileLine={onOpenWorkspaceFileLine}
          scheduledOrigin={scheduledOrigin}
          workspacePath={workspacePath}
          annotationMarkers={annotationMarkers}
          onOpenAnnotation={onOpenAnnotation}
        />
      );
    }
    case "activity":
      return <TimelineActivityItem item={item} />;
    case "tool":
      if (canDrawGenerativeUi(item)) return <GenerativeUiToolItem item={item} />;
      return (
        <TimelineToolCallItem
          item={item}
          expanded={expandedToolCallIds?.has(item.callId) ?? false}
          onToggle={onToggleToolCall}
          onViewFileInDiff={onViewFileInDiff}
        />
      );
    case "summary":
      return <TimelineSummaryItem item={item} />;
    case "custom":
      return <TimelineCustomMessage item={item} />;
    case "card":
      return <ExtensionCardItem card={item.card} onAction={onExtensionAction} />;
    case "thinking":
      return <TimelineThinking item={item} />;
    case "tool-group":
      return (
        <TimelineToolGroupItem
          item={item}
          expandedToolCallIds={expandedToolCallIds}
          onToggleToolCall={onToggleToolCall}
          onViewFileInDiff={onViewFileInDiff}
        />
      );
    default:
      return unhandledTimelineItem(item);
  }
}

function unhandledTimelineItem(item: never): null {
  console.warn("[timeline] unhandled item kind", item);
  return null;
}

/** A run of reads and searches as one quiet line that opens to the calls themselves. */
function TimelineToolGroupItem({
  item,
  expandedToolCallIds,
  onToggleToolCall,
  onViewFileInDiff,
}: {
  readonly item: Extract<DisplayTimelineItem, { kind: "tool-group" }>;
  readonly expandedToolCallIds?: ReadonlySet<string>;
  readonly onToggleToolCall?: (callId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="timeline-thinking timeline-tool-group" data-testid="timeline-tool-group">
      <button
        className="timeline-thinking__header"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <span
          className={`timeline-thinking__chevron ${expanded ? "timeline-thinking__chevron--expanded" : ""}`}
        >
          <ChevronRightIcon />
        </span>
        <span className="timeline-thinking__label">{item.label}</span>
      </button>
      {expanded ? (
        <div className="timeline-tool-group__calls">
          {item.tools.map((tool) => (
            <TimelineToolCallItem
              key={tool.id}
              item={tool}
              expanded={expandedToolCallIds?.has(tool.callId) ?? false}
              onToggle={onToggleToolCall}
              onViewFileInDiff={onViewFileInDiff}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Providers open a reasoning block with a bold title line ("**Planning the steps**"). Show it
 * as the row's one-line summary with the markers stripped, never as literal asterisks.
 */
function thinkingTitle(text: string): string | undefined {
  const match = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*(?:\r?\n|$)/.exec(text);
  const title = match?.[1]?.replace(/[*_`]/g, "").trim();
  return title || undefined;
}

/** The model's reasoning: one quiet "Thought for 19s" line, collapsed until the reader opens it. */
function TimelineThinking({
  item,
}: {
  readonly item: Extract<DisplayTimelineItem, { kind: "thinking" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const title = thinkingTitle(item.text);
  return (
    <article className="timeline-thinking" data-testid="timeline-thinking">
      <button
        className="timeline-thinking__header"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <span
          className={`timeline-thinking__chevron ${expanded ? "timeline-thinking__chevron--expanded" : ""}`}
        >
          <ChevronRightIcon />
        </span>
        <span className="timeline-thinking__label">
          {item.open
            ? "Thinking…"
            : item.durationMs !== undefined
              ? `Thought for ${formatWorkedDuration(item.durationMs)}`
              : "Thought"}
        </span>
        {!item.open && !expanded && title ? (
          <span className="timeline-thinking__title" title={title}>
            {title}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="timeline-thinking__body" data-testid="timeline-thinking-body">
          <MessageMarkdown text={item.text} />
        </div>
      ) : null}
    </article>
  );
}

/** An extension message, drawn like terminal pi: its customType labels the markdown. */
function TimelineCustomMessage({ item }: { readonly item: SessionTranscriptCustomMessage }) {
  return (
    <article className="timeline-item timeline-item--custom" data-testid="timeline-custom-message">
      <div className="timeline-item__custom-type">{item.customType}</div>
      <MessageMarkdown text={item.text} />
    </article>
  );
}

function TimelineMessage({
  item,
  sourceMessageIndex,
  onForkFromMessage,
  scheduledOrigin,
  workspacePath,
  onOpenWorkspaceFileLine,
  annotationMarkers,
  onOpenAnnotation,
}: {
  readonly item: SessionTranscriptMessage;
  readonly sourceMessageIndex?: number;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
  readonly scheduledOrigin?: ScheduledTaskOrigin;
  readonly workspacePath?: string;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
  readonly annotationMarkers?: readonly AnnotationMarker[];
  readonly onOpenAnnotation?: OpenAnnotation;
}) {
  const articleRef = useRef<HTMLElement | null>(null);
  const annotated = useMemo(
    () => (item.role === "user" ? parseAnnotatedPrompt(item.text) : null),
    [item.role, item.text],
  );
  const markers =
    annotationMarkers?.length && onOpenAnnotation ? (
      <AnnotationMarkers
        articleRef={articleRef}
        markers={annotationMarkers}
        messageId={item.id}
        onOpen={onOpenAnnotation}
      />
    ) : null;

  if (item.role === "user") {
    const body = annotated ? annotated.body : item.text;
    return (
      <article className="timeline-item timeline-item--user" ref={articleRef}>
        {/* Beside the bubble, not under it, so a user row keeps its height. */}
        {body.trim() ? (
          <div className="timeline-item__actions timeline-item__actions--user">
            <CopyButton
              className="timeline-item__action"
              label="Copy message"
              testId="copy-message"
              text={body}
            />
          </div>
        ) : null}
        <div className="timeline-item__user-stack">
          {scheduledOrigin ? (
            <div className="timeline-item__scheduled-origin" data-testid="sent-by-scheduled-task">
              Sent by scheduled task
            </div>
          ) : null}
          <div className="timeline-item__bubble">
            {item.attachments?.length ? (
              <div className="timeline-item__attachments">
                {item.attachments.map((attachment, index) =>
                  attachment.kind === "image" ? (
                    <ImageAttachmentThumb
                      className="timeline-item__attachment timeline-item__attachment--image"
                      key={`${item.id}:${index}`}
                      name={attachment.name ?? `Attachment ${index + 1}`}
                      src={`data:${attachment.mimeType};base64,${attachment.data}`}
                    />
                  ) : (
                    <div
                      className="timeline-item__attachment timeline-item__attachment--file"
                      key={`${item.id}:${index}`}
                      title={attachment.fsPath}
                    >
                      <span className="timeline-item__attachment-icon" aria-hidden="true">
                        <FileIcon />
                      </span>
                      <span className="timeline-item__attachment-name">{attachment.name}</span>
                    </div>
                  ),
                )}
              </div>
            ) : null}
            {annotated ? <SentAnnotations annotations={annotated.annotations} /> : null}
            {annotated && !body.trim() ? null : (
              <UserMessageFold messageId={item.id}>
                <MessageMarkdown annotationRoot text={body} />
              </UserMessageFold>
            )}
          </div>
        </div>
        {markers}
      </article>
    );
  }

  if (item.role === "branchSummary" || item.role === "compactionSummary") {
    return (
      <article className="timeline-item timeline-item--summary-card">
        <div className="timeline-item__summary-eyebrow">
          {item.role === "branchSummary" ? "Branch summary" : "Compaction summary"}
        </div>
        <MessageMarkdown text={item.text} />
      </article>
    );
  }

  // The row stays while a run streams (Fork is disabled then), so the transcript never
  // shifts by the row's height when a run starts or ends.
  const forkable = sourceMessageIndex !== undefined;
  return (
    <article className="timeline-item timeline-item--assistant" ref={articleRef}>
      <MessageMarkdown
        annotationRoot
        onOpenWorkspaceFileLine={onOpenWorkspaceFileLine}
        text={item.text}
        workspacePath={workspacePath}
      />
      {forkable ? (
        <div className="timeline-item__actions">
          <CopyButton
            className="timeline-item__action"
            label="Copy message"
            showLabel
            testId="copy-message"
            text={item.text}
          />
          <button
            type="button"
            className="timeline-item__action"
            title={
              onForkFromMessage
                ? "Fork conversation from this point"
                : "Fork is available when the run finishes"
            }
            aria-label="Fork conversation from this point"
            data-testid="fork-from-message"
            disabled={!onForkFromMessage}
            onClick={() => onForkFromMessage?.(sourceMessageIndex, item.text)}
          >
            <ForkIcon />
            <span className="timeline-item__action-label">Fork</span>
          </button>
        </div>
      ) : null}
      {markers}
    </article>
  );
}

/** Subagent names shown under the working pill before the rest collapse into "and N more". */
const ACTIVITY_ENTRY_LIMIT = 4;

/** A working label carries a hidden bright copy for its shimmer (see timeline.css). */
function ActivityLabel({ label, working }: { readonly label: string; readonly working: boolean }) {
  return (
    <span className="timeline-activity__label">
      {label}
      {working ? (
        <span aria-hidden="true" className="timeline-activity__shine">
          <span>{label}</span>
        </span>
      ) : null}
    </span>
  );
}

function TimelineActivityItem({ item }: { readonly item: TimelineActivity }) {
  if (item.entries?.length) {
    const shown = item.entries.slice(0, ACTIVITY_ENTRY_LIMIT);
    const hidden = item.entries.length - shown.length;
    // The pill stays one short line; the names sit under it, one per line, cut with an ellipsis.
    return (
      <div className="timeline-activity-group">
        <div className={`timeline-activity timeline-activity--${item.tone ?? "neutral"}`}>
          {item.tone === "working" ? <StateOrb state={item.activityState ?? "solving"} /> : null}
          <ActivityLabel label={item.label} working={item.tone === "working"} />
        </div>
        <ul className="timeline-activity__entries">
          {shown.map((entry, index) => (
            <li key={`${index}:${entry}`} title={entry}>
              {entry}
            </li>
          ))}
          {hidden > 0 ? <li className="timeline-activity__more">and {hidden} more</li> : null}
        </ul>
      </div>
    );
  }
  return (
    <div className={`timeline-activity timeline-activity--${item.tone ?? "neutral"}`}>
      {item.tone === "working" ? <StateOrb state={item.activityState ?? "solving"} /> : null}
      {item.tone === "error" ? (
        <span className="timeline-activity__label">
          <ErrorText text={item.label} />
        </span>
      ) : (
        <ActivityLabel label={item.label} working={item.tone === "working"} />
      )}
      {item.detail ? <span className="timeline-activity__detail">{item.detail}</span> : null}
      {item.metadata ? <span className="timeline-activity__meta">{item.metadata}</span> : null}
    </div>
  );
}

function TimelineToolCallItem({
  item,
  expanded,
  onToggle,
  onViewFileInDiff,
}: {
  readonly item: TimelineToolCall;
  readonly expanded: boolean;
  readonly onToggle?: (callId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
}) {
  const hasContent = item.input !== undefined || item.output !== undefined;
  // An extension's tool shows the label it registered instead of a guess from its name.
  const extensionLabel = useExtensionToolLabel(item.toolName);
  const writeTool = isWriteTool(item.toolName);
  const diffText = writeTool ? extractDiffFromOutput(item.output) : undefined;
  const diffStats = diffText ? countDiffStats(diffText) : undefined;
  const compactLabel =
    extensionLabel === undefined ? item.label : extensionToolRowLabel(extensionLabel, item.input);
  const filePath = writeTool ? extractFilename(item.input) || undefined : undefined;
  const diffLanguage = diffText && filePath ? extensionToLanguage(filePath) : undefined;
  const inlineDetail = item.status === "error" ? item.detail : undefined;
  const images = toolOutputImages(item.output);

  const handleCopy = () => {
    const text = diffText ?? formatToolContent(item.input, item.output);
    void navigator.clipboard.writeText(text).catch((error: unknown) => {
      console.error("[renderer] navigator.clipboard.writeText failed", error);
    });
  };

  return (
    <article className={`timeline-tool timeline-tool--${item.status}`}>
      <div className="timeline-tool__header-row">
        <span className="timeline-tool__glyph" aria-hidden="true">
          {item.status === "running" ? (
            <StateOrb state={activityForTool(item.toolName).state} />
          ) : (
            toolGlyph(item.toolName)
          )}
        </span>
        <button
          className="timeline-tool__header"
          type="button"
          aria-expanded={expanded}
          disabled={!hasContent}
          onClick={() => onToggle?.(item.callId)}
        >
          {hasContent ? (
            <span
              className={`timeline-tool__chevron ${expanded ? "timeline-tool__chevron--expanded" : ""}`}
            >
              <ChevronRightIcon />
            </span>
          ) : null}
          <span className="timeline-tool__label" title={compactLabel}>
            {compactLabel}
          </span>
          {inlineDetail ? <span className="timeline-tool__detail">{inlineDetail}</span> : null}
          {diffStats ? (
            <span className="timeline-tool__diff-stats">
              <span className="timeline-tool__stat-add">+{diffStats.added}</span>{" "}
              <span className="timeline-tool__stat-del">−{diffStats.removed}</span>
            </span>
          ) : null}
          {/* A finished row needs no badge; the orb shows a running one, a dot marks a failure.
              The exact tool id stays on hover for anyone tracing which tool ran. */}
          <span className="timeline-tool__meta-inline" title={item.toolName}>
            {item.status === "error" ? (
              <span className="timeline-tool__status-pip" aria-hidden="true" />
            ) : null}
            {item.status === "success"
              ? humanToolName(item.toolName)
              : `${humanToolName(item.toolName)} · ${statusLabel(item.status)}`}
          </span>
        </button>
        {filePath && onViewFileInDiff ? (
          <button
            aria-label={`View ${filePath} in changes`}
            className="icon-button timeline-tool__view-in-diff"
            data-testid="timeline-tool-view-in-diff"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onViewFileInDiff(filePath);
            }}
          >
            <DiffIcon />
          </button>
        ) : null}
      </div>
      {images.length > 0 ? (
        // Shown while collapsed too: an image a tool made is a result in itself.
        <div className="timeline-tool__images" data-testid="timeline-tool-images">
          {images.map((image, index) => (
            <ImageAttachmentThumb
              className="timeline-tool__image"
              key={`${item.callId}:${index}`}
              name={`${humanToolName(item.toolName)} image ${index + 1}`}
              src={toolOutputImageSrc(image)}
            />
          ))}
        </div>
      ) : null}
      {expanded && hasContent ? (
        <div className="timeline-tool__body">
          {diffText ? (
            <>
              <div className="timeline-tool__diff-header">
                <span className="timeline-tool__diff-filename">
                  {extractFilename(item.input)}
                  {diffStats ? (
                    <span className="timeline-tool__diff-stats">
                      {" "}
                      <span className="timeline-tool__stat-add">+{diffStats.added}</span>{" "}
                      <span className="timeline-tool__stat-del">−{diffStats.removed}</span>
                    </span>
                  ) : null}
                </span>
                <button
                  className="icon-button timeline-tool__copy"
                  type="button"
                  onClick={handleCopy}
                  aria-label="Copy"
                >
                  <CopyIcon />
                </button>
              </div>
              <InlineDiff diff={diffText} language={diffLanguage} />
            </>
          ) : (
            <>
              <div className="timeline-tool__body-actions">
                <button
                  className="icon-button timeline-tool__copy"
                  type="button"
                  onClick={handleCopy}
                  aria-label="Copy"
                >
                  <CopyIcon />
                </button>
              </div>
              {readableToolInput(item.input) !== undefined ? (
                <pre className="timeline-tool__pre timeline-tool__pre--input">
                  {readableToolInput(item.input)}
                </pre>
              ) : null}
              {readableToolOutput(item.output) !== undefined ? (
                <pre className="timeline-tool__pre">{readableToolOutput(item.output)}</pre>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}

function isWriteTool(toolName: string): boolean {
  return /write|edit|patch|apply/i.test(toolName);
}

function toolGlyph(toolName: string) {
  if (isWriteTool(toolName)) {
    return <DiffIcon />;
  }
  if (/bash|shell|exec|terminal|command|run/i.test(toolName)) {
    return <TerminalIcon />;
  }
  if (/read|view|cat|open|file|glob|grep|search|ls/i.test(toolName)) {
    return <FileIcon />;
  }
  return <ExtensionIcon />;
}

function extractFilename(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    const path = record.file_path ?? record.filePath ?? record.path ?? record.filename;
    if (typeof path === "string") {
      return path;
    }
  }
  return "";
}

function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function formatToolContent(input: unknown, output: unknown): string {
  return [readableToolInput(input), readableToolOutput(output)]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

/**
 * Arguments as a person reads them: a shell command as `$ command`, other fields as `key: value`
 * with multi-line text kept as written, instead of escaped JSON.
 */
function readableToolInput(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return stringifyToolValue(input);
  const { command, ...rest } = input as Record<string, unknown>;
  const lines = typeof command === "string" ? [`$ ${command}`] : [];
  if (command !== undefined && typeof command !== "string") rest.command = command;
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    lines.push(
      typeof value === "string" ? `${key}: ${value}` : `${key}: ${stringifyToolValue(value)}`,
    );
  }
  return lines.join("\n");
}

/** A tool result's text parts verbatim (images show as thumbnails above); other shapes as JSON. */
function readableToolOutput(output: unknown): string | undefined {
  if (output === undefined) return undefined;
  if (typeof output === "string") return output;
  const content = (output as { content?: unknown } | null)?.content;
  if (Array.isArray(content) && content.length > 0) {
    const parts = content.map((part: unknown) => {
      const block = part as { type?: unknown; text?: unknown; mimeType?: unknown } | null;
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "image")
        return `[${typeof block.mimeType === "string" ? block.mimeType : "image"} image]`;
      return undefined;
    });
    if (parts.every((part) => part !== undefined)) return parts.join("\n");
  }
  return stringifyToolValue(output);
}

function statusLabel(status: "running" | "success" | "error") {
  if (status === "running") return "running";
  if (status === "success") return "done";
  return "failed";
}

function TimelineTurnMarkerItem({ item }: { readonly item: TimelineTurnMarker }) {
  return (
    <div className="timeline-turn-marker" data-testid="timeline-turn-marker">
      <span className="timeline-turn-marker__label">{`Worked for ${formatWorkedDuration(item.durationMs)}`}</span>
    </div>
  );
}

function formatWorkedDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function TimelineSummaryItem({ item }: { readonly item: TimelineSummary }) {
  if (item.presentation === "divider") {
    return (
      <div className="timeline-summary">
        <span>{item.label}</span>
        {item.metadata ? <span className="timeline-summary__meta">{item.metadata}</span> : null}
      </div>
    );
  }

  return (
    <div className="timeline-activity timeline-activity--summary">
      <span className="timeline-activity__label">{item.label}</span>
      {item.metadata ? <span className="timeline-activity__meta">{item.metadata}</span> : null}
    </div>
  );
}
