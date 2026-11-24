import * as Haptics from "expo-haptics";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";
import { scheduleOnRN } from "react-native-worklets";
import {
  elevation,
  hitSize,
  material,
  maxFontScale,
  motion,
  radius,
  spacing,
  text,
  usePalette,
  useScheme,
  weight,
} from "../theme";
import { GlassFill } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { menuEntries, placePopover, type MenuSection, type Rect } from "./menu-model";
import { PressableScale } from "./PressableScale";

/**
 * Every floating layer of the app, drawn by Pegasus itself instead of the system: popover menus
 * (anchored to the control that opened them), bottom sheets, confirm dialogs and toasts. They all
 * sit on the desktop's one glass (GlassFill), enter with the same short spring from where they come
 * from, and fade only under Reduce Motion. One host in App.tsx draws them above the navigation in a
 * full-window overlay, so a sheet also covers the stack's own chrome.
 */

export interface ConfirmOptions {
  readonly title: string;
  readonly message?: string;
  readonly confirmLabel: string;
  /** Red confirm, for what cannot be undone. */
  readonly destructive?: boolean;
  readonly cancelLabel?: string;
}

export interface ToastOptions {
  readonly message: string;
  readonly tone?: "neutral" | "danger" | "success";
  readonly action?: { readonly label: string; readonly onPress: () => void };
}

interface OverlayApi {
  readonly openMenu: (anchor: Rect, sections: readonly MenuSection[], title?: string) => void;
  readonly openSheet: (render: (close: () => void) => ReactNode, title?: string) => void;
  readonly closeSheet: () => void;
  readonly confirm: (options: ConfirmOptions) => Promise<boolean>;
  readonly toast: (options: ToastOptions) => void;
}

const OverlayContext = createContext<OverlayApi | null>(null);

export function useOverlay(): OverlayApi {
  const value = useContext(OverlayContext);
  if (!value) throw new Error("useOverlay must be inside OverlayProvider");
  return value;
}

type MenuState = {
  readonly anchor: Rect;
  readonly sections: readonly MenuSection[];
  readonly title?: string;
  readonly id: number;
};
type SheetState = {
  readonly render: (close: () => void) => ReactNode;
  readonly title?: string;
  readonly id: number;
};
type ConfirmState = ConfirmOptions & {
  readonly resolve: (ok: boolean) => void;
  readonly id: number;
};
type ToastState = ToastOptions & { readonly id: number };

export function OverlayProvider({ children }: { readonly children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [dialog, setDialog] = useState<ConfirmState | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const ids = useRef(0);

  const api = useMemo<OverlayApi>(
    () => ({
      openMenu: (anchor, sections, title) => {
        Haptics.selectionAsync().catch(() => undefined);
        setMenu({ anchor, sections, id: ++ids.current, ...(title ? { title } : {}) });
      },
      openSheet: (render, title) =>
        setSheet({ render, id: ++ids.current, ...(title ? { title } : {}) }),
      closeSheet: () => setSheet(null),
      confirm: (options) =>
        new Promise<boolean>((resolve) => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
            () => undefined,
          );
          setDialog({ ...options, resolve, id: ++ids.current });
        }),
      toast: (options) => {
        if (options.tone === "danger") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
        }
        setToast({ ...options, id: ++ids.current });
      },
    }),
    [],
  );

  const layers = menu || sheet || dialog || toast;
  const content = (
    <>
      {sheet ? <Sheet key={sheet.id} state={sheet} onClosed={() => setSheet(null)} /> : null}
      {menu ? <Menu key={menu.id} state={menu} onClosed={() => setMenu(null)} /> : null}
      {dialog ? (
        <Dialog
          key={dialog.id}
          state={dialog}
          onClosed={(ok) => {
            dialog.resolve(ok);
            setDialog(null);
          }}
        />
      ) : null}
      {toast ? <Toast key={toast.id} state={toast} onClosed={() => setToast(null)} /> : null}
    </>
  );

  return (
    <OverlayContext.Provider value={api}>
      {children}
      {layers ? (
        Platform.OS === "ios" ? (
          <FullWindowOverlay>
            <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
              {content}
            </View>
          </FullWindowOverlay>
        ) : (
          <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            {content}
          </View>
        )
      ) : null}
    </OverlayContext.Provider>
  );
}

