import { memo, useMemo, useRef } from "react";
import { Pressable, StyleSheet, Text, View, type HostInstance } from "react-native";
import { relativeTime, waitingLabel, type ChatRow } from "../../api/chats";
import {
  Icon,
  StatusDot,
  SwipeRow,
  useOverlay,
  type DotStatus,
  type MenuSection,
  type SwipeAction,
} from "../../ui";
import { cleanPreview, cleanTitle } from "./home-text";
import { hitSize, maxFontScale, radius, spacing, text, usePalette, weight } from "../../theme";

export interface ChatRowActions {
  readonly open: (row: ChatRow) => void;
  readonly setPinned: (row: ChatRow, pinned: boolean) => void;
  readonly archive: (row: ChatRow) => void;
  readonly markRead: (row: ChatRow) => void;
  readonly newChatIn: (row: ChatRow) => void;
}

/**
 * The lines under the title: what the chat waits for, is doing or ended with (coloured by state),
 * then, when that is a state and not news, the last thing it said, with its project where chats of
 * several projects mix.
 */
function detailOf(
  row: ChatRow,
  showProject: boolean,
): { readonly main: string; readonly tone: "warning" | "danger" | "muted"; readonly sub: string } {
  const preview = cleanPreview(row.session.preview);
  const project = showProject ? row.workspace.name : "";
  const joined = [project, preview].filter(Boolean).join(" · ");
  const waiting = waitingLabel(row.pendingDialogs);
  if (waiting) return { main: waiting, tone: "warning", sub: joined };
  if (row.session.status === "failed") {
    return { main: "Stopped with an error", tone: "danger", sub: joined };
  }
  if (row.session.status === "running") {
    return { main: row.session.currentStep || "Working…", tone: "muted", sub: project };
  }
  return { main: joined || "No messages yet", tone: "muted", sub: "" };
}

/**
 * One chat in the home list, drawn like the desktop's sidebar row inside its floating card: the
 * status mark (turning ring, needs-you, failed or unseen dot), title and time, then what it waits
 * for or said last. Swipe left to pin or archive, right to mark read; long press opens the Pegasus
 * menu with every action. VoiceOver gets the same actions, so nothing needs a gesture.
 */
