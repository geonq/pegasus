import * as Haptics from "expo-haptics";
import { memo } from "react";
import { Image, Platform, StyleSheet, Text, View } from "react-native";
import type { TranscriptTool } from "../../api/types";
import { formatDuration, toolsSummary, type WorkLogRow } from "../../api/worklog";
import { Markdown } from "../../components/Markdown";
import { Icon, PressableScale, Spinner } from "../../ui";
import { hitSize, maxFontScale, radius, spacing, text, usePalette } from "../../theme";
import { GenerativeUiCard } from "./GenerativeUiCard";
import { messageImages } from "./wire";

/**
 * One row of the work log. Messages read like the desktop timeline: the person's own text in a
 * muted bubble on the right, the agent's markdown full width. Tool runs fold into one card with
 * status and duration; tapping it lists each call with its own time and detail.
 */
export const TranscriptRow = memo(function TranscriptRow({
  row,
  expanded,
  onToggle,
  workspaceId,
  sessionId,
  sessionRunning,
  isLast,
}: {
  readonly row: WorkLogRow;
  readonly expanded: boolean;
  readonly onToggle: (id: string) => void;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sessionRunning: boolean;
  /** The newest row while the run is live streams its markdown in. */
  readonly isLast: boolean;
}) {
  const palette = usePalette();
  if (row.kind === "message") {
    const { item } = row;
    if (item.role === "assistant") {
      return (
        <View style={styles.assistant}>
          <Markdown text={item.text} streaming={isLast && sessionRunning} />
        </View>
      );
    }
    if (item.role !== "user") {
      return (
        <View accessibilityRole="text" style={styles.divider}>
          <View style={[styles.rule, { backgroundColor: palette.line }]} />
          <Text style={[text.caption, { color: palette.textMuted }]}>
            {item.role === "compactionSummary" ? "Context compacted" : "Branch summary"}
          </Text>
          <View style={[styles.rule, { backgroundColor: palette.line }]} />
        </View>
      );
    }
    const images = messageImages(item);
    return (
      <View style={styles.userColumn}>
        {images.length > 0 ? (
          <View style={styles.images}>
            {images.map((image, index) => (
              <Image
                accessibilityLabel={image.name ?? "Attached image"}
                key={`${index}:${image.name ?? ""}`}
                source={{ uri: image.uri }}
                style={[styles.image, { backgroundColor: palette.surface }]}
              />
            ))}
          </View>
        ) : null}
        {item.text ? (
          <View style={[styles.userBubble, { backgroundColor: palette.userBubble }]}>
            <Text selectable style={[text.body, { color: palette.text }]}>
              {item.text}
            </Text>
          </View>
        ) : null}
      </View>
    );
  }
  if (row.kind === "custom") {
    return (
      <View style={styles.assistant}>
        <Markdown text={row.text} />
      </View>
    );
  }
  if (row.kind === "ui") {
    return (
      <GenerativeUiCard
        sessionId={sessionId}
        sessionRunning={sessionRunning}
        tool={row.tool}
        workspaceId={workspaceId}
      />
    );
  }
  if (row.kind === "activity") {
    return (
      <View style={styles.activity}>
        <Text style={[text.footnote, { color: palette.textMuted }]}>{row.label}</Text>
        {row.entries.map((entry) => (
          <Text key={entry} numberOfLines={1} style={[text.footnote, { color: palette.textSoft }]}>
            {"  ·  "}
            {entry}
          </Text>
        ))}
      </View>
    );
  }
  if (row.kind === "thinking") {
    const duration = row.durationMs === undefined ? null : formatDuration(row.durationMs);
    const label = duration ? `Thought for ${duration}` : "Thinking";
    return (
      <PressableScale
        accessibilityHint={expanded ? "Hides the reasoning" : "Shows the reasoning"}
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => onToggle(row.id)}
        style={styles.thinking}
        pressedStyle={{ opacity: 0.6 }}
      >
        <View style={styles.thinkingLine}>
          <Icon name="brain" color={palette.textSoft} size={12} />
          <Text style={[text.footnote, { color: palette.textMuted }]}>{label}</Text>
          <Icon
            name={expanded ? "chevron.down" : "chevron.right"}
            color={palette.textSoft}
            size={10}
          />
        </View>
        {expanded && row.text ? (
          <Text selectable style={[text.footnote, styles.italic, { color: palette.textMuted }]}>
            {row.text}
          </Text>
        ) : null}
      </PressableScale>
    );
  }
  return <ToolRun expanded={expanded} onToggle={onToggle} row={row} />;
});

