import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import type { TranscriptItem } from "../api/types";
import { Markdown } from "../components/Markdown";
import { usePegasus } from "../state/PegasusProvider";
import { radius, spacing, type, usePalette } from "../theme";
import type { RootStackParamList } from "../navigation";

/** One chat: its transcript as it streams in, and a composer that sends, steers or stops. */
export function ChatScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, "Chat">) {
  const { workspaceId, sessionId, title } = route.params;
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { state, transcript, openChat, send, stop } = usePegasus();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const list = useRef<LegendListRef>(null);

  useEffect(() => {
    navigation.setOptions({ title: title || "Chat" });
    openChat({ workspaceId, sessionId }).catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [navigation, openChat, sessionId, title, workspaceId]);

  const session = useMemo(
    () =>
      state?.workspaces.find((w) => w.id === workspaceId)?.sessions.find((s) => s.id === sessionId),
    [state, workspaceId, sessionId],
  );
  const running = session?.status === "running";
  // Only this chat's transcript, once the PC has switched this phone's view to it.
  const items = useMemo(
    () =>
      transcript?.workspaceId === workspaceId && transcript.sessionId === sessionId
        ? transcript.transcript.filter(isShown)
        : null,
    [transcript, workspaceId, sessionId],
  );

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await send(text, running);
      setDraft("");
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      list.current?.scrollToEnd({ animated: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: palette.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={insets.top + 44}
    >
      {items === null ? (
        <View style={styles.loading}>
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : (
        <LegendList
          ref={list}
          data={items}
          keyExtractor={(item) => item.id}
          estimatedItemSize={120}
          initialScrollIndex={Math.max(0, items.length - 1)}
          maintainScrollAtEnd
          maintainVisibleContentPosition
          alignItemsAtEnd
          contentContainerStyle={styles.content}
          renderItem={({ item }) => <Row item={item} />}
        />
      )}
      {error ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>
          {error}
        </Text>
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
          value={draft}
          onChangeText={setDraft}
          placeholder={running ? "Steer this run…" : "Message"}
          placeholderTextColor={palette.textMuted}
          multiline
          style={[styles.input, { color: palette.text }]}
        />
        {running ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop"
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
          accessibilityRole="button"
          accessibilityLabel={running ? "Steer" : "Send"}
          disabled={!draft.trim() || sending}
          onPress={() => {
            submit().catch(() => undefined);
          }}
          style={[
            styles.roundButton,
            { backgroundColor: palette.accent, opacity: draft.trim() ? 1 : 0.4 },
          ]}
        >
          <Text style={[styles.sendGlyph, { color: palette.onAccent }]}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function isShown(item: TranscriptItem): boolean {
  return ["message", "thinking", "tool", "activity", "custom"].includes(item.kind);
}

const Row = memo(function Row({ item }: { readonly item: TranscriptItem }) {
  const palette = usePalette();
  if (item.kind === "message" && "role" in item) {
    if (item.role === "user") {
      return (
        <View style={[styles.userBubble, { backgroundColor: palette.userBubble }]}>
          <Text selectable style={[styles.userText, { color: palette.text }]}>
            {item.text}
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.assistant}>
        <Markdown text={item.text} />
      </View>
    );
  }
  if (item.kind === "custom" && "text" in item) {
    return (
      <View style={styles.assistant}>
        <Markdown text={item.text} />
      </View>
    );
  }
  if (item.kind === "tool" && "label" in item && "status" in item) {
    const color =
      item.status === "error"
        ? palette.danger
        : item.status === "running"
          ? palette.accentText
          : palette.textMuted;
    return (
      <Text numberOfLines={2} style={[styles.tool, { color }]}>
        {item.status === "running" ? "● " : item.status === "error" ? "✕ " : "✓ "}
        {item.label}
      </Text>
    );
  }
  if (
    (item.kind === "thinking" || item.kind === "activity") &&
    ("text" in item || "label" in item)
  ) {
    const text = "text" in item ? item.text : "label" in item ? item.label : "";
    return (
      <Text numberOfLines={3} style={[styles.thinking, { color: palette.textMuted }]}>
        {text}
      </Text>
    );
  }
  return null;
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
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
  tool: { fontSize: 13, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
  thinking: { fontSize: 14, fontStyle: "italic", lineHeight: 20 },
  error: { fontSize: 14, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, fontSize: type.body, maxHeight: 140, paddingVertical: 10 },
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
