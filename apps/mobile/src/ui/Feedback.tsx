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
import { Icon, type IconName } from "./Icon";

/**
 * A centred message for an empty list or screen: what happened, what to do, and the action that
 * does it. The icon is decorative; the title carries the meaning.
 */
export function EmptyState({
  title,
  message,
  action,
  icon,
}: {
  readonly title: string;
  readonly message?: string;
  readonly action?: ReactNode;
  readonly icon?: IconName;
}) {
  const palette = usePalette();
  return (
    <View style={styles.empty}>
      {icon ? (
        <View style={styles.icon}>
          <Icon name={icon} color={palette.textSoft} size={34} weight="regular" />
        </View>
      ) : null}
      <Text
        accessibilityRole="header"
        style={[text.headline, styles.center, { color: palette.textStrong }]}
      >
        {title}
      </Text>
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

const styles = StyleSheet.create({
  empty: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  center: { textAlign: "center" },
  icon: { marginBottom: spacing.xs },
  action: { marginTop: spacing.sm },
});
