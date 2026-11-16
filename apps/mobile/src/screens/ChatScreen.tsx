import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pendingDialogsOf, sessionKey } from "../api/chats";
import type {
  OrchestrationChildThread,
  PendingDialogAnswer,
  QueuedComposerMessage,
  TranscriptItem,
  TranscriptTool,
} from "../api/types";
import { formatDuration, groupTranscript, toolsSummary, type WorkLogRow } from "../api/worklog";
import { LIMIT_WARNING_PERCENT, planStatus, resetsIn } from "../api/usage";
import { ApprovalCard } from "../components/ApprovalCard";
import { Markdown } from "../components/Markdown";
import { usePegasus } from "../state/PegasusProvider";
import { radius, spacing, type, usePalette } from "../theme";
import type { RootStackParamList } from "../navigation";

const CHILD_STATUS_LABELS: Record<OrchestrationChildThread["status"], string> = {
  queued: "Queued",
  running: "Working",
  waiting: "Waiting for you",
  complete: "Done",
  failed: "Failed",
};

/**
 * One chat: its work log as it streams in, and the composer that sends, queues or steers.
 * Everything here is drawn from the PC's state; the only state the screen owns is what was typed,
 * which tool runs are expanded, and the last answer that was sent (a receipt, not a copy of it).
 */
