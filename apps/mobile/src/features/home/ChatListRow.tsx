import { memo, useMemo, useRef } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { relativeTime, waitingLabel, type ChatRow } from "../../api/chats";
import { Icon, NativeMenu, PressableScale, type IconName, type MenuSection } from "../../ui";
import { maxFontScale, radius, spacing, text, usePalette, weight } from "../../theme";

export interface ChatRowActions {
  readonly open: (row: ChatRow) => void;
  readonly setPinned: (row: ChatRow, pinned: boolean) => void;
  readonly archive: (row: ChatRow) => void;
  readonly markRead: (row: ChatRow) => void;
  readonly newChatIn: (row: ChatRow) => void;
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
  icon,
  color,
  ink,
  onPress,
}: {
  readonly label: string;
  readonly icon: IconName;
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
      <Icon name={icon} color={ink} size={18} />
      <Text
        maxFontSizeMultiplier={maxFontScale.chrome}
        style={[text.caption, styles.actionText, { color: ink }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * One chat in the home list. Swipe left: pin and archive; swipe right: mark read (when unread);
 * long press: the system context menu with every action. The same actions are in VoiceOver's
 * actions menu, so nothing needs a gesture.
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
  const waiting = row.pendingDialogs.length > 0;
  const failed = session.status === "failed";
  const run = (action: () => void) => () => {
    swipeable.current?.close();
    action();
  };
  const title = session.title || "Untitled chat";
  const when = relativeTime(session.lastInteractedAt ?? session.updatedAt, nowMs);
  const detail = detailOf(row, showProject);

  const menu = useMemo<MenuSection[]>(
    () => [
      {
        items: [
          { id: "open", label: "Open", icon: "bubble.left", onPress: () => actions.open(row) },
          {
            id: "pin",
            label: pinned ? "Unpin" : "Pin",
            icon: pinned ? "pin.slash" : "pin",
            onPress: () => actions.setPinned(row, !pinned),
          },
          ...(row.unread
            ? [
                {
                  id: "read",
                  label: "Mark read",
                  icon: "checkmark.circle" as const,
                  onPress: () => actions.markRead(row),
                },
              ]
            : []),
          {
            id: "new",
            label: `New chat in ${row.workspace.name}`,
            icon: "square.and.pencil",
            onPress: () => actions.newChatIn(row),
          },
        ],
      },
      {
        items: [
          {
            id: "archive",
            label: "Archive",
            icon: "archivebox",
            destructive: true,
            onPress: () => actions.archive(row),
          },
        ],
      },
    ],
    [actions, pinned, row],
  );

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
            icon={pinned ? "pin.slash.fill" : "pin.fill"}
            color={palette.accent}
            ink={palette.onAccent}
            onPress={run(() => actions.setPinned(row, !pinned))}
          />
          <SwipeAction
            label="Archive"
            icon="archivebox.fill"
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
                  label="Read"
                  icon="checkmark.circle.fill"
                  color={palette.surfaceRaised}
                  ink={palette.text}
                  onPress={run(() => actions.markRead(row))}
                />
              </View>
            ),
          }
        : {})}
    >
      <NativeMenu longPress sections={menu}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={[
            title,
            waiting ? "needs you" : null,
            row.unread ? "unread" : null,
            running ? "working" : null,
            pinned ? "pinned" : null,
            detail,
            when,
          ]
            .filter(Boolean)
            .join(", ")}
          accessibilityHint="Opens the chat. Long press for more."
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
            ) : waiting ? (
              <Icon name="exclamationmark.circle.fill" color={palette.warning} size={16} />
            ) : failed ? (
              <Icon name="xmark.octagon.fill" color={palette.danger} size={15} />
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
                    fontWeight: row.unread || waiting ? weight.semibold : weight.medium,
                  },
                ]}
              >
                {title}
              </Text>
              {pinned ? <Icon name="pin.fill" color={palette.textSoft} size={11} /> : null}
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
                  {
                    color: waiting
                      ? palette.warningText
                      : failed
                        ? palette.dangerText
                        : palette.textMuted,
                  },
                ]}
              >
                {detail}
              </Text>
              {row.childCount > 0 ? (
                <View style={styles.children}>
                  <Icon name="person.2" color={palette.textSoft} size={11} />
                  <Text
                    maxFontSizeMultiplier={maxFontScale.chrome}
                    style={[text.caption, { color: palette.textSoft }]}
                  >
                    {row.childCount}
                  </Text>
                </View>
              ) : null}
              {waiting ? (
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
      </NativeMenu>
    </ReanimatedSwipeable>
  );
});

const styles = StyleSheet.create({
  swipe: { marginHorizontal: spacing.gutter, borderRadius: radius.md, overflow: "hidden" },
  actions: { flexDirection: "row" },
  action: {
    width: 76,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
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
  children: { flexDirection: "row", alignItems: "center", gap: spacing.xxs },
  count: {
    minWidth: 20,
    height: 20,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.sm2,
  },
});
