import { useEffect, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { FullWindowOverlay } from "react-native-screens";
import { scheduleOnRN } from "react-native-worklets";
import { motion, usePalette } from "../theme";

/**
 * A full-screen page that slides up over everything (the file diff, git actions, the camera), in
 * place of the system Modal. It keeps its content mounted until it has slid away; Reduce Motion
 * fades it instead. The content draws its own TopBar with a way out.
 */
export function Layer({
  visible,
  children,
  dark,
}: {
  readonly visible: boolean;
  readonly children: ReactNode;
  /** A black page in both schemes (the camera). */
  readonly dark?: boolean;
}) {
  const palette = usePalette();
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  const shown = useSharedValue(0);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      shown.value = reduceMotion
        ? withTiming(1, { duration: motion.base })
        : withSpring(1, motion.spring);
    } else {
      shown.value = withTiming(
        0,
        { duration: motion.slow, easing: Easing.out(Easing.quad) },
        (finished) => {
          if (finished) scheduleOnRN(setMounted, false);
        },
      );
    }
  }, [reduceMotion, shown, visible]);
  const style = useAnimatedStyle(() => ({
    opacity: reduceMotion ? shown.value : 1,
    transform: [{ translateY: reduceMotion ? 0 : (1 - shown.value) * 900 }],
  }));
  if (!mounted) return null;
  const page = (
    <Animated.View
      accessibilityViewIsModal
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: dark ? "#000" : palette.background },
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
  return Platform.OS === "ios" ? (
    <FullWindowOverlay>
      <View style={StyleSheet.absoluteFill}>{page}</View>
    </FullWindowOverlay>
  ) : (
    page
  );
}
