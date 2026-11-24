import { StyleSheet, Text, View } from "react-native";
import { StatusDot, type DotStatus } from "../../ui";
import { maxFontScale, spacing, text, usePalette } from "../../theme";

export type ChatStatus = "working" | "waiting" | "failed" | "idle" | "offline";

const DOTS: Record<ChatStatus, DotStatus> = {
  working: "running",
  waiting: "waiting",
  failed: "failed",
  idle: "idle",
  offline: "offline",
};

/** The top bar's title: the chat's title over its status mark, project and model. */
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
  const label =
    status === "working"
      ? "Working"
      : status === "waiting"
        ? "Needs you"
        : status === "failed"
          ? "Stopped with an error"
          : status === "offline"
            ? "Offline"
            : "";
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
        {status !== "idle" ? <StatusDot size={6} status={DOTS[status]} /> : null}
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

const styles = StyleSheet.create({
  title: { alignItems: "center", maxWidth: "100%" },
  subtitle: { flexDirection: "row", alignItems: "center", gap: spacing.xs, maxWidth: "100%" },
  subtitleText: { flexShrink: 1 },
});
