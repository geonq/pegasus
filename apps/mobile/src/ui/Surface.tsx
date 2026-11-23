import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { AccessibilityInfo, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useEffect, useState } from "react";
import { elevation, material, radius, spacing, usePalette, useScheme } from "../theme";

export interface SurfaceProps {
  /**
   * muted: a card on the background (--surface-muted, like the desktop's user bubble and settings
   * groups). elevated: a raised card (--surface + --shadow-sm). float: the desktop's floating card
   * (--float-fill, --float-radius, --float-shadow).
   */
  readonly tone?: "muted" | "elevated" | "float";
  readonly padded?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: ReactNode;
}

/** A card in one of the desktop's three surface tones. */
export function Surface({ tone = "muted", padded = true, style, children }: SurfaceProps) {
  const palette = usePalette();
  const scheme = useScheme();
  const toneStyle: ViewStyle =
    tone === "muted"
      ? { backgroundColor: palette.surface, borderRadius: radius.md }
      : tone === "elevated"
        ? {
            backgroundColor: palette.surfaceElevated,
            borderRadius: radius.md,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: palette.borderDefault,
            ...elevation(scheme, "card"),
          }
        : {
            backgroundColor: palette.sidebar,
            borderRadius: radius.float,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: palette.borderDefault,
            ...elevation(scheme, "float"),
          };
  return <View style={[toneStyle, padded ? styles.padded : null, style]}>{children}</View>;
}

/**
 * The desktop's one glass for anything floating over content (polish.css: --surface-float over
 * blur + saturate): a system material blur under the translucent float fill. With Reduce
 * Transparency on it is fully opaque, like the desktop's prefers-reduced-transparency rule.
 * The blur sits in its own clipped layer so the card's shadow is not clipped with it.
 */
export function GlassCard({ padded = true, style, children }: Omit<SurfaceProps, "tone">) {
  const palette = usePalette();
  const scheme = useScheme();
  const reduceTransparency = useReduceTransparency();
  const flat = StyleSheet.flatten(style) ?? {};
  const corner = flat.borderRadius ?? radius.float;
  return (
    <View
      style={[
        styles.glass,
        { borderColor: material[scheme].border },
        elevation(scheme, "menu"),
        padded ? styles.padded : null,
        style,
      ]}
    >
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: corner, overflow: "hidden" }]}
      >
        {reduceTransparency ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.surfaceElevated }]} />
        ) : (
          <>
            <BlurView
              intensity={material.blur}
              style={StyleSheet.absoluteFill}
              tint={scheme === "dark" ? "systemThinMaterialDark" : "systemThinMaterialLight"}
            />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: material[scheme].fill }]} />
          </>
        )}
      </View>
      {children}
    </View>
  );
}

export function useReduceTransparency(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => {
        if (live) setReduce(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setReduce);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}

const styles = StyleSheet.create({
  // 16 pt sides, like ListRow, so card text lines up with SectionHeader and list labels.
  padded: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: spacing.sm },
  glass: { borderRadius: radius.float, borderWidth: StyleSheet.hairlineWidth },
});
