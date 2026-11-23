import * as Haptics from "expo-haptics";
import { ActionSheetIOS, Alert, Platform, StyleSheet, Text, View } from "react-native";
import { PressableScale } from "../../ui";
import { hitSize, maxFontScale, spacing, text, usePalette } from "../../theme";

export interface ChatMenuItem {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}

/** The navigation bar's title: the chat's title over its project, model and status. */
export function ChatTitle({
  title,
  subtitle,
  status,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly status: "working" | "waiting" | "failed" | "idle" | "offline";
}) {
  const palette = usePalette();
  const [dot, label] =
    status === "working"
      ? [palette.accent, "Working"]
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
          style={[text.caption, { color: palette.textMuted }]}
        >
          {label && status !== "idle" ? `${label} · ` : ""}
          {subtitle}
        </Text>
      </View>
    </View>
  );
}

/** The ••• button: a native action sheet of the chat's actions. */
export function ChatMenuButton({ items }: { readonly items: readonly ChatMenuItem[] }) {
  const palette = usePalette();
  const open = () => {
    Haptics.selectionAsync().catch(() => undefined);
    const labels = items.map((item) => item.label);
    const destructive = items.findIndex((item) => item.destructive);
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...labels, "Cancel"],
          cancelButtonIndex: labels.length,
          ...(destructive >= 0 ? { destructiveButtonIndex: destructive } : {}),
        },
        (index) => items[index]?.onPress(),
      );
    } else {
      Alert.alert("Chat", undefined, [
        ...items.map((item) => ({
          text: item.label,
          style: item.destructive ? ("destructive" as const) : ("default" as const),
          onPress: item.onPress,
        })),
        { text: "Cancel", style: "cancel" as const },
      ]);
    }
  };
  return (
    <PressableScale
      accessibilityLabel="Chat actions"
      accessibilityRole="button"
      hitSlop={4}
      onPress={open}
      style={styles.menu}
    >
      <Text maxFontSizeMultiplier={maxFontScale.chrome} style={[text.headline, { color: palette.accentText }]}>
        •••
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  title: { alignItems: "center", maxWidth: 240 },
  subtitle: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  dot: { width: 6, height: 6, borderRadius: 3 },
  menu: { minWidth: hitSize.min, minHeight: hitSize.min, alignItems: "flex-end", justifyContent: "center" },
});
