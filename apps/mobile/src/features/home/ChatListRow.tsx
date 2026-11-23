import { memo, useRef } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { relativeTime, waitingLabel, type ChatRow } from "../../api/chats";
import { StatusDot } from "../../components/StatusDot";
import { PressableScale } from "../../ui";
import { maxFontScale, radius, spacing, text, usePalette, weight } from "../../theme";

export interface ChatRowActions {
  readonly open: (row: ChatRow) => void;
  readonly setPinned: (row: ChatRow, pinned: boolean) => void;
  readonly archive: (row: ChatRow) => void;
  readonly markRead: (row: ChatRow) => void;
}

/** The second line: what the chat waits for, what it is doing, or its last message. */
function detailOf(row: ChatRow, showProject: boolean): string {
  const waiting = waitingLabel(row.pendingDialogs);
  if (waiting) return waiting;
  if (row.session.status === "failed") return "Stopped with an error";
  if (row.session.status === "running") return row.session.currentStep || "Working…";
  const preview = row.session.preview.replace(/\s+/gu, " ").trim();
  if (showProject) return preview ? `${row.workspace.name} · ${preview}` : row.workspace.name;
  return preview || "No messages yet";
}

function SwipeAction({
  label,
  color,
  ink,
  onPress,
}: {
  readonly label: string;
  readonly color: string;
  readonly ink: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.action, { backgroundColor: color }]}
    >
      <Text
        maxFontSizeMultiplier={maxFontScale.chrome}
        style={[text.footnote, styles.actionText, { color: ink }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * One chat in the home list. Swipe left: pin and archive; swipe right: mark read (when unread).
 * The same actions are in VoiceOver's actions menu, so nothing needs a swipe.
 */
export const ChatListRow = memo(function ChatListRow({
  row,
  showProject,
  actions,
  nowMs,
}: {
  readonly row: ChatRow;
  /** On in Needs you, Working, Pinned and search, where chats of every project mix. */
  readonly showProject: boolean;
  readonly actions: ChatRowActions;
  readonly nowMs: number;
}) {
  const palette = usePalette();
  const swipeable = useRef<SwipeableMethods>(null);
  const { session } = row;
  const pinned = Boolean(session.pinnedAt);
  const running = session.status === "running";
  const run = (action: () => void) => () => {
    swipeable.current?.close();
    action();
  };
  const title = session.title || "Untitled chat";
  const when = relativeTime(session.lastInteractedAt ?? session.updatedAt, nowMs);
  const detail = detailOf(row, showProject);

  return (
    <ReanimatedSwipeable
      ref={swipeable}
      friction={2}
      rightThreshold={40}
      leftThreshold={40}
      overshootRight={false}
      overshootLeft={false}
      containerStyle={styles.swipe}
      renderRightActions={() => (
        <View style={styles.actions}>
          <SwipeAction
            label={pinned ? "Unpin" : "Pin"}
            color={palette.accent}
            ink={palette.onAccent}
            onPress={run(() => actions.setPinned(row, !pinned))}
          />
          <SwipeAction
            label="Archive"
            color={palette.surfaceRaised}
            ink={palette.text}
            onPress={run(() => actions.archive(row))}
          />
        </View>
      )}
      {...(row.unread
        ? {
            renderLeftActions: () => (
              <View style={styles.actions}>
                <SwipeAction
                  label="Mark read"
                  color={palette.surfaceRaised}
                  ink={palette.text}
                  onPress={run(() => actions.markRead(row))}
                />
              </View>
            ),
          }
        : {})}
    >
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={[
          title,
          row.unread ? "unread" : null,
          running ? "working" : null,
          pinned ? "pinned" : null,
          detail,
          when,
        ]
          .filter(Boolean)
          .join(", ")}
        accessibilityActions={[
          { name: "pin", label: pinned ? "Unpin" : "Pin" },
          { name: "archive", label: "Archive" },
          ...(row.unread ? [{ name: "read", label: "Mark read" }] : []),
        ]}
        onAccessibilityAction={(event) => {
          const name = event.nativeEvent.actionName;
          if (name === "pin") actions.setPinned(row, !pinned);
          else if (name === "archive") actions.archive(row);
          else if (name === "read") actions.markRead(row);
        }}
        onPress={() => actions.open(row)}
        style={[styles.row, { backgroundColor: palette.background }]}
        pressedStyle={{ backgroundColor: palette.overlayActive }}
      >
        <View style={styles.lead}>
          {running ? (
            <ActivityIndicator size="small" color={palette.success} />
          ) : row.section === "needs-you" ? (
            <StatusDot section="needs-you" />
          ) : row.unread ? (
            <View style={[styles.unread, { backgroundColor: palette.accent }]} />
          ) : null}
        </View>
        <View style={styles.body}>
          <View style={styles.titleLine}>
            <Text
              numberOfLines={1}
              style={[
                text.subheadline,
                styles.title,
                {
                  color: palette.textStrong,
                  fontWeight: row.unread ? weight.semibold : weight.medium,
                },
              ]}
            >
              {title}
            </Text>
            {pinned ? (
              <Text
                style={[text.caption2, { color: palette.textSoft }]}
                accessibilityElementsHidden
              >
                Pinned
              </Text>
            ) : null}
            <Text
              maxFontSizeMultiplier={maxFontScale.chrome}
              style={[text.caption, { color: palette.textMuted }]}
            >
              {when}
            </Text>
          </View>
          <View style={styles.titleLine}>
            <Text
              numberOfLines={1}
              style={[
                text.footnote,
                styles.detail,
                { color: row.pendingDialogs.length > 0 ? palette.warningText : palette.textMuted },
              ]}
            >
              {detail}
            </Text>
            {row.childCount > 0 ? (
              <Text
                maxFontSizeMultiplier={maxFontScale.chrome}
                style={[text.caption, { color: palette.textSoft }]}
              >
                {row.childCount === 1 ? "1 subagent" : `${row.childCount} subagents`}
              </Text>
            ) : null}
            {row.pendingDialogs.length > 0 ? (
              <View style={[styles.count, { backgroundColor: palette.warningTint }]}>
                <Text
                  maxFontSizeMultiplier={maxFontScale.chrome}
                  style={[text.caption2, { color: palette.warningText }]}
                >
                  {row.pendingDialogs.length}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </PressableScale>
    </ReanimatedSwipeable>
  );
});

const styles = StyleSheet.create({
  swipe: { marginHorizontal: spacing.gutter, borderRadius: radius.md, overflow: "hidden" },
  actions: { flexDirection: "row" },
  action: {
    width: 84,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  },
  actionText: { fontWeight: weight.semibold },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 60,
    paddingVertical: spacing.sm,
    paddingRight: spacing.md,
    borderRadius: radius.md,
  },
  lead: { width: 28, alignItems: "center", justifyContent: "center" },
  unread: { width: 8, height: 8, borderRadius: 4 },
  body: { flex: 1, gap: spacing.xxs },
  titleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  title: { flex: 1 },
  detail: { flex: 1 },
  count: {
    minWidth: 20,
    height: 20,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.sm2,
  },
});
