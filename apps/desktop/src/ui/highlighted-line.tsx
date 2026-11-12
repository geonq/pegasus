import { useMemo } from "react";
import { useActiveTheme } from "./active-theme";
import { highlightLine, highlightLines, useHighlighterReady } from "./syntax-highlight";

/** One line of code coloured by the active theme's syntax theme. */
export function HighlightedLine({
  content,
  language,
  source,
  lineIndex,
}: {
  readonly content: string;
  readonly language: string;
  readonly source?: readonly string[];
  readonly lineIndex?: number;
}) {
  const { syntaxTheme } = useActiveTheme();
  const ready = useHighlighterReady();
  const tokens = useMemo(() => {
    if (!ready) return null;
    if (source !== undefined && lineIndex !== undefined) {
      return highlightLines(source.join("\n"), language, syntaxTheme)?.[lineIndex] ?? null;
    }
    return highlightLine(content, language, syntaxTheme);
  }, [content, language, syntaxTheme, ready, source, lineIndex]);
  if (!tokens) return <>{content}</>;
  return (
    <>
      {tokens.map((token, index) =>
        token.color || token.fontStyle ? (
          <span key={index} style={{ color: token.color, fontStyle: token.fontStyle }}>
            {token.content}
          </span>
        ) : (
          token.content
        ),
      )}
    </>
  );
}
