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
/** EmptyState and loading Skeleton blocks. */
export { EmptyState, Skeleton } from "./Feedback";
/** An SF Symbol (expo-symbols), decorative, scaled with Dynamic Type. */
export { Icon, type IconName } from "./Icon";
/** The Pegasus popover menu, bottom sheet, confirm dialog and toast host (useOverlay). */
export { OverlayProvider, useOverlay, type ConfirmOptions, type ToastOptions } from "./Overlay";
/** A control that opens the Pegasus popover menu next to itself. */
export { MenuButton } from "./MenuButton";
export type { MenuItem, MenuSection } from "./menu-model";
/** Switch, SegmentedControl, the sidebar StatusDot and the running Spinner. */
export { SegmentedControl, Spinner, StatusDot, Switch, type DotStatus } from "./Controls";
/** A row with custom swipe actions (gesture-handler + reanimated). */
export { SwipeRow, type SwipeAction } from "./SwipeRow";
/** The custom top bar that replaces the navigation bar, its buttons and the page title. */
export { BarButton, PageTitle, TopBar } from "./TopBar";
/** The shared floating material as a fill layer. */
export { GlassFill, useReduceTransparency } from "./Glass";

/** A full-screen page sliding up over everything, in place of the system Modal. */
export { Layer } from "./Layer";
