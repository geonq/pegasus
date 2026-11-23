import { useEffect, type ReactNode } from "react";
import { StyleSheet, Text, View, type DimensionValue } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { radius, spacing, text, usePalette } from "../theme";

/** A centred message for an empty list or screen, with an optional action under it. */
export function EmptyState({
  title,
  message,
  action,
}: {
  readonly title: string;
  readonly message?: string;
  readonly action?: ReactNode;
}) {
  const palette = usePalette();
  return (
    <View style={styles.empty}>
      <Text style={[text.headline, styles.center, { color: palette.textStrong }]}>{title}</Text>
      {message ? (
        <Text style={[text.subheadline, styles.center, { color: palette.textMuted }]}>
          {message}
        </Text>
      ) : null}
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

/**
 * A placeholder block while content loads: a soft pulse (opacity only), still with Reduce Motion.
 * Hidden from VoiceOver; put an accessibilityLabel such as "Loading" on the container instead.
 */
export function Skeleton({
  width = "100%",
  height = 14,
  rounded = radius.sm2,
}: {
  readonly width?: DimensionValue;
  readonly height?: number;
  readonly rounded?: number;
}) {
  const palette = usePalette();
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(opacity);
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(withTiming(0.5, { duration: 900 }), -1, true);
    return () => cancelAnimation(opacity);
  }, [reduceMotion, opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { width, height, borderRadius: rounded, backgroundColor: palette.overlayActive },
        animated,
      ]}
    />
  );
}

/** The title row of a sheet: a grabber, a title and an optional trailing action (e.g. Done). */
export function SheetHeader({
  title,
  subtitle,
  trailing,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly trailing?: ReactNode;
}) {
  const palette = usePalette();
  return (
    <View style={styles.sheet}>
      <View style={[styles.grabber, { backgroundColor: palette.lineStrong }]} />
      <View style={styles.sheetRow}>
        <View style={styles.sheetTitles}>
          <Text accessibilityRole="header" style={[text.headline, { color: palette.textStrong }]}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[text.footnote, { color: palette.textMuted }]}>{subtitle}</Text>
          ) : null}
        </View>
        {trailing}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  center: { textAlign: "center" },
  action: { marginTop: spacing.sm },
  sheet: {
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: radius.pill },
  sheetRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  sheetTitles: { flex: 1, gap: 2 },
});
