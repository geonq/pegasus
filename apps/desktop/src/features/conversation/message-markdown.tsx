import { Fragment, memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  remarkWorkspaceFileLines,
  workspaceFileLineFromAnchorProps,
  type WorkspaceFileLine,
} from "./workspace-file-line";
import { MermaidDiagram } from "../generative-ui/diagram-view";
import { HighlightedLine } from "../../ui/highlighted-line";
import { fenceToLanguage } from "../../ui/syntax-highlight";
import { CopyButton } from "../../ui/copy-button";

interface HastLike {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly HastLike[];
}

function hastText(node: HastLike | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

const REMARK_PLUGINS = [remarkGfm];

function markdownComponents(
  onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void,
): Components {
  return {
    code: ({ className, children }) => {
      const code = String(children).replace(/\n$/, "");
      // Tokenise the complete fence so comments, strings and template constructs retain state across lines.
      const language = /(?:^|\s)language-([\w+#.-]+)/u.exec(className ?? "")?.[1];
      const grammar = language ? fenceToLanguage(language) : undefined;
      if (grammar) {
        const lines = code.split("\n");
        if (lines.length > 0) {
          return (
            <code className={className} data-highlighted="">
              {lines.map((line, index) => (
                <Fragment key={index}>
                  {index > 0 ? "\n" : null}
                  <HighlightedLine content={line} language={grammar} source={lines} lineIndex={index} />
                </Fragment>
              ))}
            </code>
          );
        }
      }
      return <code className={className}>{code}</code>;
    },
    a: ({ href, children, ...props }) => {
      const file = onOpenWorkspaceFileLine ? workspaceFileLineFromAnchorProps(props) : null;
      if (file && onOpenWorkspaceFileLine) {
        return (
          <button
            className="message__file-link"
            data-end-line={file.endLine}
            data-line={file.line}
            data-path={file.path}
            data-testid="workspace-file-link"
            type="button"
            onClick={() => onOpenWorkspaceFileLine(file)}
          >
            {children}
          </button>
        );
      }
      return (
        <a href={href} rel="noreferrer" target="_blank">
          {children}
        </a>
      );
    },
    // A ```mermaid block in a reply is drawn as its diagram, the same way show_ui draws one.
    pre: ({ children, node }) => {
      const first = node?.children[0];
      const classes = first?.type === "element" ? first.properties.className : undefined;
      if (
        first?.type === "element" &&
        Array.isArray(classes) &&
        classes.includes("language-mermaid")
      ) {
        const source = first.children
          .map((child) => (child.type === "text" ? child.value : ""))
          .join("");
        return <MermaidDiagram source={source.trimEnd()} />;
      }
      // Each fence carries its own copy target (T3 MarkdownCodeBlock, Orca NativeChatCodeBlock),
      // shown on hover or focus so resting replies stay quiet.
      const code = hastText(first as HastLike | undefined).replace(/\n$/, "");
      return (
        <div className="message__code-block">
          <pre>{children}</pre>
          {code ? (
            <CopyButton
              className="message__code-copy"
              label="Copy code"
              testId="code-block-copy"
              text={code}
            />
          ) : null}
        </div>
      );
    },
    table: ({ children }) => (
      <div className="message__table-scroll">
        <table>{children}</table>
      </div>
    ),
  };
}

const PLAIN_MARKDOWN_COMPONENTS = markdownComponents();

// Memoized: remark parsing is the dominant render cost on long threads, and the
// timeline re-renders on every streaming tick. `text` is a string, so shallow
// comparison skips the re-parse for every message except the one still growing.
export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  workspacePath,
  onOpenWorkspaceFileLine,
  annotationRoot = false,
}: {
  readonly text: string;
  /** Marks this text as what transcript annotations anchor to. */
  readonly annotationRoot?: boolean;
  readonly workspacePath?: string;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
}) {
  const components = useMemo(
    () =>
      onOpenWorkspaceFileLine
        ? markdownComponents(onOpenWorkspaceFileLine)
        : PLAIN_MARKDOWN_COMPONENTS,
    [onOpenWorkspaceFileLine],
  );
  const remarkPlugins = useMemo(
    () =>
      onOpenWorkspaceFileLine
        ? [remarkGfm, remarkWorkspaceFileLines(workspacePath ?? null)]
        : REMARK_PLUGINS,
    [onOpenWorkspaceFileLine, workspacePath],
  );
  return (
    <div className="message__content" data-annotation-root={annotationRoot ? "" : undefined}>
      <ReactMarkdown components={components} remarkPlugins={remarkPlugins}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
