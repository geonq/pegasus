import type { MenuAction } from "@expo/ui/community/menu";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  /** An SF Symbol name. */
  readonly icon?: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  /** Draws a checkmark: the current choice of a picker menu. */
  readonly selected?: boolean;
  readonly onPress: () => void;
}

export interface MenuSection {
  /** Shown above the section; leave empty for a plain divider. */
  readonly title?: string;
  readonly items: readonly MenuItem[];
}

/**
 * Sections to the MenuView action tree: one untitled section stays flat, several become inline
 * groups (dividers between them). Ids must be unique across the menu.
 */
export function menuActions(sections: readonly MenuSection[]): MenuAction[] {
  const leaf = (item: MenuItem): MenuAction => ({
    id: item.id,
    title: item.label,
    ...(item.icon ? { image: item.icon as MenuAction["image"] } : {}),
    ...(item.selected !== undefined ? { state: item.selected ? "on" : "off" } : {}),
    attributes: {
      ...(item.destructive ? { destructive: true } : {}),
      ...(item.disabled ? { disabled: true } : {}),
    },
  });
  const nonEmpty = sections.filter((section) => section.items.length > 0);
  const only = nonEmpty.length === 1 ? nonEmpty[0] : undefined;
  if (only && !only.title) return only.items.map(leaf);
  return nonEmpty.map((section, index) => ({
    id: `section-${index}`,
    title: section.title ?? "",
    displayInline: true,
    subactions: section.items.map(leaf),
  }));
}

/** The item a menu event names, unless it is disabled. */
export function menuItemById(sections: readonly MenuSection[], id: string): MenuItem | undefined {
  for (const section of sections) {
    const found = section.items.find((item) => item.id === id);
    if (found) return found.disabled ? undefined : found;
  }
  return undefined;
}
