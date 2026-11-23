import type { NativeStackHeaderItemMenu } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { StyleSheet, Text, View } from "react-native";
import type { MenuSection } from "../../ui";
import { maxFontScale, spacing, text, usePalette } from "../../theme";

export type ChatStatus = "working" | "waiting" | "failed" | "idle" | "offline";

/** The navigation bar's title: the chat's title over its status, project and model. */
export function ChatTitle({
  title,
  subtitle,
  status,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly status: ChatStatus;
}) {
  const palette = usePalette();
  const [dot, label] =
    status === "working"
      ? [palette.success, "Working"]
      : status === "waiting"
        ? [palette.warning, "Needs you"]
        : status === "failed"
          ? [palette.danger, "Stopped with an error"]
          : status === "offline"
            ? [palette.statusNeutral, "Offline"]
            : [null, ""];
  return (
    <View
      accessibilityLabel={[title, label, subtitle].filter(Boolean).join(", ")}
      accessibilityRole="header"
      accessible
      style={styles.title}
    >
      <Text
        maxFontSizeMultiplier={maxFontScale.chrome}
        numberOfLines={1}
        style={[text.headline, { color: palette.textStrong }]}
      >
        {title}
      </Text>
      <View style={styles.subtitle}>
        {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
        <Text
          maxFontSizeMultiplier={maxFontScale.chrome}
          numberOfLines={1}
          style={[text.caption, styles.subtitleText, { color: palette.textMuted }]}
        >
          {label ? `${label} · ` : ""}
          {subtitle}
        </Text>
      </View>
    </View>
  );
}

/**
 * The bar's ellipsis button: a native UIMenu on the bar button item itself (react-native-screens),
 * so it opens like Mail's or Notes'. Each section is an inline group, divided from the next.
 */
export function chatMenuItem(sections: readonly MenuSection[]): NativeStackHeaderItemMenu {
  return {
    type: "menu",
    label: "Chat actions",
    accessibilityLabel: "Chat actions",
    icon: { type: "sfSymbol", name: "ellipsis.circle" },
    menu: {
      items: sections
        .filter((section) => section.items.length > 0)
        .map((section) => ({
          type: "submenu" as const,
          label: section.title ?? "",
          inline: true,
          items: section.items.map((item) => ({
            type: "action" as const,
            label: item.label,
            ...(item.icon ? { icon: { type: "sfSymbol" as const, name: item.icon as never } } : {}),
            ...(item.destructive ? { destructive: true } : {}),
            ...(item.disabled ? { disabled: true } : {}),
            ...(item.selected !== undefined
              ? { state: item.selected ? ("on" as const) : ("off" as const) }
              : {}),
            onPress: () => {
              Haptics.selectionAsync().catch(() => undefined);
              item.onPress();
            },
          })),
        })),
    },
  };
}

const styles = StyleSheet.create({
  title: { alignItems: "center", maxWidth: 240 },
  subtitle: { flexDirection: "row", alignItems: "center", gap: spacing.xs, maxWidth: "100%" },
  subtitleText: { flexShrink: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