/** Opens and closes a layer: 0 = gone, 1 = shown. Calls `onClosed` once it has left. */
function usePresence(onClosed: () => void) {
  const reduceMotion = useReducedMotion();
  const shown = useSharedValue(0);
  const closing = useRef(false);
  useEffect(() => {
    shown.value = reduceMotion
      ? withTiming(1, { duration: motion.base })
      : withSpring(1, motion.spring);
  }, [reduceMotion, shown]);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    shown.value = withTiming(
      0,
      { duration: motion.fast, easing: Easing.out(Easing.quad) },
      (finished) => {
        if (finished) scheduleOnRN(onClosed);
      },
    );
  }, [onClosed, shown]);
  return { shown, close, reduceMotion };
}

function Scrim({
  shown,
  onPress,
  tint = true,
  label = "Close",
}: {
  readonly shown: { value: number };
  readonly onPress: () => void;
  readonly tint?: boolean;
  readonly label?: string;
}) {
  const palette = usePalette();
  const style = useAnimatedStyle(() => ({ opacity: shown.value }));
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        onPress={onPress}
        style={[StyleSheet.absoluteFill, tint ? { backgroundColor: palette.scrim } : null]}
      />
    </Animated.View>
  );
}

// ---- Popover menu -----------------------------------------------------------------------------

const MENU_WIDTH = 264;
const ROW_HEIGHT = hitSize.min;

/**
 * The desktop's workspace menu (14 px radius, 6 px padding, 8 px rows) on the glass, anchored to
 * its trigger and grown from the corner that touches it. A picker's current choice has a check.
 */
