import { LegendList } from "@legendapp/list/react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { buildHome, type ChatRow } from "../api/chats";
import { ChatListRow, type ChatRowActions } from "../features/home/ChatListRow";
import { ConnectionBanner } from "../features/home/ConnectionBanner";
import { homeItems, type HomeItem } from "../features/home/home-items";
import type { RootStackParamList } from "../navigation";
import { usePegasus } from "../state/PegasusProvider";
import { Button, EmptyState, Icon, Skeleton } from "../ui";
import { hitSize, maxFontScale, radius, spacing, text, usePalette, weight } from "../theme";

/**
 * Every chat on the PC, laid out like the desktop sidebar: Needs you, Working, Pinned, then every
 * project (new ones arrive live with the PC's state). Large title with search, pull to refresh,
 * swipe or long press a row for pin, archive and mark read, compose and settings in the bar.
 */
export function ChatsScreen({ navigation }: NativeStackScreenProps<RootStackParamList, "Chats">) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { state, status, refresh, setPinned, archive, unarchive, markRead } = usePegasus();
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  // Relative times tick once a minute, not on every state change.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: "Search chats and projects",
        hideWhenScrolling: true,
        autoCapitalize: "none",
        onChangeText: (event) => setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
      },
      unstable_headerLeftItems: () => [
        {
          type: "button",
          label: "Settings",
          icon: { type: "sfSymbol", name: "gearshape" },
          accessibilityLabel: "Settings",
          onPress: () => navigation.navigate("Settings"),
        },
      ],
      unstable_headerRightItems: () => [
        {
          type: "button",
          label: "New chat",
          icon: { type: "sfSymbol", name: "square.and.pencil" },
          accessibilityLabel: "New chat",
          disabled: !state,
          onPress: () => navigation.navigate("NewChat"),
        },
      ],
    });
  }, [navigation, state === null]);

  const items = useMemo<HomeItem[]>(
    () => (state ? homeItems(buildHome(state, query)) : []),
    [state, query],
  );

  const fail = (what: string) => (reason: unknown) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    Alert.alert(what, reason instanceof Error ? reason.message : String(reason));
  };

  const actions = useMemo<ChatRowActions>(
    () => ({
      open: (row) =>
        navigation.navigate("Chat", {
          workspaceId: row.workspace.id,
          sessionId: row.session.id,
          title: row.session.title,
        }),
      setPinned: (row, pinned) => {
        void Haptics.selectionAsync().catch(() => undefined);
        setPinned({ workspaceId: row.workspace.id, sessionId: row.session.id }, pinned).catch(
          fail(pinned ? "Could not pin" : "Could not unpin"),
        );
      },
      archive: (row) => {
        const target = { workspaceId: row.workspace.id, sessionId: row.session.id };
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        archive(target)
          .then(() =>
            Alert.alert("Chat archived", row.session.title || "Untitled chat", [
              { text: "Undo", onPress: () => void unarchive(target).catch(fail("Could not undo")) },
              { text: "OK", style: "cancel" },
            ]),
          )
          .catch(fail("Could not archive"));
      },
      markRead: (row) => {
        markRead({ workspaceId: row.workspace.id, sessionId: row.session.id }).catch(
          fail("Could not mark read"),
        );
      },
      newChatIn: (row: ChatRow) =>
        navigation.navigate("NewChat", {
          workspaceId:
            row.workspace.kind === "worktree" && row.workspace.rootWorkspaceId
              ? row.workspace.rootWorkspaceId
              : row.workspace.id,
        }),
    }),
    [navigation, setPinned, archive, unarchive, markRead],
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refresh()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, [refresh]);

  const empty = !state ? (
    status.state === "connecting" ? (
      <View accessible accessibilityLabel="Loading chats" style={styles.skeletons}>
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <View key={index} style={styles.skeletonRow}>
            <Skeleton width="62%" height={15} />
            <Skeleton width="88%" height={12} />
          </View>
        ))}
      </View>
    ) : (
      <EmptyState
        icon="wifi.exclamationmark"
        title="Can't reach your PC"
        message="Check that Pegasus is open on the PC and Tailscale is on for both devices."
        action={<Button label="Try again" onPress={onRefresh} variant="secondary" />}
      />
    )
  ) : query ? (
    <EmptyState
      icon="magnifyingglass"
      title="No matches"
      message={`Nothing on this PC matches “${query.trim()}”. Search looks at titles, previews and project names.`}
    />
  ) : (
    <EmptyState
      icon="bubble.left.and.bubble.right"
      title="No projects yet"
      message="Add a project in Pegasus on the PC; it shows up here live."
    />
  );

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <LegendList
        data={items}
        keyExtractor={(item) => item.key}
        estimatedItemSize={60}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        getItemType={(item) => item.kind}
        recycleItems
        refreshing={refreshing}
        onRefresh={onRefresh}
        extraData={nowMs}
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
        ListHeaderComponent={<ConnectionBanner />}
        renderItem={({ item }) =>
          item.kind === "header" ? (
            <View style={styles.header}>
              {item.icon ? (
                <Icon
                  name={item.icon}
                  color={item.tint ? palette[item.tint] : palette.textSoft}
                  size={13}
                />
              ) : null}
              <Text
                accessibilityRole="header"
                numberOfLines={1}
                style={[text.footnote, styles.headerText, { color: palette.textMuted }]}
              >
                {item.title}
              </Text>
              {item.count > 0 ? (
                <Text
                  maxFontSizeMultiplier={maxFontScale.chrome}
                  style={[text.caption, { color: palette.textSoft }]}
                >
                  {item.count}
                </Text>
              ) : null}
              {item.workspaceId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`New chat in ${item.title}`}
                  hitSlop={6}
                  onPress={() => navigation.navigate("NewChat", { workspaceId: item.workspaceId })}
                  style={({ pressed }) => [
                    styles.headerAction,
                    pressed ? { backgroundColor: palette.overlayActive } : null,
                  ]}
                >
                  <Icon name="plus" color={palette.textMuted} size={15} />
                </Pressable>
              ) : null}
            </View>
          ) : item.kind === "placeholder" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`No chats in ${item.projectName}. Start one.`}
              onPress={() => navigation.navigate("NewChat", { workspaceId: item.workspaceId })}
              style={({ pressed }) => [
                styles.placeholder,
                pressed ? { backgroundColor: palette.overlayActive } : null,
              ]}
            >
              <Text style={[text.footnote, { color: palette.textSoft }]}>
                No chats yet · <Text style={{ color: palette.accentText }}>Start one</Text>
              </Text>
            </Pressable>
          ) : (
            <ChatListRow
              row={item.row}
              showProject={item.showProject}
              actions={actions}
              nowMs={nowMs}
            />
          )
        }
        ListEmptyComponent={empty}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  skeletons: { gap: spacing.lg, padding: spacing.xl },
  skeletonRow: { gap: spacing.sm },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm2,
    paddingLeft: spacing.xl,
    paddingRight: spacing.md,
    paddingTop: spacing.lg,
    minHeight: hitSize.compact + spacing.lg,
  },
  headerText: { flexShrink: 1, fontWeight: weight.semibold },
  headerAction: {
    marginLeft: "auto",
    width: hitSize.compact,
    height: hitSize.compact,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholder: {
    marginHorizontal: spacing.gutter,
    paddingLeft: 28 + spacing.xs,
    minHeight: hitSize.min,
    justifyContent: "center",
    borderRadius: radius.md,
  },
});