export const ChatListRow = memo(function ChatListRow({
  row,
  showProject,
  actions,
  nowMs,
  first,
  last,
}: {
  readonly row: ChatRow;
  /** On in Needs you, Working, Pinned and search, where chats of every project mix. */
  readonly showProject: boolean;
  readonly actions: ChatRowActions;
  readonly nowMs: number;
  /** Where the row sits in its section's card, for its corners and hairlines. */
  readonly first: boolean;
  readonly last: boolean;
}) {
  const palette = usePalette();
  const { openMenu } = useOverlay();
  const face = useRef<HostInstance>(null);
  const { session } = row;
  const pinned = Boolean(session.pinnedAt);
  const running = session.status === "running";
  const waiting = row.pendingDialogs.length > 0;
  const failed = session.status === "failed";
  const title = cleanTitle(session.title);
  const when = relativeTime(session.lastInteractedAt ?? session.updatedAt, nowMs);
  const detail = detailOf(row, showProject);
  const status: DotStatus = running
    ? "running"
    : waiting
      ? "waiting"
      : failed
        ? "failed"
        : row.unread
          ? "unread"
          : "idle";

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
                  icon: "checkmark.circle",
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

  const trailing: SwipeAction[] = [
    {
      id: "pin",
      label: pinned ? "Unpin" : "Pin",
      icon: pinned ? "pin.slash.fill" : "pin.fill",
      fill: palette.accent,
      ink: palette.onAccent,
      onPress: () => actions.setPinned(row, !pinned),
    },
    {
      id: "archive",
      label: "Archive",
      icon: "archivebox.fill",
      fill: palette.primaryFill,
      ink: palette.onPrimary,
      onPress: () => actions.archive(row),
    },
  ];
  const leading: SwipeAction[] = row.unread
    ? [
        {
          id: "read",
          label: "Read",
          icon: "checkmark.circle.fill",
          fill: palette.success,
          ink: palette.onAccent,
          onPress: () => actions.markRead(row),
        },
      ]
    : [];

  const corners = {
    borderTopLeftRadius: first ? radius.float : 0,
    borderTopRightRadius: first ? radius.float : 0,
    borderBottomLeftRadius: last ? radius.float : 0,
    borderBottomRightRadius: last ? radius.float : 0,
  };

  return (
    <View
      style={[
        styles.card,
        corners,
        {
          backgroundColor: palette.surfaceElevated,
          borderColor: palette.borderDefault,
          borderTopWidth: first ? StyleSheet.hairlineWidth : 0,
          borderBottomWidth: last ? StyleSheet.hairlineWidth : 0,
        },
      ]}
    >
      <SwipeRow leading={leading} style={corners} trailing={trailing}>
        <Pressable
          accessibilityActions={[
            { name: "pin", label: pinned ? "Unpin" : "Pin" },
            { name: "archive", label: "Archive" },
            ...(row.unread ? [{ name: "read", label: "Mark read" }] : []),
          ]}
          accessibilityHint="Opens the chat. Long press for more."
          accessibilityLabel={[
            title,
            waiting ? "needs you" : null,
            failed ? "failed" : null,
            row.unread ? "unread" : null,
            running ? "working" : null,
            pinned ? "pinned" : null,
            detail.main,
            detail.sub,
            when,
          ]
            .filter(Boolean)
            .join(", ")}
          accessibilityRole="button"
          delayLongPress={320}
          onAccessibilityAction={(event) => {
            const name = event.nativeEvent.actionName;
            if (name === "pin") actions.setPinned(row, !pinned);
            else if (name === "archive") actions.archive(row);
            else if (name === "read") actions.markRead(row);
          }}
          onLongPress={() =>
            face.current?.measureInWindow((x, y, width, height) =>
              openMenu({ x, y, width, height }, menu, title),
            )
          }
          onPress={() => actions.open(row)}
          ref={face}
          style={({ pressed }) => [
            styles.row,
            corners,
            { backgroundColor: pressed ? palette.surface : palette.surfaceElevated },
          ]}
        >
          <View style={styles.lead}>
            <StatusDot status={status} />
          </View>
          <View style={styles.body}>
            <View style={styles.line}>
              <Text
                numberOfLines={1}
                style={[
                  text.subheadline,
                  styles.flex,
                  {
                    color: palette.textStrong,
                    fontWeight: row.unread || waiting ? weight.semibold : weight.medium,
                  },
                ]}
              >
                {title}
              </Text>
              {pinned ? <Icon color={palette.textSoft} name="pin.fill" size={10} /> : null}
              <Text
                maxFontSizeMultiplier={maxFontScale.chrome}
                style={[text.caption, styles.time, { color: palette.textSoft }]}
              >
                {when}
              </Text>
            </View>
            <View style={styles.line}>
              <Text
                numberOfLines={1}
                style={[
                  text.footnote,
                  styles.flex,
                  {
                    color:
                      detail.tone === "warning"
                        ? palette.warningText
                        : detail.tone === "danger"
                          ? palette.dangerText
                          : palette.textMuted,
                    fontWeight: detail.tone === "muted" ? weight.normal : weight.medium,
                  },
                ]}
              >
                {detail.main}
              </Text>
              {row.childCount > 0 ? (
                <View
                  accessibilityLabel={`${row.childCount} agents`}
                  style={[styles.meta, { backgroundColor: palette.overlaySubtle }]}
                >
                  <Icon color={palette.textSoft} name="person.2.fill" size={10} />
                  <Text
                    maxFontSizeMultiplier={maxFontScale.chrome}
                    style={[text.caption2, { color: palette.textMuted }]}
                  >
                    {row.childCount}
                  </Text>
                </View>
              ) : null}
              {waiting && row.pendingDialogs.length > 1 ? (
                <View style={[styles.meta, { backgroundColor: palette.warningTint }]}>
                  <Text
                    maxFontSizeMultiplier={maxFontScale.chrome}
                    style={[text.caption2, { color: palette.warningText }]}
                  >
                    {row.pendingDialogs.length}
                  </Text>
                </View>
              ) : null}
            </View>
            {detail.sub ? (
              <Text numberOfLines={1} style={[text.footnote, { color: palette.textSoft }]}>
                {detail.sub}
              </Text>
            ) : null}
          </View>
        </Pressable>
      </SwipeRow>
      {!last ? (
        <View style={[styles.separator, { backgroundColor: palette.borderDefault }]} />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.md,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: hitSize.min + 20,
    paddingVertical: spacing.md2,
    paddingRight: spacing.lg,
  },
  lead: { width: 32, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0, gap: 3 },
  line: { flexDirection: "row", alignItems: "center", gap: spacing.sm2 },
  flex: { flex: 1, minWidth: 0 },
  time: { fontVariant: ["tabular-nums"] },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minWidth: 20,
    height: 18,
    paddingHorizontal: spacing.sm2,
    borderRadius: radius.pill,
    justifyContent: "center",
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 32 },
});
