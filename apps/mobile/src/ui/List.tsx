import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { hitSize, radius, spacing, text, usePalette } from "../theme";
import { PressableScale } from "./PressableScale";

/** A section title above a group: sentence case, muted, like the desktop's settings headings. */
export function SectionHeader({
  title,
  trailing,
}: {
  readonly title: string;
  readonly trailing?: ReactNode;
}) {
  const palette = usePalette();
  return (
    <View style={styles.header}>
      <Text
        accessibilityRole="header"
        style={[text.footnote, styles.headerText, { color: palette.textMuted }]}
      >
        {title}
      </Text>
      {trailing}
    </View>
  );
}

/**
 * A grouped list card (iOS inset grouped, in the desktop's --surface-muted with 12 pt corners).
 * Rows inside get hairline separators inset past the leading edge.
 */
export function ListGroup({
  title,
  footer,
  children,
}: {
  readonly title?: string;
  readonly footer?: string;
  readonly children: ReactNode;
}) {
  const palette = usePalette();
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.groupWrap}>
      {title ? <SectionHeader title={title} /> : null}
      <View style={[styles.group, { backgroundColor: palette.surface }]}>
        {rows.map((row, index) => (
          <Fragment key={row.key ?? index}>
            {index > 0 ? (
              <View style={[styles.separator, { backgroundColor: palette.line }]} />
            ) : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? (
        <Text style={[text.footnote, styles.footer, { color: palette.textMuted }]}>{footer}</Text>
      ) : null}
    </View>
  );
}

export interface ListRowProps {
  readonly label: string;
  readonly description?: string;
  /** Short value on the trailing side; stacks under the label at very large text sizes. */
  readonly detail?: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  /** Shows a chevron and makes the row pressable. */
  readonly onPress?: () => void;
  readonly tone?: "default" | "danger" | "accent";
  readonly disabled?: boolean;
  readonly accessibilityHint?: string;
}

/** One row of a ListGroup: at least 44 pt tall, label left, detail and accessory right. */
export function ListRow({
  label,
  description,
  detail,
  leading,
  trailing,
  onPress,
  tone = "default",
  disabled,
  accessibilityHint,
}: ListRowProps) {
  const palette = usePalette();
  const { fontScale } = useWindowDimensions();
  const stackDetail = fontScale >= 1.5;
  const labelColor =
    tone === "danger" ? palette.danger : tone === "accent" ? palette.accentText : palette.text;
  const content = (
    <View style={[styles.row, disabled ? styles.disabled : null]}>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        <Text style={[text.body, { color: labelColor }]}>{label}</Text>
        {description ? (
          <Text style={[text.footnote, { color: palette.textMuted }]}>{description}</Text>
        ) : null}
        {detail && stackDetail ? (
          <Text style={[text.footnote, { color: palette.textMuted }]}>{detail}</Text>
        ) : null}
      </View>
      {detail && !stackDetail ? (
        <Text
          numberOfLines={1}
          ellipsizeMode="middle"
          style={[text.body, styles.detail, { color: palette.textMuted }]}
        >
          {detail}
        </Text>
      ) : null}
      {trailing}
      {onPress ? <Text style={[text.body, { color: palette.textSoft }]}>›</Text> : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      disabled={disabled}
      onPress={onPress}
      pressedStyle={{ backgroundColor: palette.overlayActive }}
    >
      {content}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  headerText: { fontWeight: "500", flexShrink: 1 },
  groupWrap: { gap: spacing.sm2 },
  group: { borderRadius: radius.md, overflow: "hidden" },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: spacing.lg },
  footer: { paddingHorizontal: spacing.lg },
  row: {
    minHeight: hitSize.min,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md2,
  },
  disabled: { opacity: 0.45 },
  leading: { width: 24, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0, gap: 2 },
  detail: { maxWidth: "45%", flexShrink: 1, textAlign: "right" },
});
