import { MenuView } from "@expo/ui/community/menu";
import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { menuActions, menuItemById, type MenuSection } from "./menu-model";

/**
 * The system menu (SwiftUI Menu on tap, ContextMenu on long press, through @expo/ui): the same
 * menus, blur and haptics as every iOS app. `children` is the trigger and keeps its own label.
 */
export function NativeMenu({
  sections,
  title,
  longPress = false,
  style,
  children,
}: {
  readonly sections: readonly MenuSection[];
  readonly title?: string;
  /** Opens on long press (a context menu on a row) instead of a tap. */
  readonly longPress?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
}) {
  return (
    <MenuView
      actions={menuActions(sections)}
      onPressAction={(event) => {
        const item = menuItemById(sections, event.nativeEvent.event);
        if (!item) return;
        Haptics.selectionAsync().catch(() => undefined);
        item.onPress();
      }}
      shouldOpenOnLongPress={longPress}
      {...(title ? { title } : {})}
      {...(style ? { style } : {})}
    >
      {children}
    </MenuView>
  );
}
