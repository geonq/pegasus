import { useEffect, useState } from "react";
import { formatDuration } from "../../api/worklog";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { GlassCard, PressableScale } from "../../ui";
import { hitSize, maxFontScale, motion, radius, spacing, text, usePalette } from "../../theme";

const ENTER = FadeIn.duration(motion.slow).reduceMotion(ReduceMotion.System);
const EXIT = FadeOut.duration(motion.fast).reduceMotion(ReduceMotion.System);

/**
 * What floats just above the composer, like T3's floating working control: a "Working" pill with
 * the elapsed time and current step while the run is live, and a jump-to-latest button once the
 * person has scrolled up. Both sit on the shared glass so the transcript reads through neither.
 */
export function FloatingStatus({
  working,
  showJump,
  onJump,
}: {
  /** When the run started (epoch ms) and its current step; null when idle. */
  readonly working: { readonly since: number; readonly step?: string } | null;
  readonly showJump: boolean;
  readonly onJump: () => void;
}) {
  const palette = usePalette();
  // The clock lives here, so only this pill re-renders every second, not the transcript.
  const [now, setNow] = useState(() => Date.now());
  const since = working?.since;
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!working && !showJump) return null;
  const elapsed = working ? formatDuration(now - working.since) : "";
  return (
    <View pointerEvents="box-none" style={styles.row}>
      {working ? (
        <Animated.View entering={ENTER} exiting={EXIT} style={styles.shrink}>
          <GlassCard padded={false} style={styles.pill}>
            <View
              accessibilityLabel={`Working${working.step ? `, ${working.step}` : ""}`}
              accessibilityLiveRegion="polite"
              accessible
              style={styles.pillInner}
            >
              <PulseDot />
              <Text
                maxFontSizeMultiplier={maxFontScale.chrome}
                numberOfLines={1}
                style={[text.footnote, styles.flexText, { color: palette.text }]}
              >
                <Text style={styles.semibold}>Working</Text>
                <Text style={{ color: palette.textMuted }}>
                  {` · ${elapsed}${working.step ? ` · ${working.step}` : ""}`}
                </Text>
              </Text>
            </View>
          </GlassCard>
        </Animated.View>
      ) : (
        <View style={styles.shrink} />
      )}
      {showJump ? (
        <Animated.View entering={ENTER} exiting={EXIT}>
          <GlassCard padded={false} style={styles.jump}>
            <PressableScale
              accessibilityLabel="Jump to latest"
              accessibilityRole="button"
              onPress={onJump}
              pressedStyle={{ backgroundColor: palette.overlayActive }}
              style={styles.jumpInner}
            >
              <Text
                maxFontSizeMultiplier={maxFontScale.chrome}
                style={[text.headline, { color: palette.text }]}
              >
                ↓
              </Text>
            </PressableScale>
          </GlassCard>
        </Animated.View>
      ) : null}
    </View>
  );
}

/** Pulses while working; with Reduce Motion it holds still (the label already says Working). */
function PulseDot() {
  const palette = usePalette();
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(opacity);
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(withTiming(0.3, { duration: 800 }), -1, true);
    return () => cancelAnimation(opacity);
  }, [opacity, reduceMotion]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.dot, { backgroundColor: palette.accent }, animated]} />;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.gutter,
    paddingBottom: spacing.xs,
  },
  shrink: { flexShrink: 1, flexGrow: 1, alignItems: "flex-start" },
  pill: { borderRadius: radius.pill, maxWidth: "100%" },
  pillInner: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  flexText: { flexShrink: 1 },
  semibold: { fontWeight: "600" },
  dot: { width: 8, height: 8, borderRadius: radius.pill },
  jump: { borderRadius: radius.pill },
  jumpInner: {
    width: hitSize.min,
    height: hitSize.min,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
