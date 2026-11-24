import * as Haptics from "expo-haptics";
import { useCallback, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { maxFontScale, motion, spacing, text, weight } from "../theme";
import { Icon, type IconName } from "./Icon";

export interface SwipeAction {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly fill: string;
  readonly ink: string;
  readonly onPress: () => void;
}

const ACTION_WIDTH = 72;

/**
 * A list row with swipe actions drawn by Pegasus: drag left for `trailing` actions, right for
 * `leading` ones. The row follows the finger, rubber-bands past the actions, and on release snaps
 * open or shut by where the flick was heading (position + velocity). A long pull past half the
 * row runs the first action, like Mail. Only horizontal drags are taken, so the list still scrolls.
 * Every action must also be reachable without the gesture (long-press menu, VoiceOver actions).
 */
export function SwipeRow({
  leading = [],
  trailing = [],
  children,
  style,
}: {
  readonly leading?: readonly SwipeAction[];
  readonly trailing?: readonly SwipeAction[];
  readonly children: ReactNode;
  /** The clip shape (corners) of the row. */
  readonly style?: StyleProp<ViewStyle>;
}) {
  const x = useSharedValue(0);
  const start = useSharedValue(0);
  const width = useSharedValue(0);
  const armed = useSharedValue(0);
  const leftOpen = leading.length * ACTION_WIDTH;
  const rightOpen = trailing.length * ACTION_WIDTH;

  const tick = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  }, []);
  const runFirst = useCallback(
    (side: "leading" | "trailing") => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      (side === "leading" ? leading : trailing)[0]?.onPress();
    },
    [leading, trailing],
  );

  const pan = usePanGesture({
    activeOffsetX: [-12, 12],
    failOffsetY: [-10, 10],
    onBegin: () => {
      "worklet";
      start.value = x.value;
    },
    onUpdate: (event) => {
      "worklet";
      const raw = start.value + event.translationX;
      const max = leftOpen;
      const min = -rightOpen;
      // Past the actions the row keeps moving with growing resistance.
      const band = (over: number) => (over * 0.55 * 120) / (120 + 0.55 * Math.abs(over));
      let next = raw;
      if (raw > max) next = max === 0 ? band(raw) * 0.3 : max + band(raw - max);
      if (raw < min) next = min === 0 ? band(raw) * 0.3 : min + band(raw - min);
      x.value = next;
      const full = width.value * 0.5;
      const nowArmed = (max > 0 && raw > full) || (min < 0 && raw < -full) ? 1 : 0;
      if (nowArmed !== armed.value) {
        armed.value = nowArmed;
        scheduleOnRN(tick);
      }
    },
    onDeactivate: (event) => {
      "worklet";
      const projected = x.value + event.velocityX * 0.15;
      if (armed.value === 1) {
        armed.value = 0;
        scheduleOnRN(runFirst, x.value > 0 ? "leading" : "trailing");
        x.value = withSpring(0, { ...motion.springFlick, velocity: event.velocityX });
        return;
      }
      let target = 0;
      if (projected > leftOpen / 2 && leftOpen > 0) target = leftOpen;
      else if (projected < -rightOpen / 2 && rightOpen > 0) target = -rightOpen;
      x.value = withSpring(target, { ...motion.springFlick, velocity: event.velocityX });
    },
  });

  const row = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const close = () => {
    x.value = withSpring(0, motion.spring);
  };

  return (
    <View
      onLayout={(event) => {
        width.value = event.nativeEvent.layout.width;
      }}
      style={[styles.wrap, style]}
    >
      {leading.length > 0 ? <Actions actions={leading} close={close} side="leading" x={x} /> : null}
      {trailing.length > 0 ? (
        <Actions actions={trailing} close={close} side="trailing" x={x} />
      ) : null}
      <GestureDetector gesture={pan}>
        <Animated.View style={row}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

function Actions({
  actions,
  side,
  x,
  close,
}: {
  readonly actions: readonly SwipeAction[];
  readonly side: "leading" | "trailing";
  readonly x: SharedValue<number>;
  readonly close: () => void;
}) {
  const total = actions.length * ACTION_WIDTH;
  // Actions slide in with the row instead of sitting still under it.
  const style = useAnimatedStyle(() => {
    const shown = side === "leading" ? Math.max(0, x.value) : Math.max(0, -x.value);
    const progress = Math.min(1, shown / total);
    return {
      opacity: shown > 0 ? 1 : 0,
      transform: [{ translateX: (side === "leading" ? -1 : 1) * (1 - progress) * total * 0.4 }],
    };
  });
  return (
    <Animated.View style={[styles.actions, side === "leading" ? styles.left : styles.right, style]}>
      {actions.map((action) => (
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          key={action.id}
          onPress={() => {
            close();
            action.onPress();
          }}
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: action.fill, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Icon color={action.ink} name={action.icon} size={17} />
          <Text
            maxFontSizeMultiplier={maxFontScale.chrome}
            numberOfLines={1}
            style={[text.caption2, { color: action.ink, fontWeight: weight.semibold }]}
          >
            {action.label}
          </Text>
        </Pressable>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: "hidden" },
  actions: { position: "absolute", top: 0, bottom: 0, flexDirection: "row" },
  left: { left: 0 },
  right: { right: 0 },
  action: {
    width: ACTION_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
});
