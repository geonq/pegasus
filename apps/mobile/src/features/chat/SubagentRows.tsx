import { StyleSheet, Text, View } from "react-native";
import type { OrchestrationChildThread } from "../../api/types";
import { PressableScale } from "../../ui";
import { hitSize, maxFontScale, radius, spacing, text, usePalette, type Palette } from "../../theme";

const STATUS_LABELS: Record<OrchestrationChildThread["status"], string> = {
  queued: "Queued",
  running: "Working",
  waiting: "Needs you",
  complete: "Done",
  failed: "Failed",
};

function statusColor(palette: Palette, status: OrchestrationChildThread["status"]) {
  switch (status) {
    case "running":
      return palette.accent;
    case "waiting":
      return palette.warning;
    case "failed":
      return palette.danger;
    case "complete":
      return palette.success;
    case "queued":
      return palette.statusNeutral;
  }
}

/**
 * The chat's child threads, like T3's SubagentRow: status dot, role and title, the last line it
 * wrote, and its state in words. Tapping one opens that chat.
 */
export function SubagentRows({
  agents,
  onOpen,
}: {
  readonly agents: readonly OrchestrationChildThread[];
  readonly onOpen: (agent: OrchestrationChildThread) => void;
}) {
  const palette = usePalette();
  if (agents.length === 0) return null;
  const active = agents.filter((agent) => agent.status === "running" || agent.status === "waiting").length;
  return (
    <View style={[styles.group, { backgroundColor: palette.surface, borderColor: palette.borderDefault }]}>
      <Text
        accessibilityRole="header"
        maxFontSizeMultiplier={maxFontScale.chrome}
        style={[text.caption, styles.heading, { color: palette.textMuted }]}
      >
        {agents.length === 1 ? "1 agent" : `${agents.length} agents`}
        {active > 0 ? ` · ${active} active` : ""}
      </Text>
      {agents.map((agent, index) => (
        <PressableScale
          accessibilityHint="Opens this agent's chat"
          accessibilityLabel={`${agent.role ? `${agent.role}, ` : ""}${agent.title || "Agent"}, ${STATUS_LABELS[agent.status]}`}
          accessibilityRole="button"
          key={agent.id}
          onPress={() => onOpen(agent)}
          pressedStyle={{ backgroundColor: palette.overlayActive }}
          style={[
            styles.row,
            index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line } : null,
          ]}
        >
          <View style={[styles.dot, { backgroundColor: statusColor(palette, agent.status) }]} />
          <View style={styles.body}>
            <Text numberOfLines={1} style={[text.subheadline, { color: palette.text }]}>
              {agent.role ? <Text style={{ color: palette.textMuted }}>{agent.role} · </Text> : null}
              {agent.title || "Agent"}
            </Text>
            {agent.latestTranscript ? (
              <Text numberOfLines={1} style={[text.footnote, { color: palette.textMuted }]}>
                {agent.latestTranscript}
              </Text>
            ) : null}
          </View>
          <Text
            maxFontSizeMultiplier={maxFontScale.chrome}
            style={[
              text.caption,
              styles.status,
              {
                color:
                  agent.status === "failed"
                    ? palette.dangerText
                    : agent.status === "waiting"
                      ? palette.warningText
                      : palette.textMuted,
              },
            ]}
          >
            {STATUS_LABELS[agent.status]}
          </Text>
          <Text style={[text.body, { color: palette.textSoft }]}>›</Text>
        </PressableScale>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  heading: { fontWeight: "600", paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xs },
  row: {
    minHeight: hitSize.min,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  dot: { width: 8, height: 8, borderRadius: radius.pill },
  body: { flex: 1, minWidth: 0, gap: spacing.xxs },
  status: { fontWeight: "600" },
});
