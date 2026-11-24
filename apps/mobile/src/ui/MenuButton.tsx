import { useRef, type ReactNode } from "react";
import type { HostInstance, StyleProp, ViewStyle } from "react-native";
import { usePalette } from "../theme";
import type { MenuSection } from "./menu-model";
import { useOverlay } from "./Overlay";
import { PressableScale } from "./PressableScale";

/**
 * A control that opens the Pegasus popover menu next to itself. `children` is the face; the
 * button carries the VoiceOver label and says it opens a menu.
 */
export function MenuButton({
  sections,
  title,
  accessibilityLabel,
  accessibilityHint,
  disabled,
  style,
  pressedStyle,
  hitSlop,
  children,
}: {
  readonly sections: readonly MenuSection[];
  readonly title?: string;
  readonly accessibilityLabel: string;
  readonly accessibilityHint?: string;
  readonly disabled?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly pressedStyle?: StyleProp<ViewStyle>;
  readonly hitSlop?: number;
  readonly children: ReactNode;
}) {
  const palette = usePalette();
  const { openMenu } = useOverlay();
  const ref = useRef<HostInstance>(null);
  return (
    <PressableScale
      accessibilityHint={accessibilityHint ?? "Opens a menu"}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      {...(hitSlop !== undefined ? { hitSlop } : {})}
      onPress={() =>
        ref.current?.measureInWindow((x, y, width, height) =>
          openMenu({ x, y, width, height }, sections, title),
        )
      }
      pressedStyle={pressedStyle ?? { backgroundColor: palette.overlayActive }}
      ref={ref}
      style={style}
    >
      {children}
    </PressableScale>
  );
}
