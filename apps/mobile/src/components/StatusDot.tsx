import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import type { ChatSection } from "../api/chats";
import { usePalette } from "../theme";

/** A chat's state at a glance: pulsing while it works (unless Reduce Motion is on). */
export function StatusDot({ section }: { readonly section: ChatSection }) {
  const palette = usePalette();
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  const working = section === "working";

  useEffect(() => {
    if (working && !reduceMotion) {
      opacity.value = withRepeat(withTiming(0.35, { duration: 700 }), -1, true);
    } else {
      cancelAnimation(opacity);
      opacity.value = 1;
    }
  }, [working, reduceMotion, opacity]);

  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const color =
    section === "needs-you"
      ? palette.warning
      : section === "working"
        ? palette.accent
        : palette.line;
  return <Animated.View style={[styles.dot, { backgroundColor: color }, animated]} />;
}

const styles = StyleSheet.create({
  dot: { width: 8, height: 8, borderRadius: 4 },
});
