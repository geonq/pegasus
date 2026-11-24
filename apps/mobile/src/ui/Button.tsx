import type { ReactNode } from "react";
import { StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { Spinner } from "./Controls";
import { hitSize, radius, spacing, text, usePalette, type Palette } from "../theme";
import { PressableScale } from "./PressableScale";

export interface ButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  /**
   * primary: ink on paper, the desktop's --button-primary (black in light, white in dark).
   * accent: the brand blue, for the one main action of a screen such as Pair or Send.
   * secondary: a quiet --surface-muted fill. destructive: red text on a red tint.
   */
  readonly variant?: "primary" | "accent" | "secondary" | "destructive";
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly accessibilityHint?: string;
}

function colors(palette: Palette, variant: NonNullable<ButtonProps["variant"]>, off: boolean) {
  if (off)
    return {
      fill: palette.primaryDisabledFill,
      ink: palette.onPrimaryDisabled,
      border: "transparent",
    };
  switch (variant) {
    case "primary":
      return { fill: palette.primaryFill, ink: palette.onPrimary, border: "transparent" };
    case "accent":
      return { fill: palette.accent, ink: palette.onAccent, border: "transparent" };
    case "secondary":
      return { fill: palette.surface, ink: palette.text, border: palette.borderDefault };
    case "destructive":
      return {
        fill: palette.dangerTint,
        ink: palette.dangerText,
        border: palette.dangerTintBorder,
      };
  }
}

/** A full-width-capable 44 pt button with the desktop's colours and press state. */
export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  busy,
  style,
  accessibilityHint,
}: ButtonProps) {
  const palette = usePalette();
  const off = Boolean(disabled || busy);
  const { fill, ink, border } = colors(palette, variant, Boolean(disabled));
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: Boolean(busy) }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      disabled={off}
      onPress={onPress}
      style={[styles.button, { backgroundColor: fill, borderColor: border }, style]}
      pressedStyle={styles.pressed}
    >
      {busy ? <Spinner color={ink} size={12} /> : null}
      <Text style={[text.headline, { color: ink }]}>{label}</Text>
    </PressableScale>
  );
}

/** A round 44 pt icon-only button. The label is required: VoiceOver reads it. */
export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  tone = "plain",
  disabled,
}: {
  readonly icon: ReactNode;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  /** plain: no fill until pressed. filled: --surface-muted. */
  readonly tone?: "plain" | "filled";
  readonly disabled?: boolean;
}) {
  const palette = usePalette();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={[
        styles.icon,
        tone === "filled" ? { backgroundColor: palette.surface } : null,
        disabled ? styles.disabled : null,
      ]}
      pressedStyle={{ backgroundColor: palette.overlayActive }}
    >
      {icon}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: hitSize.min,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  pressed: { opacity: 0.85 },
  icon: {
    width: hitSize.min,
    height: hitSize.min,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.45 },
});
