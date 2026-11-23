/**
 * Shared building blocks in the Pegasus desktop look. Colours, sizes and motion come from
 * ../theme.ts (the desktop's default theme and tokens.css), so screens that use these match the
 * desktop without their own styling.
 */

/** Pressable that shrinks to 0.97 like the desktop's :active; respects Reduce Motion. */
export { PressableScale, type PressableScaleProps } from "./PressableScale";
/** Surface: a card (muted, elevated or the desktop's floating card). GlassCard: menus, toasts. */
export { GlassCard, Surface, type SurfaceProps } from "./Surface";
/** Inset grouped lists: ListGroup holds ListRows with separators; SectionHeader titles a block. */
export { ListGroup, ListRow, SectionHeader, type ListRowProps } from "./List";
/** Button (primary ink, accent blue, secondary, destructive) and the round IconButton. */
export { Button, IconButton, type ButtonProps } from "./Button";
/** Badge: a tinted status label. Chip: a selectable pill. */
export { Badge, Chip, type Tone } from "./Chip";
/** EmptyState, loading Skeleton blocks and the SheetHeader of a bottom sheet. */
export { EmptyState, SheetHeader, Skeleton } from "./Feedback";
/** An SF Symbol (expo-symbols), decorative, scaled with Dynamic Type. */
export { Icon, type IconName } from "./Icon";
/** The system menu (SwiftUI Menu / ContextMenu via @expo/ui) built from sections of items. */
export { NativeMenu } from "./NativeMenu";
export type { MenuItem, MenuSection } from "./menu-model";
