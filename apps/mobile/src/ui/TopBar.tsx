import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { hitSize, maxFontScale, radius, spacing, text, usePalette, weight } from "../theme";
import { Icon, type IconName } from "./Icon";
import { MenuButton } from "./MenuButton";
import type { MenuSection } from "./menu-model";
import { PressableScale } from "./PressableScale";

/**
 * The Pegasus top bar, in place of the navigation bar: the desktop's 48 pt chrome bar on the
 * screen's background with round icon buttons. Pass `scrollY` and a hairline fades in once the
 * content scrolls under it (the desktop's topbar keeps no rule until something meets it).
 */
export function TopBar({
  title,
  subtitle,
  leading,
  trailing,
  back,
  center,
  scrollY,
  sheet,
}: {
  readonly title?: string;
  readonly subtitle?: ReactNode;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  /** Shows the back chevron; `true` goes back, a function runs instead. */
  readonly back?: boolean | (() => void);
  /** A custom title block (the chat's title and status). */
  readonly center?: ReactNode;
  readonly scrollY?: SharedValue<number>;
  /** Inside a modal stack screen: no status-bar inset. */
  readonly sheet?: boolean;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const rule = useAnimatedStyle(() => ({
    opacity: scrollY ? Math.min(1, Math.max(0, scrollY.value / 12)) : 0,
  }));
  return (
    <View
      style={[
        styles.bar,
        { paddingTop: sheet ? spacing.sm : insets.top, backgroundColor: palette.background },
      ]}
    >
      <View style={styles.row}>
        <View style={styles.side}>
          {back ? (
            <BarButton
              accessibilityLabel="Back"
              icon="chevron.left"
              onPress={() => (typeof back === "function" ? back() : navigation.goBack())}
            />
          ) : null}
          {leading}
        </View>
        <View accessible={!center} accessibilityRole="header" style={styles.center}>
          {center ?? (
            <>
              {title ? (
                <Text
                  maxFontSizeMultiplier={maxFontScale.chrome}
                  numberOfLines={1}
                  style={[text.headline, { color: palette.textStrong }]}
                >
                  {title}
                </Text>
              ) : null}
              {typeof subtitle === "string" ? (
                <Text
                  maxFontSizeMultiplier={maxFontScale.chrome}
                  numberOfLines={1}
                  style={[text.caption, { color: palette.textMuted }]}
                >
                  {subtitle}
                </Text>
              ) : (
                subtitle
              )}
            </>
          )}
        </View>
        <View style={[styles.side, styles.trailing]}>{trailing}</View>
      </View>
      <Animated.View style={[styles.rule, { backgroundColor: palette.line }, rule]} />
    </View>
  );
}

/** A large page title under the bar, for top-level screens (the desktop's view headings). */
export function PageTitle({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail?: ReactNode;
}) {
  const palette = usePalette();
  return (
    <View style={styles.page}>
      <Text
        accessibilityRole="header"
        style={[text.largeTitle, styles.pageText, { color: palette.textStrong }]}
      >
        {title}
      </Text>
      {detail}
    </View>
  );
}

/** A round 40 pt bar button (44 pt touch) with an SF Symbol; `tone="primary"` fills it with ink. */
export function BarButton({
  icon,
  accessibilityLabel,
  onPress,
  tone = "plain",
  disabled,
  menu,
}: {
  readonly icon: IconName;
  readonly accessibilityLabel: string;
  readonly onPress?: () => void;
  readonly tone?: "plain" | "filled" | "primary";
  readonly disabled?: boolean;
  /** Opens this Pegasus menu instead of running onPress. */
  readonly menu?: readonly MenuSection[];
}) {
  const palette = usePalette();
  const fill =
    tone === "primary" ? palette.primaryFill : tone === "filled" ? palette.overlayHover : undefined;
  const ink = tone === "primary" ? palette.onPrimary : palette.textStrong;
  const face = (
    <Icon color={ink} name={icon} size={tone === "primary" ? 15 : 17} weight="semibold" />
  );
  const style = [
    styles.button,
    fill ? { backgroundColor: fill } : null,
    disabled ? styles.disabled : null,
  ];
  const pressed =
    tone === "primary" ? { opacity: 0.85 } : { backgroundColor: palette.overlayActive };
  if (menu) {
    return (
      <MenuButton
        accessibilityLabel={accessibilityLabel}
        disabled={disabled}
        hitSlop={2}
        pressedStyle={pressed}
        sections={menu}
        style={style}
      >
        {face}
      </MenuButton>
    );
  }
  return (
    <PressableScale
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={2}
      onPress={onPress}
      pressedStyle={pressed}
      style={style}
    >
      {face}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  bar: { zIndex: 2 },
  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  side: { minWidth: 88, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  trailing: { justifyContent: "flex-end" },
  center: { flex: 1, alignItems: "center", minWidth: 0 },
  rule: { height: StyleSheet.hairlineWidth },
  button: {
    width: hitSize.min - 4,
    height: hitSize.min - 4,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.4 },
  page: {
    paddingHorizontal: spacing.lg + spacing.xs,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
  },
  pageText: { fontWeight: weight.bold, letterSpacing: -0.4 },
});
