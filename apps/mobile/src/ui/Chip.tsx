import { StyleSheet, Text, View } from "react-native";
import { hitSize, maxFontScale, radius, spacing, text, usePalette, type Palette } from "../theme";
import { PressableScale } from "./PressableScale";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

function toneColors(palette: Palette, tone: Tone) {
  switch (tone) {
    case "neutral":
      return { fill: palette.surface, ink: palette.textMuted };
    case "accent":
      return { fill: palette.accentTint, ink: palette.accentText };
    case "success":
      return { fill: palette.successTint, ink: palette.successText };
    case "warning":
      return { fill: palette.warningTint, ink: palette.warningText };
    case "danger":
      return { fill: palette.dangerTint, ink: palette.dangerText };
  }
}

/** A small status label, e.g. "Live" or "90 %". Text plus tint, so it never relies on colour alone. */
export function Badge({ label, tone = "neutral" }: { readonly label: string; readonly tone?: Tone }) {
  const palette = usePalette();
  const { fill, ink } = toneColors(palette, tone);
  return (
    <View style={[styles.badge, { backgroundColor: fill }]}>
      <Text maxFontSizeMultiplier={maxFontScale.chrome} style={[text.caption2, { color: ink }]}>
        {label}
      </Text>
    </View>
  );
}

/** A selectable pill (filters, model choices). Selected chips take the accent tint. */
export function Chip({
  label,
  selected,
  onPress,
  disabled,
}: {
  readonly label: string;
  readonly selected?: boolean;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  const palette = usePalette();
  const { fill, ink } = toneColors(palette, selected ? "accent" : "neutral");
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected), disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={[
        styles.chip,
        { backgroundColor: fill, borderColor: selected ? palette.accent : palette.borderDefault },
        disabled ? styles.disabled : null,
      ]}
      pressedStyle={{ opacity: 0.8 }}
    >
      <Text
        maxFontSizeMultiplier={maxFontScale.chrome}
        style={[text.subheadline, { color: selected ? ink : palette.text }]}
      >
        {label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm2,
    paddingVertical: spacing.xxs,
    borderRadius: radius.sm2,
  },
  chip: {
    minHeight: hitSize.compact,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.45 },
});
