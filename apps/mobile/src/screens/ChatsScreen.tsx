import { LegendList } from "@legendapp/list/react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { buildHome, type ChatRow } from "../api/chats";
import { ChatListRow, type ChatRowActions } from "../features/home/ChatListRow";
import { ConnectionBanner } from "../features/home/ConnectionBanner";
import type { RootStackParamList } from "../navigation";
import { usePegasus } from "../state/PegasusProvider";
import { Button, EmptyState, Skeleton } from "../ui";
import { hitSize, radius, spacing, text, usePalette, weight } from "../theme";

type Item =
  | {
      readonly kind: "header";
      readonly key: string;
      readonly title: string;
      readonly workspaceId?: string;
    }
  | {
      readonly kind: "chat";
      readonly key: string;
      readonly row: ChatRow;
      readonly showProject: boolean;
    };

/** Sections where chats of several projects mix, so each row names its project. */
const MIXED = new Set(["needs-you", "working", "pinned", "results"]);

/**
 * Every chat on the PC, laid out like the desktop sidebar: Needs you, Working, Pinned, then each
 * project. Search in the header, pull to refresh, swipe a row for pin, archive and mark read.
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
        placeholder: "Search chats",
        hideWhenScrolling: true,
        autoCapitalize: "none",
        onChangeText: (event) => setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
      },
    });
  }, [navigation]);

  const items = useMemo<Item[]>(() => {
    if (!state) return [];
    const out: Item[] = [];
    for (const section of buildHome(state, query)) {
      out.push({
        kind: "header",
        key: `h:${section.key}`,
        title: section.title,
        ...(section.workspace ? { workspaceId: section.workspace.id } : {}),
      });
      for (const row of section.rows) {
        out.push({
          kind: "chat",
          key: `${section.key}/${row.workspace.id}/${row.session.id}`,
          row,
          showProject: MIXED.has(section.key),
        });
      }
    }
    return out;
  }, [state, query]);

  const fail = (what: string) => (reason: unknown) =>
    Alert.alert(what, reason instanceof Error ? reason.message : String(reason));

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
      <View style={styles.skeletons}>
        {[0, 1, 2, 3, 4].map((index) => (
          <Skeleton key={index} height={52} rounded={radius.md} />
        ))}
      </View>
    ) : null
  ) : query ? (
    <EmptyState
      title="No matching chats"
      message={`Nothing on this PC matches “${query.trim()}”.`}
    />
  ) : (
    <EmptyState
      title="No chats yet"
      message="Start one here, or on the PC; it shows up live."
      action={<Button label="New chat" onPress={() => navigation.navigate("NewChat")} />}
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
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        ListHeaderComponent={<ConnectionBanner />}
        renderItem={({ item }) =>
          item.kind === "header" ? (
            <View style={styles.header}>
              <Text
                accessibilityRole="header"
                numberOfLines={1}
                style={[text.footnote, styles.headerText, { color: palette.textMuted }]}
              >
                {item.title}
              </Text>
              {item.workspaceId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`New chat in ${item.title}`}
                  hitSlop={10}
                  onPress={() => navigation.navigate("NewChat", { workspaceId: item.workspaceId })}
                  style={styles.headerAction}
                >
                  <Text style={[text.headline, { color: palette.textMuted }]}>+</Text>
                </Pressable>
              ) : null}
            </View>
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
      {state ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
          onPress={() => navigation.navigate("NewChat")}
          style={({ pressed }) => [
            styles.fab,
            {
              bottom: insets.bottom + spacing.lg,
              backgroundColor: palette.primaryFill,
              shadowColor: palette.shadow,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            },
          ]}
        >
          <Text style={[text.headline, { color: palette.onPrimary }]}>New chat</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  skeletons: { gap: spacing.sm, padding: spacing.lg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: spacing.xl,
    paddingRight: spacing.md,
    paddingTop: spacing.lg,
    minHeight: hitSize.compact + spacing.lg,
  },
  headerText: { flex: 1, fontWeight: weight.semibold },
  headerAction: {
    minWidth: hitSize.compact,
    minHeight: hitSize.compact,
    alignItems: "center",
    justifyContent: "center",
  },
  fab: {
    position: "absolute",
    right: spacing.lg,
    minHeight: hitSize.min + 4,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
});
