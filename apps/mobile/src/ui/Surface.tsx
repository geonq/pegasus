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
 * The desktop's glass for anything floating over content (menus, toasts, notices). Without a blur
 * module it is a nearly opaque fill (see `material` in theme.ts); with Reduce Transparency on it
 * is fully opaque, like the desktop's prefers-reduced-transparency rule.
 */
export function GlassCard({ padded = true, style, children }: Omit<SurfaceProps, "tone">) {
  const palette = usePalette();
  const scheme = useScheme();
  const reduceTransparency = useReduceTransparency();
  return (
    <View
      style={[
        styles.glass,
        {
          backgroundColor: reduceTransparency ? palette.surfaceElevated : material[scheme].fill,
          borderColor: material[scheme].border,
        },
        elevation(scheme, "menu"),
        padded ? styles.padded : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

function useReduceTransparency(): boolean {
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
