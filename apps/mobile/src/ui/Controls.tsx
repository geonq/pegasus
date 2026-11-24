import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { hitSize, maxFontScale, motion, radius, spacing, text, usePalette, weight } from "../theme";

/**
 * The Pegasus switch: a 48 x 28 pill, accent when on, the thumb springs across. Not the system
 * UISwitch. VoiceOver reads it as a switch with its label and state.
 */
export function Switch({
  value,
  onValueChange,
  accessibilityLabel,
  disabled,
}: {
  readonly value: boolean;
  readonly onValueChange: (next: boolean) => void;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
}) {
  const palette = usePalette();
  const reduceMotion = useReducedMotion();
  const on = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    on.value = reduceMotion
      ? withTiming(value ? 1 : 0, { duration: motion.fast })
      : withSpring(value ? 1 : 0, motion.spring);
  }, [on, reduceMotion, value]);
  const track = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(on.value, [0, 1], [palette.lineStrong, palette.accent]),
  }));
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: on.value * 20 }] }));
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        onValueChange(!value);
      }}
      style={disabled ? styles.disabled : null}
    >
      <Animated.View style={[styles.track, track]}>
        <Animated.View style={[styles.thumb, { backgroundColor: palette.onAccent }, thumb]} />
      </Animated.View>
    </Pressable>
  );
}

/**
 * A segmented control like the desktop's tab group: a muted track with a raised pill that slides
 * to the chosen segment. Exposed as tabs to VoiceOver.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  readonly options: readonly { readonly id: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (next: T) => void;
}) {
  const palette = usePalette();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );
  const segment = width > 0 ? (width - 4) / options.length : 0;
  const x = useSharedValue(0);
  useEffect(() => {
    x.value = reduceMotion ? index * segment : withSpring(index * segment, motion.spring);
  }, [index, reduceMotion, segment, x]);
  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <View
      accessibilityRole="tablist"
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.segments, { backgroundColor: palette.overlayHover }]}
    >
      {segment > 0 ? (
        <Animated.View
          style={[
            styles.segmentPill,
            {
              width: segment,
              backgroundColor: palette.surfaceElevated,
              borderColor: palette.borderDefault,
              shadowColor: palette.shadow,
            },
            pill,
          ]}
        />
      ) : null}
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={option.id}
            onPress={() => {
              if (selected) return;
              Haptics.selectionAsync().catch(() => undefined);
              onChange(option.id);
            }}
            style={styles.segment}
          >
            <Text
              maxFontSizeMultiplier={maxFontScale.chrome}
              numberOfLines={1}
              style={[
                text.footnote,
                {
                  color: selected ? palette.textStrong : palette.textMuted,
                  fontWeight: selected ? weight.semibold : weight.medium,
                },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export type DotStatus = "running" | "waiting" | "failed" | "unread" | "idle" | "offline";

/**
 * The desktop sidebar's status mark (sidebar.css .session-row__status): a turning ring while
 * running, solid dots for unseen (accent), failed (red) and waiting (amber). The ring stops under
 * Reduce Motion; the row's text still says "Working". Decorative: rows carry the words.
 */
export function StatusDot({
  status,
  size = 8,
}: {
  readonly status: DotStatus;
  readonly size?: number;
}) {
  const palette = usePalette();
  if (status === "running") return <Spinner size={size + 4} />;
  const color =
    status === "waiting"
      ? palette.warning
      : status === "failed"
        ? palette.danger
        : status === "unread"
          ? palette.accent
          : status === "offline"
            ? palette.statusNeutral
            : "transparent";
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
    />
  );
}

/** The desktop's running ring: two green quarters over a faint track, one turn per 900 ms. */
export function Spinner({ size = 12, color }: { readonly size?: number; readonly color?: string }) {
  const palette = usePalette();
  const reduceMotion = useReducedMotion();
  const turn = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(turn);
      turn.value = 0.125;
      return;
    }
    turn.value = 0;
    turn.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(turn);
  }, [reduceMotion, turn]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  const ink = color ?? palette.success;
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 2,
          borderColor: palette.borderHeavy,
          borderTopColor: ink,
          borderRightColor: ink,
        },
        spin,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.45 },
  track: { width: 48, height: 28, borderRadius: radius.pill, padding: 2 },
  thumb: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  segments: { flexDirection: "row", padding: 2, borderRadius: radius.md2 },
  segmentPill: {
    position: "absolute",
    top: 2,
    bottom: 2,
    left: 2,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  segment: {
    flex: 1,
    minHeight: hitSize.compact + 4,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  },
});
