import { memo, useMemo } from "react";
import { Linking } from "react-native";
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";
import { usePalette, type } from "../theme";

/** Assistant text: native markdown (T3's enriched-markdown fork), colored from the theme tokens. */
export const Markdown = memo(function Markdown({ text }: { readonly text: string }) {
  const palette = usePalette();
  const style = useMemo<MarkdownStyle>(
    () => ({
      paragraph: { color: palette.text, fontSize: type.body, lineHeight: 23, marginBottom: 8 },
      h1: { color: palette.text, fontSize: 22, fontWeight: "700", marginBottom: 8 },
      h2: { color: palette.text, fontSize: 19, fontWeight: "700", marginBottom: 6 },
      h3: { color: palette.text, fontSize: 17, fontWeight: "600", marginBottom: 6 },
      list: {
        color: palette.text,
        fontSize: type.body,
        bulletColor: palette.textMuted,
        itemSpacing: 4,
      },
      blockquote: {
        color: palette.textMuted,
        borderColor: palette.line,
        borderWidth: 3,
        gapWidth: 10,
      },
      codeBlock: {
        color: palette.text,
        backgroundColor: palette.surfaceRaised,
        borderRadius: 10,
        padding: 12,
        fontSize: 13,
      },
      link: { color: palette.accent },
    }),
    [palette],
  );
  return (
    <EnrichedMarkdownText
      markdown={text}
      markdownStyle={style}
      flavor="github"
      selectable
      containerStyle={{ flexShrink: 1, minWidth: 0 }}
      onLinkPress={(event) => {
        Linking.openURL(event.url).catch(() => undefined);
      }}
    />
  );
});