function ToolRun({
  row,
  expanded,
  onToggle,
}: {
  readonly row: Extract<WorkLogRow, { kind: "tools" }>;
  readonly expanded: boolean;
  readonly onToggle: (id: string) => void;
}) {
  const palette = usePalette();
  const summary = toolsSummary(row.tools.length, row.failed, row.running);
  const latest = row.tools[row.tools.length - 1];
  const title = latest?.label ?? summary;
  const time = row.durationMs === undefined ? null : formatDuration(row.durationMs);
  const tone =
    row.failed > 0 ? palette.dangerText : row.running ? palette.accentText : palette.textMuted;
  return (
    <View
      style={[
        styles.toolCard,
        { backgroundColor: palette.surfaceElevated, borderColor: palette.borderDefault },
      ]}
    >
      <PressableScale
        accessibilityHint={expanded ? "Hides the steps" : "Lists each step"}
        accessibilityLabel={`${title}. ${summary}${time ? `, ${time}` : ""}`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => onToggle(row.id)}
        pressedStyle={{ backgroundColor: palette.overlayActive }}
        style={styles.toolHeader}
      >
        <StatusGlyph status={row.running ? "running" : row.failed > 0 ? "error" : "success"} />
        <View style={styles.toolTitles}>
          <Text numberOfLines={1} style={[text.subheadline, { color: palette.text }]}>
            {title}
          </Text>
          <Text maxFontSizeMultiplier={maxFontScale.chrome} style={[text.caption, { color: tone }]}>
            {summary}
            {time ? ` · ${time}` : ""}
          </Text>
        </View>
        <Icon
          name={expanded ? "chevron.down" : "chevron.right"}
          color={palette.textSoft}
          size={11}
        />
      </PressableScale>
      {expanded ? (
        <View style={[styles.toolList, { borderTopColor: palette.borderDefault }]}>
          {row.tools.map((tool, index) => (
            <ToolLine duration={row.durations[index]} key={tool.id} tool={tool} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ToolLine({
  tool,
  duration,
}: {
  readonly tool: TranscriptTool;
  readonly duration?: number;
}) {
  const palette = usePalette();
  return (
    <View style={styles.toolLine}>
      <StatusGlyph status={tool.status} />
      <View style={styles.toolTitles}>
        <Text selectable style={[text.footnote, { color: palette.text }]}>
          {tool.label}
        </Text>
        {tool.detail ? (
          <Text numberOfLines={6} selectable style={[styles.mono, { color: palette.textMuted }]}>
            {tool.detail}
          </Text>
        ) : null}
      </View>
      {duration !== undefined ? (
        <Text
          maxFontSizeMultiplier={maxFontScale.chrome}
          style={[text.caption, { color: palette.textSoft }]}
        >
          {formatDuration(duration)}
        </Text>
      ) : null}
    </View>
  );
}

/** A shape per status, so it never relies on colour alone. */
function StatusGlyph({ status }: { readonly status: TranscriptTool["status"] }) {
  const palette = usePalette();
  if (status === "running") {
    return (
      <View accessible accessibilityLabel="Running" style={styles.glyph}>
        <Spinner size={12} />
      </View>
    );
  }
  const [name, color, label] =
    status === "error"
      ? (["xmark.circle.fill", palette.dangerText, "Failed"] as const)
      : (["checkmark.circle.fill", palette.successText, "Done"] as const);
  return (
    <View accessible accessibilityLabel={label} style={styles.glyph}>
      <Icon name={name} color={color} size={14} />
    </View>
  );
}

/** Light tick for expand/collapse; kept here so every disclosure in the log feels the same. */
export function selectionHaptic() {
  Haptics.selectionAsync().catch(() => undefined);
}

const styles = StyleSheet.create({
  assistant: { paddingVertical: spacing.xs },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  userColumn: { alignItems: "flex-end", gap: spacing.xs, paddingVertical: spacing.xs },
  userBubble: {
    maxWidth: "86%",
    borderRadius: radius.lg,
    borderBottomRightRadius: radius.sm2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md2,
  },
  images: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: spacing.xs },
  image: { width: 96, height: 96, borderRadius: radius.md },
  activity: { paddingVertical: spacing.xxs, gap: spacing.xxs },
  thinking: {
    minHeight: hitSize.compact,
    justifyContent: "center",
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  italic: { fontStyle: "italic" },
  thinkingLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm2 },
  toolCard: {
    borderRadius: radius.float,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  toolHeader: {
    minHeight: hitSize.min,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  toolTitles: { flex: 1, minWidth: 0, gap: spacing.xxs },
  toolList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  toolLine: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  glyph: { width: 16, height: 18, alignItems: "center", justifyContent: "center" },
  mono: {
    ...text.mono,
    fontSize: text.caption.fontSize,
    lineHeight: text.caption.lineHeight,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
  },
});
