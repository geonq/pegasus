import * as Updates from "expo-updates";
import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { hitSize, radius, spacing, text, usePalette } from "../../theme";
import { GlassCard } from "../../ui";
import { shouldCheck } from "./update-check";

/**
 * Over-the-air updates from the PC (see scripts/publish-update.mjs). expo-updates checks on launch
 * by itself; this also checks on every return to the foreground, downloads in the background and,
 * once an update is ready, offers a restart. Ignoring it is fine: the update starts next launch.
 */
export function UpdatePrompt() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { isUpdatePending } = Updates.useUpdates();
  const [dismissed, setDismissed] = useState(false);
  const lastCheck = useRef(Date.now());

  useEffect(() => {
    // Dev builds load JS from Metro and have no update server to ask.
    if (!Updates.isEnabled || __DEV__) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !shouldCheck(lastCheck.current, Date.now())) return;
      lastCheck.current = Date.now();
      Updates.checkForUpdateAsync()
        .then((r) => (r.isAvailable ? Updates.fetchUpdateAsync() : undefined))
        // Offline or the PC is asleep: the next foreground tries again.
        .catch(() => undefined);
    });
    return () => sub.remove();
  }, []);

  if (!isUpdatePending || dismissed) return null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + spacing.md }]}>
      <GlassCard style={styles.card}>
        <View accessibilityRole="summary" accessibilityLiveRegion="polite" style={styles.row}>
          <Text style={[text.subheadline, styles.line, { color: palette.text }]}>Update ready</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Later"
            hitSlop={8}
            onPress={() => setDismissed(true)}
            style={styles.action}
          >
            <Text style={[text.subheadline, { color: palette.textMuted }]}>Later</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Restart to update"
            hitSlop={8}
            onPress={() => Updates.reloadAsync().catch(() => setDismissed(true))}
            style={styles.action}
          >
            <Text style={[text.subheadline, styles.strong, { color: palette.accentText }]}>Restart</Text>
          </Pressable>
        </View>
      </GlassCard>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: spacing.lg, right: spacing.lg },
  card: { borderRadius: radius.md2, paddingVertical: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  line: { flex: 1 },
  action: { minHeight: hitSize.min, justifyContent: "center" },
  strong: { fontWeight: "600" },
});