function Menu({ state, onClosed }: { readonly state: MenuState; readonly onClosed: () => void }) {
  const palette = usePalette();
  const scheme = useScheme();
  const screen = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { shown, close, reduceMotion } = usePresence(onClosed);
  const entries = menuEntries(state.sections);
  const estimated =
    spacing.sm2 * 2 +
    (state.title ? 30 : 0) +
    entries.reduce(
      (sum, entry) =>
        sum +
        (entry.kind === "divider"
          ? spacing.sm + 1
          : entry.kind === "title"
            ? 28
            : entry.item.description
              ? ROW_HEIGHT + 16
              : ROW_HEIGHT) *
          Math.min(screen.fontScale, 1.6),
      0,
    );
  const place = placePopover(
    state.anchor,
    { width: MENU_WIDTH, height: estimated },
    screen,
    insets,
  );
  const fromTop = place.origin.startsWith("top");
  const fromRight = place.origin.endsWith("right");
  const style = useAnimatedStyle(() => {
    const scale = reduceMotion ? 1 : 0.94 + 0.06 * shown.value;
    const height = Math.min(estimated, place.maxHeight);
    // Scale about the trigger corner: shift by what the scale takes away on that side.
    const dx = ((fromRight ? 1 : -1) * (1 - scale) * place.width) / 2;
    const dy = ((fromTop ? -1 : 1) * (1 - scale) * height) / 2;
    return {
      opacity: shown.value,
      transform: [{ translateX: dx }, { translateY: dy }, { scale }],
    };
  });

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(state.title ?? "Menu");
  }, [state.title]);

  const run = (action: () => void) => {
    Haptics.selectionAsync().catch(() => undefined);
    close();
    // The menu leaves first, so a sheet or screen the action opens does not fight it.
    setTimeout(action, motion.fast);
  };

  return (
    <>
      <Scrim label="Close menu" onPress={close} shown={shown} tint={false} />
      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.menu,
          elevation(scheme, "menu"),
          {
            left: place.x,
            top: place.y,
            width: place.width,
            maxHeight: place.maxHeight,
            borderColor: material[scheme].border,
          },
          style,
        ]}
      >
        <GlassFill radius={radius.float} />
        <ScrollView
          bounces={false}
          contentContainerStyle={styles.menuContent}
          showsVerticalScrollIndicator={estimated > place.maxHeight}
        >
          {state.title ? (
            <Text
              accessibilityRole="header"
              maxFontSizeMultiplier={maxFontScale.chrome}
              style={[text.footnote, styles.menuTitle, { color: palette.textMuted }]}
            >
              {state.title}
            </Text>
          ) : null}
          {entries.map((entry) => {
            if (entry.kind === "divider") {
              return (
                <View
                  key={entry.key}
                  style={[styles.menuDivider, { backgroundColor: palette.borderDefault }]}
                />
              );
            }
            if (entry.kind === "title") {
              return (
                <Text
                  accessibilityRole="header"
                  key={entry.key}
                  maxFontSizeMultiplier={maxFontScale.chrome}
                  style={[text.caption, styles.menuSection, { color: palette.textSoft }]}
                >
                  {entry.title}
                </Text>
              );
            }
            const { item } = entry;
            const ink = item.destructive ? palette.dangerText : palette.textStrong;
            return (
              <Pressable
                accessibilityLabel={item.label}
                accessibilityRole="menuitem"
                accessibilityState={{
                  disabled: Boolean(item.disabled),
                  ...(item.selected !== undefined ? { selected: item.selected } : {}),
                }}
                {...(item.description ? { accessibilityHint: item.description } : {})}
                disabled={item.disabled}
                key={entry.key}
                onPress={() => run(item.onPress)}
                style={({ pressed }) => [
                  styles.menuItem,
                  pressed ? { backgroundColor: palette.overlayActive } : null,
                  item.disabled ? styles.disabled : null,
                ]}
              >
                <View style={styles.menuIcon}>
                  {item.icon ? (
                    <Icon
                      color={item.destructive ? palette.dangerText : palette.textMuted}
                      name={item.icon as IconName}
                      size={16}
                    />
                  ) : null}
                </View>
                <View style={styles.menuLabel}>
                  <Text
                    maxFontSizeMultiplier={maxFontScale.chrome}
                    numberOfLines={2}
                    style={[
                      text.subheadline,
                      { color: ink, fontWeight: item.selected ? weight.semibold : weight.normal },
                    ]}
                  >
                    {item.label}
                  </Text>
                  {item.description ? (
                    <Text
                      maxFontSizeMultiplier={maxFontScale.chrome}
                      numberOfLines={2}
                      style={[text.caption, { color: palette.textMuted }]}
                    >
                      {item.description}
                    </Text>
                  ) : null}
                </View>
                {item.selected ? (
                  <Icon color={palette.accentText} name="checkmark" size={14} weight="semibold" />
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </Animated.View>
    </>
  );
}

// ---- Bottom sheet -----------------------------------------------------------------------------

/**
 * A sheet that rises from the bottom on the glass with a grabber. Drag it down (or flick) to
 * dismiss; it follows the finger 1:1, keeps the release velocity and rubber-bands upward. The
 * keyboard lifts it. Tapping the scrim closes it.
 */
function Sheet({ state, onClosed }: { readonly state: SheetState; readonly onClosed: () => void }) {
  const palette = usePalette();
  const scheme = useScheme();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const { shown, close, reduceMotion } = usePresence(onClosed);
  const drag = useSharedValue(0);
  const height = useSharedValue(screenHeight);
  const keyboard = useReanimatedKeyboardAnimation();

  const pan = usePanGesture({
    activeOffsetY: [-8, 8],
    onUpdate: (event) => {
      "worklet";
      const y = event.translationY;
      drag.value = y >= 0 ? y : -Math.sqrt(-y) * 2;
    },
    onDeactivate: (event) => {
      "worklet";
      const projected = drag.value + event.velocityY * 0.12;
      if (projected > height.value * 0.35 || event.velocityY > 900) {
        scheduleOnRN(close);
      } else {
        drag.value = withSpring(0, { ...motion.springFlick, velocity: event.velocityY });
      }
    },
  });

  const sheetStyle = useAnimatedStyle(() => {
    const offset = reduceMotion ? 0 : (1 - shown.value) * height.value;
    return {
      opacity: reduceMotion ? shown.value : 1,
      transform: [{ translateY: offset + Math.max(drag.value, -24) + keyboard.height.value }],
    };
  });

  return (
    <>
      <Scrim label="Close sheet" onPress={close} shown={shown} />
      <Animated.View
        accessibilityViewIsModal
        onLayout={(event) => {
          height.value = event.nativeEvent.layout.height;
        }}
        style={[
          styles.sheet,
          elevation(scheme, "modal"),
          {
            maxHeight: screenHeight - insets.top - spacing.xl,
            paddingBottom: Math.max(insets.bottom, spacing.lg),
            borderColor: material[scheme].border,
          },
          sheetStyle,
        ]}
      >
        <GlassFill radius={radius.composer + 10} />
        <GestureDetector gesture={pan}>
          <View style={styles.sheetHandleArea}>
            <View style={[styles.grabber, { backgroundColor: palette.lineStrong }]} />
            {state.title ? (
              <View style={styles.sheetTitleRow}>
                <Text
                  accessibilityRole="header"
                  style={[text.headline, styles.flex, { color: palette.textStrong }]}
                >
                  {state.title}
                </Text>
                <PressableScale
                  accessibilityLabel="Close"
                  accessibilityRole="button"
                  hitSlop={6}
                  onPress={close}
                  pressedStyle={{ backgroundColor: palette.overlayActive }}
                  style={[styles.sheetClose, { backgroundColor: palette.overlaySubtle }]}
                >
                  <Icon color={palette.textMuted} name="xmark" size={12} weight="bold" />
                </PressableScale>
              </View>
            ) : null}
          </View>
        </GestureDetector>
        <ScrollView
          bounces={false}
          contentContainerStyle={styles.sheetBody}
          keyboardShouldPersistTaps="handled"
        >
          {state.render(close)}
        </ScrollView>
      </Animated.View>
    </>
  );
}

// ---- Confirm dialog ---------------------------------------------------------------------------

function Dialog({
  state,
  onClosed,
}: {
  readonly state: ConfirmState;
  readonly onClosed: (ok: boolean) => void;
}) {
  const palette = usePalette();
  const scheme = useScheme();
  const answer = useRef(false);
  const { shown, close, reduceMotion } = usePresence(() => onClosed(answer.current));
  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ scale: reduceMotion ? 1 : 0.96 + 0.04 * shown.value }],
  }));
  const pick = (ok: boolean) => {
    answer.current = ok;
    close();
  };
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.center]}>
      <Scrim label={state.cancelLabel ?? "Cancel"} onPress={() => pick(false)} shown={shown} />
      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.dialog,
          elevation(scheme, "modal"),
          { borderColor: material[scheme].border },
          style,
        ]}
      >
        <GlassFill radius={radius.composer + 4} />
        <Text
          accessibilityRole="header"
          style={[text.headline, styles.centerText, { color: palette.textStrong }]}
        >
          {state.title}
        </Text>
        {state.message ? (
          <Text style={[text.subheadline, styles.centerText, { color: palette.textMuted }]}>
            {state.message}
          </Text>
        ) : null}
        <View style={styles.dialogActions}>
          <PressableScale
            accessibilityRole="button"
            onPress={() => pick(false)}
            pressedStyle={{ backgroundColor: palette.overlayActive }}
            style={[styles.dialogButton, { backgroundColor: palette.overlayHover }]}
          >
            <Text style={[text.headline, { color: palette.text }]}>
              {state.cancelLabel ?? "Cancel"}
            </Text>
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            onPress={() => pick(true)}
            pressedStyle={{ opacity: 0.85 }}
            style={[
              styles.dialogButton,
              { backgroundColor: state.destructive ? palette.danger : palette.primaryFill },
            ]}
          >
            <Text
              style={[
                text.headline,
                { color: state.destructive ? palette.onAccent : palette.onPrimary },
              ]}
            >
              {state.confirmLabel}
            </Text>
          </PressableScale>
        </View>
      </Animated.View>
    </View>
  );
}

