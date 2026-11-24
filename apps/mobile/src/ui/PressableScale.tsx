import { useState, type ReactNode, type Ref } from "react";
import {
  Pressable,
  type HostInstance,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { motion } from "../theme";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PressableScaleProps extends Omit<PressableProps, "style" | "children"> {
  readonly style?: StyleProp<ViewStyle>;
  /** Drawn while pressed, over `style` (usually an overlay background). */
  readonly pressedStyle?: StyleProp<ViewStyle>;
  readonly children?: ReactNode;
  readonly ref?: Ref<HostInstance>;
}

/**
 * The desktop's press state on a phone: shrinks to 0.97 in 120 ms (--motion-fast). With Reduce
 * Motion on it skips the scale and only shows `pressedStyle`.
 */
export function PressableScale({
  style,
  pressedStyle,
  children,
  onPressIn,
  onPressOut,
  ref,
  ...rest
}: PressableScaleProps) {
  const reduceMotion = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      {...rest}
      ref={ref}
      onPressIn={(event) => {
        setPressed(true);
        if (!reduceMotion) {
          scale.value = withTiming(motion.pressScale, {
            duration: motion.fast,
            easing: motion.easeOut,
          });
        }
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        scale.value = withTiming(1, { duration: motion.base, easing: motion.easeOut });
        onPressOut?.(event);
      }}
      // A plain array: Reanimated reads animated styles from it, not from a style callback.
      style={[style, pressed ? pressedStyle : null, animated]}
    >
      {children}
    </AnimatedPressable>
  );
}
