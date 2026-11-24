import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import type { OrchestrationChildThread } from "../../api/types";
import { usePegasus } from "../../state/PegasusProvider";
import { GlassCard, Icon, PressableScale, StatusDot, type DotStatus } from "../../ui";
import { hitSize, maxFontScale, motion, radius, spacing, text, usePalette } from "../../theme";
import {
  AGENT_STATUS_LABELS,
  agentSummaryParts,
  groupAgents,
  type AgentCounts,
} from "./agent-summary";
import { modelsOf, sessionConfigOf } from "./wire";

const ENTER = FadeIn.duration(motion.slow).reduceMotion(ReduceMotion.System);
const EXIT = FadeOut.duration(motion.fast).reduceMotion(ReduceMotion.System);

const DOT: Record<OrchestrationChildThread["status"], DotStatus> = {
  queued: "offline",
  running: "running",
  waiting: "waiting",
  complete: "idle",
  failed: "failed",
};

/** The chat's subagents for one parent chat, live from the PC's state. */
export function useChatAgents(workspaceId: string, sessionId: string) {
  const { state } = usePegasus();
  return (state?.orchestrationChildren ?? []).filter(
    (child) => child.parentWorkspaceId === workspaceId && child.parentSessionId === sessionId,
  );
}

/**
 * The chat's subagents as one glass pill docked above the composer ("16 agents · 1 needs you ·
 * 3 running"), so they never take transcript space. The turning ring shows while any runs and
 * stops with them (and under Reduce Motion). Tapping opens the agents sheet.
 */
export function AgentsPill({
  counts,
  onPress,
}: {
  readonly counts: AgentCounts;
  readonly onPress: () => void;
}) {
  const palette = usePalette();
  const { total, parts } = agentSummaryParts(counts);
  const lead: DotStatus =
    counts.waiting > 0
      ? "waiting"
      : counts.running > 0
        ? "running"
        : counts.failed > 0
          ? "failed"
          : "idle";
  const label = `${total}, ${parts.map((part) => part.text).join(", ")}`;
  return (
    <Animated.View entering={ENTER} exiting={EXIT} style={styles.pillRow}>
      <GlassCard padded={false} style={styles.pill}>
        <PressableScale
          accessibilityHint="Lists the agents"
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onPress}
          pressedStyle={{ backgroundColor: palette.overlayActive }}
          style={styles.pillInner}
        >
          <View style={styles.pillMark}>
            {lead === "idle" ? (
              <Icon name="person.2" color={palette.textMuted} size={13} />
            ) : (
              <StatusDot status={lead} />
            )}
          </View>
          <Text
            maxFontSizeMultiplier={maxFontScale.chrome}
            numberOfLines={1}
            style={[text.footnote, styles.shrink, { color: palette.text }]}
          >
            <Text style={styles.semibold}>{total}</Text>
            {parts.map((part) => (
              <Text
                key={part.text}
                style={{
                  color:
                    part.tone === "warning"
                      ? palette.warningText
                      : part.tone === "danger"
                        ? palette.dangerText
                        : palette.textMuted,
                }}
              >
                {` · ${part.text}`}
              </Text>
            ))}
          </Text>
          <Icon name="chevron.up" color={palette.textSoft} size={11} weight="semibold" />
        </PressableScale>
      </GlassCard>
    </Animated.View>
  );
}

/**
 * The agents sheet's body: Needs you, Running, Done, each agent with its title, role, model,
 * status and last line. Reads the PC's state itself, so it stays live while open.
 */
export function AgentsSheet({
  workspaceId,
  sessionId,
  onOpen,
}: {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly onOpen: (agent: OrchestrationChildThread) => void;
}) {
  const palette = usePalette();
  const { state } = usePegasus();
  const agents = useChatAgents(workspaceId, sessionId);
  const groups = groupAgents(agents);
  if (groups.length === 0) {
    return (
      <Text style={[text.subheadline, { color: palette.textMuted }]}>No agents in this chat.</Text>
    );
  }
  const modelOf = (agent: OrchestrationChildThread) => {
    const session = state?.workspaces
      .find((workspace) => workspace.id === agent.childWorkspaceId)
      ?.sessions.find((entry) => entry.id === agent.childSessionId);
    const config = sessionConfigOf(session);
    if (!config.modelId) return undefined;
    return (
      modelsOf(state, agent.childWorkspaceId).find(
        (model) => model.providerId === config.provider && model.modelId === config.modelId,
      )?.label ?? config.modelId
    );
  };
  return (
    <View style={styles.sheet}>
      {groups.map((group) => (
        <View key={group.id} style={styles.group}>
          <Text
            accessibilityRole="header"
            maxFontSizeMultiplier={maxFontScale.chrome}
            style={[text.footnote, styles.groupTitle, { color: palette.textMuted }]}
          >
            {group.title} · {group.agents.length}
          </Text>
          <View
            style={[
              styles.card,
              { backgroundColor: palette.overlaySubtle, borderColor: palette.borderDefault },
            ]}
          >
            {group.agents.map((agent, index) => {
              const model = modelOf(agent);
              const status = AGENT_STATUS_LABELS[agent.status];
              const meta = [agent.role, model].filter(Boolean).join(" · ");
              return (
                <PressableScale
                  accessibilityHint="Opens this agent's chat"
                  accessibilityLabel={`${agent.title || "Agent"}, ${status}${meta ? `, ${meta}` : ""}`}
                  accessibilityRole="button"
                  key={agent.id}
                  onPress={() => onOpen(agent)}
                  pressedStyle={{ backgroundColor: palette.overlayActive }}
                  style={[
                    styles.row,
                    index > 0
                      ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line }
                      : null,
                  ]}
                >
                  <View style={styles.dotBox}>
                    <StatusDot status={DOT[agent.status]} />
                  </View>
                  <View style={styles.body}>
                    <Text numberOfLines={2} style={[text.subheadline, { color: palette.text }]}>
                      {agent.title || "Agent"}
                    </Text>
                    <Text
                      maxFontSizeMultiplier={maxFontScale.chrome}
                      numberOfLines={1}
                      style={[text.caption, { color: palette.textMuted }]}
                    >
                      <Text
                        style={[
                          styles.semibold,
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
                        {status}
                      </Text>
                      {meta ? ` · ${meta}` : ""}
                    </Text>
                    {agent.latestTranscript && agent.status !== "complete" ? (
                      <Text numberOfLines={1} style={[text.caption, { color: palette.textSoft }]}>
                        {agent.latestTranscript}
                      </Text>
                    ) : null}
                  </View>
                  <Icon name="chevron.right" color={palette.textSoft} size={13} weight="semibold" />
                </PressableScale>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pillRow: {
    alignItems: "flex-start",
    paddingHorizontal: spacing.gutter,
    paddingBottom: spacing.xs,
  },
  pill: { borderRadius: radius.pill, maxWidth: "100%" },
  pillInner: {
    minHeight: hitSize.min - 8,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
  },
  pillMark: { width: 14, alignItems: "center" },
  shrink: { flexShrink: 1 },
  semibold: { fontWeight: "600" },
  sheet: { gap: spacing.lg, paddingBottom: spacing.sm },
  group: { gap: spacing.sm },
  groupTitle: { fontWeight: "600", paddingHorizontal: spacing.xs },
  // Nested in the 28 pt sheet with 16 pt padding: 12 pt corners.
  card: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  row: {
    minHeight: hitSize.min,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm2,
  },
  dotBox: { width: 14, alignItems: "center" },
  body: { flex: 1, minWidth: 0, gap: spacing.xxs },
});
