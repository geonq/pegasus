import { LegendList } from "@legendapp/list/react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { buildHome, type ChatRow } from "../api/chats";
import { ChatListRow, type ChatRowActions } from "../features/home/ChatListRow";
import { ConnectionBanner } from "../features/home/ConnectionBanner";
import { homeItems, type HomeItem } from "../features/home/home-items";
import type { RootStackParamList } from "../navigation";
import { usePegasus } from "../state/PegasusProvider";
import {
  BarButton,
  Button,
  EmptyState,
  Icon,
  PageTitle,
  Skeleton,
  TopBar,
  useOverlay,
} from "../ui";
import { hitSize, maxFontScale, radius, spacing, text, usePalette, weight } from "../theme";

/**
 * Every chat on the PC, laid out like the desktop sidebar: Needs you, Working, Pinned, then every
 * project (new ones arrive live with the PC's state), each section one floating card of rows.
 * Pegasus top bar with settings and new chat, the PC's name as the page title with its connection,
 * a search field, pull to refresh, swipe or long press a row for pin, archive and mark read.
 */
export function ChatsScreen({ navigation }: NativeStackScreenProps<RootStackParamList, "Chats">) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const overlay = useOverlay();
  const { state, status, pairing, refresh, setPinned, archive, unarchive, markRead } = usePegasus();
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const scrollY = useSharedValue(0);
  // Relative times tick once a minute, not on every state change.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const items = useMemo<HomeItem[]>(
    () => (state ? homeItems(buildHome(state, query)) : []),
    [state, query],
  );

  const actions = useMemo<ChatRowActions>(() => {
    const fail = (what: string) => (reason: unknown) =>
      overlay.toast({
        message: `${what}: ${reason instanceof Error ? reason.message : String(reason)}`,
        tone: "danger",
      });
    return {
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
            overlay.toast({
              message: `Archived “${row.session.title || "Untitled chat"}”`,
              action: {
                label: "Undo",
                onPress: () => void unarchive(target).catch(fail("Could not undo")),
              },
            }),
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
    };
  }, [navigation, overlay, setPinned, archive, unarchive, markRead]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refresh()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, [refresh]);

  const live = status.state === "live";
  const connection = live
    ? "Connected"
    : status.state === "connecting"
      ? "Connecting…"
      : status.state === "retrying"
        ? "Offline"
        : "Key revoked";
  const header = (
    <View>
      <PageTitle
        detail={
          <View accessible style={styles.host}>
            <View
              style={[
                styles.liveDot,
                {
                  backgroundColor: live
                    ? palette.success
                    : status.state === "connecting"
                      ? palette.statusNeutral
                      : palette.warning,
                },
              ]}
            />
            <Text
              maxFontSizeMultiplier={maxFontScale.chrome}
              style={[text.footnote, { color: palette.textMuted }]}
            >
              {connection}
              {state ? ` · ${projectCount(items)} projects` : ""}
            </Text>
          </View>
        }
        title={pairing?.hostName ?? "Pegasus"}
      />
      <View style={[styles.search, { backgroundColor: palette.overlayHover }]}>
        <Icon color={palette.textSoft} name="magnifyingglass" size={14} />
        <TextInput
          accessibilityLabel="Search chats and projects"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          onChangeText={setQuery}
          placeholder="Search chats and projects"
          placeholderTextColor={palette.textSoft}
          returnKeyType="search"
          style={[text.body, styles.searchInput, { color: palette.textStrong }]}
          value={query}
        />
      </View>
      <ConnectionBanner />
    </View>
  );

  const empty = !state ? (
    status.state === "connecting" ? (
      <View accessible accessibilityLabel="Loading chats" style={styles.skeletons}>
        {[0, 1, 2, 3, 4].map((index) => (
          <View key={index} style={styles.skeletonRow}>
            <Skeleton width={8} height={8} rounded={4} />
            <View style={styles.skeletonText}>
              <Skeleton width="58%" height={14} />
              <Skeleton width="86%" height={11} />
            </View>
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
      icon="folder.badge.plus"
      title="No projects yet"
      message="Add a project in Pegasus on the PC; it shows up here live."
    />
  );

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <TopBar
        leading={
          <BarButton
            accessibilityLabel="Settings"
            icon="gearshape"
            onPress={() => navigation.navigate("Settings")}
          />
        }
        scrollY={scrollY}
        trailing={
          <BarButton
            accessibilityLabel="New chat"
            disabled={!state}
            icon="square.and.pencil"
            onPress={() => navigation.navigate("NewChat")}
            tone="primary"
          />
        }
      />
      <LegendList
        ListEmptyComponent={empty}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }}
        data={items}
        estimatedItemSize={64}
        extraData={nowMs}
        getItemType={(item) => item.kind}
        keyExtractor={(item) => item.key}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => {
          scrollY.value = event.nativeEvent.contentOffset.y;
        }}
        recycleItems
        refreshControl={
          <RefreshControl
            onRefresh={onRefresh}
            refreshing={refreshing}
            tintColor={palette.textMuted}
          />
        }
        renderItem={({ item, index }) => {
          if (item.kind === "header") {
            return (
              <View style={styles.header}>
                {item.icon ? (
                  <Icon
                    color={item.tint ? palette[item.tint] : palette.textSoft}
                    name={item.icon}
                    size={12}
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
                    style={[text.caption, styles.count, { color: palette.textSoft }]}
                  >
                    {item.count}
                  </Text>
                ) : null}
                {item.workspaceId ? (
                  <Pressable
                    accessibilityLabel={`New chat in ${item.title}`}
                    accessibilityRole="button"
                    hitSlop={6}
                    onPress={() =>
                      navigation.navigate("NewChat", { workspaceId: item.workspaceId })
                    }
                    style={({ pressed }) => [
                      styles.headerAction,
                      pressed ? { backgroundColor: palette.overlayActive } : null,
                    ]}
                  >
                    <Icon color={palette.textMuted} name="plus" size={14} weight="semibold" />
                  </Pressable>
                ) : null}
              </View>
            );
          }
          if (item.kind === "placeholder") {
            return (
              <Pressable
                accessibilityLabel={`No chats in ${item.projectName}. Start one.`}
                accessibilityRole="button"
                onPress={() => navigation.navigate("NewChat", { workspaceId: item.workspaceId })}
                style={({ pressed }) => [
                  styles.placeholder,
                  {
                    borderColor: palette.borderHeavy,
                    backgroundColor: pressed ? palette.overlayHover : "transparent",
                  },
                ]}
              >
                <Icon color={palette.textSoft} name="plus.bubble" size={15} />
                <Text style={[text.footnote, { color: palette.textMuted }]}>
                  No chats yet ·{" "}
                  <Text style={{ color: palette.accentText, fontWeight: weight.semibold }}>
                    Start one
                  </Text>
                </Text>
              </Pressable>
            );
          }
          return (
            <ChatListRow
              actions={actions}
              first={items[index - 1]?.kind !== "chat"}
              last={items[index + 1]?.kind !== "chat"}
              nowMs={nowMs}
              row={item.row}
              showProject={item.showProject}
            />
          );
        }}
        scrollEventThrottle={16}
      />
    </View>
  );
}

function projectCount(items: readonly HomeItem[]): number {
  return items.filter((item) => item.kind === "header" && item.workspaceId).length;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  host: { flexDirection: "row", alignItems: "center", gap: spacing.sm2 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.md,
    minHeight: hitSize.min - 4,
    borderRadius: radius.md,
  },
  searchInput: { flex: 1, paddingVertical: spacing.sm },
  skeletons: { gap: spacing.xl, paddingHorizontal: spacing.xl, paddingTop: spacing.xl },
  skeletonRow: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  skeletonText: { flex: 1, gap: spacing.sm },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm2,
    paddingLeft: spacing.xl,
    paddingRight: spacing.md + spacing.xs,
    paddingTop: spacing.lg2,
    paddingBottom: spacing.sm,
    minHeight: hitSize.compact + spacing.lg2,
  },
  headerText: { flexShrink: 1, fontWeight: weight.semibold },
  count: { fontVariant: ["tabular-nums"] },
  headerAction: {
    marginLeft: "auto",
    width: hitSize.compact,
    height: hitSize.compact,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholder: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: hitSize.min + 8,
    borderRadius: radius.float,
    borderWidth: 1,
    borderStyle: "dashed",
  },
});
