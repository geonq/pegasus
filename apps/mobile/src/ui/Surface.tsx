import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { GlassFill } from "./Glass";
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
            // Phone cards share the list groups' fill, so every card on a screen reads as one kind.
            backgroundColor: palette.surfaceElevated,
            borderRadius: radius.float,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: palette.borderDefault,
            ...elevation(scheme, "float"),
          };
  return <View style={[toneStyle, padded ? styles.padded : null, style]}>{children}</View>;
}

/**
 * A card on the desktop's one glass, for anything floating over content (toasts, the composer,
 * floating pills). The blur layer is clipped on its own so the card's shadow is not.
 */
export function GlassCard({ padded = true, style, children }: Omit<SurfaceProps, "tone">) {
  const scheme = useScheme();
  const flat = StyleSheet.flatten(style) ?? {};
  const corner = typeof flat.borderRadius === "number" ? flat.borderRadius : radius.float;
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
      <GlassFill radius={corner} />
      {children}
    </View>
  );
}
const styles = StyleSheet.create({
  // 16 pt sides, like ListRow, so card text lines up with SectionHeader and list labels.
  padded: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: spacing.sm },
  glass: { borderRadius: radius.float, borderWidth: StyleSheet.hairlineWidth },
});
