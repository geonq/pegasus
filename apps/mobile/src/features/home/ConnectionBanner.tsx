import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import type { StreamStatus } from "../../api/client";
import { usePegasus } from "../../state/PegasusProvider";
import { hitSize, radius, spacing, text, usePalette } from "../../theme";

/** What the banner says for a stream status, or null when the phone is live. */
export function connectionLine(
  status: StreamStatus,
  hostName: string,
  hasState: boolean,
): string | null {
  switch (status.state) {
    case "live":
      return null;
    case "connecting":
      return hasState ? `Reconnecting to ${hostName}…` : `Connecting to ${hostName}…`;
    case "retrying":
      return `${status.reason} Retrying in ${Math.max(1, Math.round(status.inMs / 1000))} s.`;
    case "revoked":
      return status.reason;
  }
}

/**
 * Above the chat list while the phone is not live: what is happening, and a way out (retry now, or
 * pair again when the key was revoked). The list below keeps the last state.
 */
export function ConnectionBanner() {
  const palette = usePalette();
  const { status, pairing, state, refresh, forget } = usePegasus();
  const line = connectionLine(status, pairing?.hostName ?? "your PC", state !== null);
  if (!line) return null;
  const offline = status.state === "retrying" || status.state === "revoked";
  const action =
    status.state === "revoked"
      ? {
          label: "Pair again",
          run: () =>
            forget().catch((reason: unknown) => Alert.alert("Could not unpair", String(reason))),
        }
      : status.state === "retrying"
        ? { label: "Retry", run: () => refresh().catch(() => undefined) }
        : null;
  return (
    <View
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: offline ? palette.warningTint : palette.surface }]}
    >
      {offline ? null : <ActivityIndicator size="small" color={palette.textMuted} />}
      <Text
        style={[
          text.footnote,
          styles.line,
          { color: offline ? palette.warningText : palette.textMuted },
        ]}
      >
        {line}
        {state && offline ? " Showing the last update." : ""}
      </Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={10}
          onPress={action.run}
          style={styles.action}
        >
          <Text style={[text.footnote, styles.actionText, { color: palette.accentText }]}>
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md2,
  },
  line: { flex: 1 },
  action: { minHeight: hitSize.compact, justifyContent: "center" },
  actionText: { fontWeight: "600" },
});
