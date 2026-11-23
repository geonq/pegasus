import { memo, useMemo } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { spacing, type Palette } from "../../theme";
import { isCommentable, longestRow, type CommentableRow, type DiffRow } from "./review-logic";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });
const FONT_SIZE = 12;
const ROW_HEIGHT = 18;
// Menlo's advance at 12 pt; a little extra so the last glyph is never clipped.
const CHAR_WIDTH = 7.3;
// Patches past this many rows are cut, so a lockfile cannot stall the phone.
const MAX_ROWS = 5000;

/**
 * A unified diff for a phone: old and new line numbers, tinted added and removed lines, and one
 * horizontal scroll for the whole file so long lines stay aligned. Long-press a line to comment.
 */
export function DiffView({
  rows,
  palette,
  commented,
  onLongPressRow,
}: {
  readonly rows: readonly DiffRow[];
  readonly palette: Palette;
  /** Row indexes that already carry a comment. */
  readonly commented: ReadonlySet<number>;
  readonly onLongPressRow?: (row: CommentableRow, index: number) => void;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const shown = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;
  const layout = useMemo(() => {
    let maxNumber = 0;
    for (const row of shown) {
      if (row.kind === "added" || row.kind === "context")
        maxNumber = Math.max(maxNumber, row.newNumber);
      if (row.kind === "removed" || row.kind === "context")
        maxNumber = Math.max(maxNumber, row.oldNumber);
    }
    const numberWidth = Math.max(2, String(maxNumber).length) * CHAR_WIDTH + spacing.sm;
    const contentWidth =
      2 * numberWidth + CHAR_WIDTH * 2 + longestRow(shown) * CHAR_WIDTH + spacing.lg;
    return { numberWidth, width: Math.max(screenWidth, contentWidth) };
  }, [shown, screenWidth]);

  return (
    <ScrollView
      horizontal
      bounces={false}
      style={styles.fill}
      contentContainerStyle={{ width: layout.width }}
    >
      <FlatList
        data={shown as DiffRow[]}
        keyExtractor={(_, index) => String(index)}
        getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
        initialNumToRender={60}
        windowSize={11}
        style={styles.fill}
        renderItem={({ item, index }) => (
          <Row
            row={item}
            index={index}
            palette={palette}
            numberWidth={layout.numberWidth}
            commented={commented.has(index)}
            onLongPress={onLongPressRow}
          />
        )}
        ListFooterComponent={
          rows.length > MAX_ROWS ? (
            <Text style={[styles.cut, { color: palette.textMuted }]}>
              {rows.length - MAX_ROWS} more lines. Open this file on the PC to see them.
            </Text>
          ) : undefined
        }
      />
    </ScrollView>
  );
}

const SIGN = { added: "+", removed: "-", context: " " } as const;

const Row = memo(function Row({
  row,
  index,
  palette,
  numberWidth,
  commented,
  onLongPress,
}: {
  readonly row: DiffRow;
  readonly index: number;
  readonly palette: Palette;
  readonly numberWidth: number;
  readonly commented: boolean;
  readonly onLongPress: ((row: CommentableRow, index: number) => void) | undefined;
}) {
  if (row.kind === "gap" || row.kind === "note") {
    return (
      <View style={[styles.row, { backgroundColor: palette.surface }]}>
        <Text
          numberOfLines={1}
          style={[styles.meta, { color: palette.textMuted, paddingLeft: numberWidth }]}
        >
          {row.kind === "gap"
            ? `⋯ ${row.count} unmodified ${row.count === 1 ? "line" : "lines"}`
            : row.text}
        </Text>
      </View>
    );
  }
  // Hex tokens with an alpha suffix: a tint of the theme's own success and danger colours.
  const tint =
    row.kind === "added"
      ? `${palette.success}22`
      : row.kind === "removed"
        ? `${palette.danger}22`
        : undefined;
  const signColor =
    row.kind === "added"
      ? palette.success
      : row.kind === "removed"
        ? palette.danger
        : palette.textMuted;
  const oldNumber = row.kind === "added" ? "" : String(row.oldNumber);
  const newNumber = row.kind === "removed" ? "" : String(row.newNumber);
  const content = (
    <View style={[styles.row, tint ? { backgroundColor: tint } : null]}>
      <Text style={[styles.number, { width: numberWidth, color: palette.textMuted }]}>
        {oldNumber}
      </Text>
      <Text style={[styles.number, { width: numberWidth, color: palette.textMuted }]}>
        {newNumber}
      </Text>
      <Text style={[styles.code, { color: commented ? palette.accentText : signColor }]}>
        {commented ? "●" : SIGN[row.kind]}{" "}
      </Text>
      <Text numberOfLines={1} style={[styles.code, { color: palette.text }]}>
        {row.text.replace(/\t/g, "    ")}
      </Text>
    </View>
  );
  if (!onLongPress || !isCommentable(row)) return content;
  return (
    <Pressable
      accessibilityHint="Long-press to comment on this line"
      delayLongPress={350}
      onLongPress={() => onLongPress(row, index)}
      style={({ pressed }) => (pressed ? { backgroundColor: palette.surfaceRaised } : null)}
    >
      {content}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  row: { height: ROW_HEIGHT, flexDirection: "row", alignItems: "center" },
  number: {
    fontFamily: MONO,
    fontSize: FONT_SIZE - 1,
    textAlign: "right",
    paddingRight: spacing.xs,
  },
  code: { fontFamily: MONO, fontSize: FONT_SIZE, lineHeight: ROW_HEIGHT },
  meta: { fontFamily: MONO, fontSize: FONT_SIZE - 1 },
  cut: { padding: spacing.lg, fontSize: 13 },
});
