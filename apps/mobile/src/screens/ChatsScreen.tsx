import { LegendList } from "@legendapp/list/react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { orderChats, SECTION_TITLES, waitingLabel, type ChatRow } from "../api/chats";
import { StatusDot } from "../components/StatusDot";
import { usePegasus } from "../state/PegasusProvider";
import { radius, spacing, type, usePalette } from "../theme";
import type { RootStackParamList } from "../navigation";

type Row =
  | { readonly kind: "header"; readonly title: string; readonly key: string }
  | (ChatRow & { readonly kind: "chat"; readonly key: string });

/** Every chat on the PC: Needs you, then Working, then Recent, like the desktop sidebar. */
export function ChatsScreen({ navigation }: NativeStackScreenProps<RootStackParamList, "Chats">) {
  const palette = usePalette();
  const { state, status, pairing, forget } = usePegasus();

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let section: string | undefined;
    for (const chat of orderChats(
      state?.workspaces ?? [],
      state?.sessionExtensionUiBySession ?? {},
    )) {
      if (chat.section !== section) {
        section = chat.section;
        out.push({ kind: "header", title: SECTION_TITLES[chat.section], key: `h:${chat.section}` });
      }
      out.push({ ...chat, kind: "chat", key: `${chat.workspace.id}/${chat.session.id}` });
    }
    return out;
  }, [state]);

  const banner =
    status.state === "retrying"
      ? `${status.reason} Retrying in ${Math.round(status.inMs / 1000)} s. Showing the last update.`
      : status.state === "revoked"
        ? status.reason
        : status.state === "connecting" && !state
          ? `Connecting to ${pairing?.hostName ?? "your PC"}…`
          : null;

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      {banner ? (
        <View style={[styles.banner, { backgroundColor: palette.surfaceRaised }]}>
          <Text style={[styles.bannerText, { color: palette.textMuted }]}>{banner}</Text>
          {status.state === "revoked" ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => {
                forget().catch((reason: unknown) =>
                  Alert.alert("Could not unpair", String(reason)),
                );
              }}
            >
              <Text style={[styles.bannerAction, { color: palette.accentText }]}>Pair again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <LegendList
        data={rows}
        keyExtractor={(row) => row.key}
        estimatedItemSize={64}
        contentInsetAdjustmentBehavior="automatic"
        getItemType={(row) => row.kind}
        recycleItems
        renderItem={({ item }) =>
          item.kind === "header" ? (
            <Text style={[styles.header, { color: palette.textMuted }]}>{item.title}</Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                navigation.navigate("Chat", {
                  workspaceId: item.workspace.id,
                  sessionId: item.session.id,
                  title: item.session.title,
                })
              }
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: pressed ? palette.surfaceRaised : palette.surface,
                  borderColor: palette.line,
                },
              ]}
            >
              <StatusDot section={item.section} />
              <View style={styles.rowText}>
                <Text numberOfLines={1} style={[styles.rowTitle, { color: palette.text }]}>
                  {item.session.title || "Untitled chat"}
                </Text>
                <Text numberOfLines={1} style={[styles.rowDetail, { color: palette.textMuted }]}>
                  {waitingLabel(item.pendingDialogs) ??
                    (item.session.status === "running" && item.session.currentStep
                      ? item.session.currentStep
                      : item.session.status === "failed"
                        ? "Stopped with an error"
                        : item.session.preview || item.workspace.name)}
                </Text>
              </View>
              {item.pendingDialogs.length > 0 ? (
                <View style={[styles.waitChip, { backgroundColor: palette.warning }]}>
                  <Text style={[styles.waitChipText, { color: palette.background }]}>
                    {item.pendingDialogs.length}
                  </Text>
                </View>
              ) : (
                <Text style={[styles.project, { color: palette.textMuted }]} numberOfLines={1}>
                  {item.workspace.name}
                </Text>
              )}
            </Pressable>
          )
        }
        ListEmptyComponent={
          state ? (
            <Text style={[styles.empty, { color: palette.textMuted }]}>
              No chats yet on this PC.
            </Text>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  bannerText: { flex: 1, fontSize: type.caption, lineHeight: 16 },
  bannerAction: { fontSize: type.caption, fontWeight: "600" },
  waitChip: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  waitChipText: { fontSize: type.caption, fontWeight: "700" },
  header: {
    fontSize: type.caption,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginVertical: 3,
    paddingHorizontal: spacing.lg,
    minHeight: 60,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: type.body, fontWeight: "600" },
  rowDetail: { fontSize: 14 },
  project: { fontSize: type.caption, maxWidth: 96 },
  empty: { textAlign: "center", marginTop: 48, fontSize: type.body },
});
