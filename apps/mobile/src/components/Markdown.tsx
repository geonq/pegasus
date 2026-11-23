import { memo, useMemo } from "react";
import { Linking, Platform } from "react-native";
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";
import { radius, spacing, text, usePalette } from "../theme";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });
// The native renderer takes a plain number for borders, not a hairline.
const HAIRLINE = 1;

/**
 * Assistant text: native markdown (T3's enriched-markdown fork) in the desktop's message styles,
 * colored from the theme tokens. `streaming` fades in only the newly appended tail while a run is
 * live, and holds back half-written tables and code blocks until they close.
 */
export const Markdown = memo(function Markdown({
  text: markdown,
  streaming = false,
}: {
  readonly text: string;
  readonly streaming?: boolean;
}) {
  const palette = usePalette();
  const style = useMemo<MarkdownStyle>(
    () => ({
      paragraph: { ...text.body, color: palette.text, lineHeight: 24, marginBottom: spacing.sm },
      h1: {
        ...text.title,
        color: palette.textStrong,
        marginTop: spacing.sm,
        marginBottom: spacing.sm,
      },
      h2: {
        ...text.title3,
        color: palette.textStrong,
        marginTop: spacing.sm,
        marginBottom: spacing.sm2,
      },
      h3: {
        ...text.headline,
        color: palette.textStrong,
        marginTop: spacing.xs,
        marginBottom: spacing.sm2,
      },
      strong: { color: palette.textStrong },
      list: {
        ...text.body,
        color: palette.text,
        lineHeight: 24,
        bulletColor: palette.textMuted,
        markerColor: palette.textMuted,
        itemSpacing: spacing.xs,
        marginBottom: spacing.sm,
      },
      blockquote: {
        color: palette.textMuted,
        borderColor: palette.lineStrong,
        borderWidth: 3,
        gapWidth: spacing.md2,
        marginBottom: spacing.sm,
      },
      code: {
        fontFamily: MONO,
        fontSize: text.footnote.fontSize,
        color: palette.textStrong,
        backgroundColor: palette.codeInline,
        borderColor: palette.borderLight,
      },
      codeBlock: {
        fontFamily: MONO,
        fontSize: text.footnote.fontSize,
        lineHeight: text.footnote.lineHeight,
        color: palette.text,
        backgroundColor: palette.codeBlock,
        borderColor: palette.borderDefault,
        borderWidth: HAIRLINE,
        borderRadius: radius.md2,
        padding: spacing.md,
        marginBottom: spacing.sm,
      },
      table: {
        fontSize: text.subheadline.fontSize,
        color: palette.text,
        headerTextColor: palette.textStrong,
        headerBackgroundColor: palette.surface,
        borderColor: palette.borderDefault,
        borderWidth: HAIRLINE,
        borderRadius: radius.sm,
        cellPaddingHorizontal: spacing.sm,
        cellPaddingVertical: spacing.sm2,
        marginBottom: spacing.sm,
      },
      taskList: {
        checkedColor: palette.accent,
        borderColor: palette.lineStrong,
        checkmarkColor: palette.onAccent,
        checkedTextColor: palette.textMuted,
      },
      thematicBreak: {
        color: palette.line,
        height: 1,
        marginTop: spacing.sm,
        marginBottom: spacing.sm,
      },
      link: { color: palette.accentText },
    }),
    [palette],
  );
  return (
    <EnrichedMarkdownText
      markdown={markdown}
      markdownStyle={style}
      flavor="github"
      selectable
      streamingAnimation={streaming}
      streamingConfig={{ tableMode: "hidden", codeBlockMode: "progressive" }}
      containerStyle={{ flexShrink: 1, minWidth: 0 }}
      onLinkPress={(event) => {
        Linking.openURL(event.url).catch(() => undefined);
      }}
    />
  );
});