// ---- Toast ------------------------------------------------------------------------------------

/** A short glass note at the top (the desktop's attention toast), with an optional Undo. */
function Toast({ state, onClosed }: { readonly state: ToastState; readonly onClosed: () => void }) {
  const palette = usePalette();
  const scheme = useScheme();
  const insets = useSafeAreaInsets();
  const { shown, close, reduceMotion } = usePresence(onClosed);
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(state.message);
    const timer = setTimeout(close, state.action ? 5000 : 3200);
    return () => clearTimeout(timer);
  }, [close, state.action, state.message]);
  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [
      { translateY: reduceMotion ? 0 : (1 - shown.value) * -12 },
      { scale: reduceMotion ? 1 : 0.96 + 0.04 * shown.value },
    ],
  }));
  const icon: IconName =
    state.tone === "danger"
      ? "exclamationmark.triangle.fill"
      : state.tone === "success"
        ? "checkmark.circle.fill"
        : "info.circle.fill";
  const ink =
    state.tone === "danger"
      ? palette.dangerText
      : state.tone === "success"
        ? palette.successText
        : palette.textMuted;
  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      style={[
        styles.toast,
        elevation(scheme, "menu"),
        { top: insets.top + spacing.xs, borderColor: material[scheme].border },
        style,
      ]}
    >
      <GlassFill radius={radius.md} />
      <Icon color={ink} name={icon} size={15} />
      <Text style={[text.subheadline, styles.flex, { color: palette.textStrong }]}>
        {state.message}
      </Text>
      {state.action ? (
        <PressableScale
          accessibilityRole="button"
          onPress={() => {
            state.action?.onPress();
            close();
          }}
          style={styles.toastAction}
        >
          <Text style={[text.subheadline, styles.semibold, { color: palette.accentText }]}>
            {state.action.label}
          </Text>
        </PressableScale>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  semibold: { fontWeight: weight.semibold },
  disabled: { opacity: 0.4 },
  center: { alignItems: "center", justifyContent: "center", padding: spacing.xl },
  centerText: { textAlign: "center" },
  menu: {
    position: "absolute",
    borderRadius: radius.float,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  menuContent: { padding: spacing.sm2 },
  menuTitle: {
    fontWeight: weight.medium,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  menuSection: {
    fontWeight: weight.medium,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: spacing.xs,
    marginHorizontal: spacing.md,
  },
  menuItem: {
    minHeight: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm2,
    paddingHorizontal: spacing.sm2,
    paddingVertical: spacing.sm,
    // Concentric with the 14 pt menu and its 6 pt padding.
    borderRadius: radius.sm,
  },
  menuIcon: { width: 22, alignItems: "center" },
  menuLabel: { flex: 1, minWidth: 0, gap: 1 },
  sheet: {
    position: "absolute",
    left: spacing.gutter,
    right: spacing.gutter,
    bottom: spacing.gutter,
    borderRadius: radius.composer + 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  sheetHandleArea: { paddingTop: spacing.sm, paddingHorizontal: spacing.lg, gap: spacing.sm },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: radius.pill },
  sheetTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: hitSize.min,
  },
  sheetClose: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetBody: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.md },
  dialog: {
    width: "100%",
    maxWidth: 340,
    borderRadius: radius.composer + 4,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.xl,
    gap: spacing.sm,
    overflow: "hidden",
  },
  dialogActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  dialogButton: {
    flex: 1,
    minHeight: hitSize.min + 4,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  toast: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: hitSize.min + 8,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  toastAction: { minHeight: hitSize.min, justifyContent: "center", paddingHorizontal: spacing.md },
});
