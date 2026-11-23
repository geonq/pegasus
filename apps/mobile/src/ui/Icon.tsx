import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Text, useWindowDimensions, type ColorValue } from "react-native";
import { maxFontScale } from "../theme";

export type IconName = Extract<SymbolViewProps["name"], string>;

/**
 * An SF Symbol, decorative: the control around it carries the VoiceOver label. It grows with the
 * person's text size up to the chrome limit, like the labels next to it. `fallback` is the glyph
 * drawn where SF Symbols do not exist (Android).
 */
export function Icon({
  name,
  size = 17,
  color,
  weight = "medium",
  fallback,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly color: ColorValue;
  readonly weight?: "regular" | "medium" | "semibold" | "bold";
  readonly fallback?: string;
}) {
  const { fontScale } = useWindowDimensions();
  const scaled = Math.round(size * Math.min(Math.max(fontScale, 1), maxFontScale.chrome));
  return (
    <SymbolView
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      name={name}
      size={scaled}
      tintColor={color}
      weight={weight}
      style={{ width: scaled, height: scaled }}
      fallback={
        fallback ? <Text style={{ color, fontSize: scaled * 0.9 }}>{fallback}</Text> : undefined
      }
    />
  );
}