export function ChatScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, "Chat">) {
  const { workspaceId, sessionId, title } = route.params;
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { state, transcript, status, openChat, send, stop, answer, removeQueued, steerQueued } =
    usePegasus();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [receipt, setReceipt] = useState<string | null>(null);
  // A clock, not a stored duration: elapsed is recomputed every second while a turn is live.
  const [now, setNow] = useState(() => Date.now());
  const list = useRef<LegendListRef>(null);

  const session = useMemo(
    () =>
      state?.workspaces.find((w) => w.id === workspaceId)?.sessions.find((s) => s.id === sessionId),
    [state, workspaceId, sessionId],
  );
  const running = session?.status === "running";
  const live = status.state === "live";

  useEffect(() => {
    navigation.setOptions({
      title: title || "Chat",
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => navigation.navigate("Usage", { workspaceId, sessionId })}
        >
          <Text style={{ color: palette.accentText, fontSize: 17 }}>Usage</Text>
        </Pressable>
      ),
    });
  }, [navigation, palette.accentText, sessionId, title, workspaceId]);

  // Opening a chat also tells the PC which chat this phone is looking at, so the transcript,
  // the queue and the answers all belong to the chat on screen after coming back from a child.
  useFocusEffect(
    useCallback(() => {
      openChat({ workspaceId, sessionId }).catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    }, [openChat, sessionId, workspaceId]),
  );

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // Only this chat's transcript, once the PC has switched this phone's view to it.
  const items = useMemo(
    () =>
      transcript?.workspaceId === workspaceId && transcript.sessionId === sessionId
        ? transcript.transcript.filter(isShown)
        : null,
    [transcript, workspaceId, sessionId],
  );
  const rows = useMemo(() => groupTranscript(items ?? []), [items]);
  const pending = pendingDialogsOf(state?.sessionExtensionUiBySession, workspaceId, sessionId);
  const asked = pending[0];
  const queued = state?.queuedComposerMessages ?? [];
  const children = (state?.orchestrationChildren ?? []).filter(
    (child) => child.parentWorkspaceId === workspaceId && child.parentSessionId === sessionId,
  );
  const plan = planStatus(state?.sessionUsageBySession?.[sessionKey(workspaceId, sessionId)]);

  const submit = async (mode: "send" | "steer") => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await send(text, mode);
      setDraft("");
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      list.current?.scrollToEnd({ animated: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  const submitAnswer = async (next: PendingDialogAnswer) => {
    await answer({ workspaceId, sessionId }, next);
    const sent =
      "confirmed" in next
        ? next.confirmed
          ? "Allowed"
          : "Declined"
        : "cancelled" in next
          ? "Not now"
          : "Answer sent";
    const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setReceipt(`${sent} · ${at}`);
  };

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    Haptics.selectionAsync().catch(() => undefined);
  }, []);

  const banner =
    status.state === "retrying"
      ? `${status.reason} Retrying in ${Math.round(status.inMs / 1000)} s · showing the last update.`
      : status.state === "revoked"
        ? status.reason
        : null;
  const limitReset = plan ? resetsIn(plan.resetsAt, now) : null;
  const canSend = live && !sending;

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: palette.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={insets.top + 44}
    >
      {banner ? (
        <Text
          style={[
            styles.banner,
            { color: palette.textMuted, backgroundColor: palette.surfaceRaised },
          ]}
        >
          {banner}
        </Text>
      ) : null}

      <View style={styles.turnBar}>
        <Text
          style={[styles.turnState, { color: running ? palette.accentText : palette.textMuted }]}
        >
          {running
            ? "● Working"
            : session?.status === "failed"
              ? "Stopped with an error"
              : "Updated"}
        </Text>
        <Text numberOfLines={1} style={[styles.turnDetail, { color: palette.textMuted }]}>
          {running && session?.runningSince
            ? `${formatDuration(now - Date.parse(session.runningSince))}${session.currentStep ? ` · ${session.currentStep}` : ""}`
            : session
              ? `${formatDuration(now - Date.parse(session.updatedAt))} ago`
              : ""}
        </Text>
      </View>

      {children.length > 0 ? (
        <View style={styles.children}>
          {children.slice(0, 4).map((child) => (
            <Pressable
              accessibilityRole="button"
              key={child.id}
              onPress={() =>
                navigation.push("Chat", {
                  workspaceId: child.childWorkspaceId,
                  sessionId: child.childSessionId,
                  title: child.title,
                })
              }
              style={({ pressed }) => [
                styles.childRow,
                { backgroundColor: pressed ? palette.surfaceRaised : palette.surface },
              ]}
            >
              <Text numberOfLines={1} style={[styles.childTitle, { color: palette.text }]}>
                {child.role ? `${child.role} · ` : ""}
                {child.title || "Agent"}
              </Text>
              <Text
                style={[
                  styles.childStatus,
                  {
                    color:
                      child.status === "failed"
                        ? palette.danger
                        : child.status === "waiting"
                          ? palette.warning
                          : palette.textMuted,
                  },
                ]}
              >
                {CHILD_STATUS_LABELS[child.status]}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {items === null ? (
        <View style={styles.loading}>
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : (
        <LegendList
          ref={list}
          data={rows}
          keyExtractor={(row) => row.id}
          estimatedItemSize={80}
          initialScrollIndex={Math.max(0, rows.length - 1)}
          maintainScrollAtEnd
          maintainVisibleContentPosition
          alignItemsAtEnd
          contentContainerStyle={styles.content}
          getItemType={(row) => row.kind}
          renderItem={({ item }) => (
            <Row expanded={expanded.has(item.id)} onToggle={toggle} row={item} />
          )}
        />
      )}

      {error ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>
          {error}
        </Text>
      ) : null}

      {receipt ? (
        <Text style={[styles.receipt, { color: palette.textMuted }]}>{receipt}</Text>
      ) : null}

      {asked ? (
        <ApprovalCard
          dialog={asked}
          key={asked.requestId}
          onAnswer={submitAnswer}
          waiting={pending.length}
        />
      ) : (
        <>
          {items !== null && queued.length > 0 ? (
            <View style={styles.queue}>
              <Text style={[styles.queueTitle, { color: palette.textMuted }]}>
                {queued.length === 1 ? "1 queued" : `${queued.length} queued`}
              </Text>
              {queued.map((message) => (
                <QueuedRow
                  disabled={!live}
                  key={message.id}
                  message={message}
                  onRemove={() => {
                    removeQueued(message.id).catch((reason: unknown) =>
                      setError(reason instanceof Error ? reason.message : String(reason)),
                    );
                  }}
                  onSteer={() => {
                    steerQueued(message.id).catch((reason: unknown) =>
                      setError(reason instanceof Error ? reason.message : String(reason)),
                    );
                  }}
                />
              ))}
            </View>
          ) : null}

          {plan && plan.usedPercent >= LIMIT_WARNING_PERCENT ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate("Usage", { workspaceId, sessionId })}
              style={styles.limit}
            >
              <Text style={[styles.limitText, { color: palette.warning }]}>
                {plan.provider} usage {Math.round(plan.usedPercent)}%
                {limitReset ? ` · ${limitReset}` : ""}
              </Text>
            </Pressable>
          ) : null}

          <View
            style={[
              styles.composer,
              {
                backgroundColor: palette.surface,
                borderColor: palette.line,
                paddingBottom: Math.max(insets.bottom, spacing.sm),
              },
            ]}
          >
            <TextInput
              editable={!sending}
              multiline
              onChangeText={setDraft}
              placeholder={
                !live ? "Reconnecting — cannot send" : running ? "Steer this run…" : "Message"
              }
              placeholderTextColor={palette.textMuted}
              style={[styles.input, { color: palette.text }]}
              value={draft}
            />
            {running && draft.trim() ? (
              <Pressable
                accessibilityLabel="Queue for the next turn"
                accessibilityRole="button"
                disabled={!canSend}
                onPress={() => {
                  submit("send").catch(() => undefined);
                }}
                style={styles.queueButton}
              >
                <Text style={[styles.queueButtonText, { color: palette.accentText }]}>Queue</Text>
              </Pressable>
            ) : null}
            {running ? (
              <Pressable
                accessibilityLabel="Stop"
                accessibilityRole="button"
                onPress={() => {
                  stop({ workspaceId, sessionId }).catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : String(reason)),
                  );
                }}
                style={[styles.roundButton, { backgroundColor: palette.surfaceRaised }]}
              >
                <View style={[styles.stopGlyph, { backgroundColor: palette.text }]} />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel={running ? "Steer this run" : "Send"}
              accessibilityRole="button"
              disabled={!draft.trim() || !canSend}
              onPress={() => {
                submit(running ? "steer" : "send").catch(() => undefined);
              }}
              style={[
                styles.roundButton,
                {
                  backgroundColor: palette.accent,
                  opacity: draft.trim() && canSend ? 1 : 0.4,
                },
              ]}
            >
              <Text style={[styles.sendGlyph, { color: palette.onAccent }]}>↑</Text>
            </Pressable>
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

function isShown(item: TranscriptItem): boolean {
  return ["message", "thinking", "tool", "activity", "custom"].includes(item.kind);
}

const Row = memo(function Row({
  row,
  expanded,
  onToggle,
}: {
  readonly row: WorkLogRow;
  readonly expanded: boolean;
  readonly onToggle: (id: string) => void;
}) {
  const palette = usePalette();
  if (row.kind === "message") {
    if (row.item.role === "assistant") {
      return (
        <View style={styles.assistant}>
          <Markdown text={row.item.text} />
        </View>
      );
    }
    if (row.item.role !== "user") {
      return (
        <Text style={[styles.divider, { color: palette.textMuted }]}>
          — {row.item.role === "compactionSummary" ? "Compacted" : "Branched"} —
        </Text>
      );
    }
    return (
      <View style={[styles.userBubble, { backgroundColor: palette.userBubble }]}>
        <Text selectable style={[styles.userText, { color: palette.text }]}>
          {row.item.text}
        </Text>
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
  if (row.kind === "activity") {
    return (
      <Text numberOfLines={2} style={[styles.activity, { color: palette.textMuted }]}>
        {row.label}
      </Text>
    );
  }
  if (row.kind === "thinking") {
    const duration = row.durationMs === undefined ? null : formatDuration(row.durationMs);
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => onToggle(row.id)}
        style={styles.thinkingRow}
      >
        <Text
          numberOfLines={expanded ? undefined : 2}
          style={[styles.thinking, { color: palette.textMuted }]}
        >
          {duration ? `Thought for ${duration}` : "Thinking…"}
          {expanded && row.text ? `\n${row.text}` : ""}
        </Text>
      </Pressable>
    );
  }
  const summary = toolsSummary(row.tools.length, row.failed, row.running);
  return (
    <View style={styles.group}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => onToggle(row.id)}
        style={styles.groupHeader}
      >
        <Text numberOfLines={1} style={[styles.groupTitle, { color: palette.text }]}>
          {row.tools[row.tools.length - 1]?.label ?? summary}
        </Text>
        <Text
          style={[
            styles.groupSummary,
            { color: row.failed > 0 ? palette.danger : palette.textMuted },
          ]}
        >
          {summary}
        </Text>
      </Pressable>
      {expanded ? row.tools.map((tool) => <ToolLine key={tool.id} tool={tool} />) : null}
    </View>
  );
});

function ToolLine({ tool }: { readonly tool: TranscriptTool }) {
  const palette = usePalette();
  const color =
    tool.status === "error"
      ? palette.danger
      : tool.status === "running"
        ? palette.accentText
        : palette.textMuted;
  return (
    <Text numberOfLines={3} style={[styles.tool, { color }]}>
      {tool.status === "running" ? "● " : tool.status === "error" ? "✕ " : "✓ "}
      {tool.label}
    </Text>
  );
}

function QueuedRow({
  message,
  disabled,
  onSteer,
  onRemove,
}: {
  readonly message: QueuedComposerMessage;
  readonly disabled: boolean;
  readonly onSteer: () => void;
  readonly onRemove: () => void;
}) {
  const palette = usePalette();
  return (
    <View style={[styles.queuedRow, { borderColor: palette.line }]}>
      <Text numberOfLines={2} style={[styles.queuedText, { color: palette.text }]}>
        {message.text}
      </Text>
      <Pressable
        accessibilityLabel="Steer now"
        accessibilityRole="button"
        disabled={disabled}
        hitSlop={8}
        onPress={onSteer}
      >
        <Text
          style={[
            styles.queuedAction,
            { color: disabled ? palette.textMuted : palette.accentText },
          ]}
        >
          Steer
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Remove from the queue"
        accessibilityRole="button"
        disabled={disabled}
        hitSlop={8}
        onPress={onRemove}
      >
        <Text style={[styles.queuedRemove, { color: palette.textMuted }]}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  banner: { fontSize: type.caption, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  turnBar: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  turnState: { fontSize: 13, fontWeight: "600" },
  turnDetail: { flex: 1, fontSize: 13 },
  children: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xs, gap: 2 },
  childRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    minHeight: 36,
  },
  childTitle: { flex: 1, fontSize: 14, fontWeight: "500" },
  childStatus: { fontSize: type.caption, fontWeight: "600" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "86%",
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.sm + 2,
    marginVertical: spacing.xs,
  },
  userText: { fontSize: type.body, lineHeight: 22 },
  assistant: { marginVertical: spacing.xs },
  divider: { textAlign: "center", fontSize: type.caption, marginVertical: spacing.sm },
  activity: { fontSize: type.caption, fontStyle: "italic" },
  thinkingRow: { paddingVertical: 2 },
  thinking: { fontSize: 14, fontStyle: "italic", lineHeight: 20 },
  group: { marginVertical: 2 },
  groupHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingVertical: 4,
  },
  groupTitle: { flex: 1, fontSize: 14, fontWeight: "500" },
  groupSummary: { fontSize: type.caption },
  tool: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    paddingLeft: spacing.md,
  },
  error: { fontSize: 14, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  receipt: { fontSize: type.caption, paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
  queue: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  queueTitle: {
    fontSize: type.caption,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  queuedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.xs,
  },
  queuedText: { flex: 1, fontSize: 14, lineHeight: 19 },
  queuedAction: { fontSize: 14, fontWeight: "600" },
  queuedRemove: { fontSize: 15 },
  limit: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
  limitText: { fontSize: type.caption, fontWeight: "600" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, fontSize: type.body, maxHeight: 140, paddingVertical: 10 },
  queueButton: { minHeight: 36, justifyContent: "center", paddingHorizontal: spacing.xs },
  queueButtonText: { fontSize: 15, fontWeight: "600" },
  roundButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  stopGlyph: { width: 12, height: 12, borderRadius: 2 },
  sendGlyph: { fontSize: 18, fontWeight: "700", marginTop: -2 },
});
