export interface MenuItem {
  readonly id: string;
  readonly label: string;
  /** An SF Symbol name. */
  readonly icon?: string;
  /** A second, quieter line under the label (e.g. what a permission allows). */
  readonly description?: string;
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

export type MenuEntry =
  | { readonly kind: "title"; readonly key: string; readonly title: string }
  | { readonly kind: "divider"; readonly key: string }
  | { readonly kind: "item"; readonly key: string; readonly item: MenuItem };

/**
 * Sections as the rows the Pegasus menu draws: empty sections drop out, a divider separates
 * sections, and a titled section starts with its title. Ids must be unique across the menu.
 */
export function menuEntries(sections: readonly MenuSection[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  sections
    .filter((section) => section.items.length > 0)
    .forEach((section, index) => {
      if (index > 0) out.push({ kind: "divider", key: `divider-${index}` });
      if (section.title) out.push({ kind: "title", key: `title-${index}`, title: section.title });
      for (const item of section.items) out.push({ kind: "item", key: item.id, item });
    });
  return out;
}

/** The item with this id, unless it is disabled. */
export function menuItemById(sections: readonly MenuSection[], id: string): MenuItem | undefined {
  for (const section of sections) {
    const found = section.items.find((item) => item.id === id);
    if (found) return found.disabled ? undefined : found;
  }
  return undefined;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a popover of `size` goes next to its trigger in a `screen` with safe-area `insets`: below
 * the trigger when it fits, else above it; aligned to the trigger's nearer side and kept `gap`
 * from every edge. `origin` is the corner it grows from (the one touching the trigger).
 */
export function placePopover(
  anchor: Rect,
  size: { readonly width: number; readonly height: number },
  screen: { readonly width: number; readonly height: number },
  insets: { readonly top: number; readonly bottom: number },
  gap = 8,
): { x: number; y: number; width: number; maxHeight: number; origin: string } {
  const width = Math.min(size.width, screen.width - 2 * gap);
  const top = insets.top + gap;
  const bottom = screen.height - insets.bottom - gap;
  const below = bottom - (anchor.y + anchor.height + 6);
  const above = anchor.y - 6 - top;
  const fitsBelow = size.height <= below || below >= above;
  const maxHeight = Math.max(120, fitsBelow ? below : above);
  const height = Math.min(size.height, maxHeight);
  const y = fitsBelow ? anchor.y + anchor.height + 6 : anchor.y - 6 - height;
  const alignRight = anchor.x + anchor.width / 2 > screen.width / 2;
  const rawX = alignRight ? anchor.x + anchor.width - width : anchor.x;
  const x = Math.min(Math.max(rawX, gap), screen.width - gap - width);
  const origin = `${fitsBelow ? "top" : "bottom"} ${alignRight ? "right" : "left"}`;
  return { x, y, width, maxHeight, origin };
}
