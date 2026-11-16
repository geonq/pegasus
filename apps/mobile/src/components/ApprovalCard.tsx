import { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { PendingDialog, PendingDialogAnswer } from "../api/types";
import { radius, spacing, type, usePalette } from "../theme";

const KIND_LABELS: Record<PendingDialog["kind"], string> = {
  confirm: "Approval needed",
  select: "Choice needed",
  input: "Input needed",
  editor: "Input needed",
};

/**
 * One extension dialog the PC is waiting on. The PC owns the dialog: it stays on screen until the
 * host reports the answer and drops it from `pendingDialogs`, so nothing is dismissed optimistically
 * and a failed answer leaves the card up with the reason. Mount it with
 * `key={dialog.requestId}` so a new dialog starts with its own draft.
 */
export function ApprovalCard({
  dialog,
  waiting,
  onAnswer,
}: {
  readonly dialog: PendingDialog;
  /** How many dialogs wait in all, so one card's place in the lock is visible. */
  readonly waiting?: number;
  readonly onAnswer: (answer: PendingDialogAnswer) => Promise<void>;
}) {
  const palette = usePalette();
  const [draft, setDraft] = useState(
    dialog.kind === "input" || dialog.kind === "editor" ? (dialog.initialValue ?? "") : "",
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = (answer: PendingDialogAnswer) => {
    if (sending) return;
    setSending(true);
    setError(null);
    void onAnswer(answer)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setSending(false));
  };

  const answerWith = (value: string) => respond({ requestId: dialog.requestId, value });

  return (
    <View
      accessibilityRole="summary"
      style={[
        styles.card,
        { backgroundColor: palette.surfaceRaised, borderColor: palette.warning },
      ]}
    >
      <View style={styles.head}>
        <Text style={[styles.kind, { color: palette.warning }]}>{KIND_LABELS[dialog.kind]}</Text>
        {waiting && waiting > 1 ? (
          <Text style={[styles.count, { color: palette.textMuted }]}>{waiting} waiting</Text>
        ) : null}
      </View>
      <Text style={[styles.title, { color: palette.text }]}>{dialog.title}</Text>

      {dialog.kind === "confirm" ? (
        <Text style={[styles.message, { color: palette.textMuted }]}>{dialog.message}</Text>
      ) : null}

      {dialog.kind === "select" ? (
        <View style={styles.options}>
          {dialog.options.map((option, index) => (
            <Pressable
              accessibilityRole="button"
              disabled={sending}
              key={`${index}:${option}`}
              onPress={() => answerWith(option)}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor: pressed ? palette.surface : palette.background,
                  borderColor: palette.line,
                  opacity: sending ? 0.5 : 1,
                },
              ]}
            >
              <Text style={[styles.optionText, { color: palette.text }]}>{option}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {dialog.kind === "input" ? (
        <TextInput
          editable={!sending}
          onChangeText={setDraft}
          onSubmitEditing={() => answerWith(draft)}
          placeholder={dialog.placeholder ?? "Enter a value"}
          placeholderTextColor={palette.textMuted}
          returnKeyType="done"
          style={[
            styles.input,
            { backgroundColor: palette.background, borderColor: palette.line, color: palette.text },
          ]}
          value={draft}
        />
      ) : null}

      {dialog.kind === "editor" ? (
        <TextInput
          editable={!sending}
          multiline
          onChangeText={setDraft}
          placeholder="Enter a value"
          placeholderTextColor={palette.textMuted}
          style={[
            styles.editor,
            { backgroundColor: palette.background, borderColor: palette.line, color: palette.text },
          ]}
          value={draft}
        />
      ) : null}

      {error ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>
          {error}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {dialog.kind === "confirm" ? (
          <>
            <Pressable
              accessibilityRole="button"
              disabled={sending}
              onPress={() => respond({ requestId: dialog.requestId, confirmed: true })}
              style={({ pressed }) => [
                styles.button,
                {
                  backgroundColor: palette.accent,
                  opacity: sending ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              {sending ? (
                <ActivityIndicator color={palette.onAccent} />
              ) : (
                <Text style={[styles.primaryText, { color: palette.onAccent }]}>Allow once</Text>
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={sending}
              onPress={() => respond({ requestId: dialog.requestId, confirmed: false })}
              style={({ pressed }) => [
                styles.button,
                {
                  backgroundColor: pressed ? palette.surface : "transparent",
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: palette.line,
                },
              ]}
            >
              <Text style={[styles.buttonText, { color: palette.danger }]}>Decline</Text>
            </Pressable>
          </>
        ) : dialog.kind === "select" ? null : (
          <Pressable
            accessibilityRole="button"
            disabled={sending}
            onPress={() => answerWith(draft)}
            style={({ pressed }) => [
              styles.button,
              {
                backgroundColor: palette.accent,
                opacity: sending ? 0.5 : pressed ? 0.85 : 1,
              },
            ]}
          >
            {sending ? (
              <ActivityIndicator color={palette.onAccent} />
            ) : (
              <Text style={[styles.primaryText, { color: palette.onAccent }]}>Submit</Text>
            )}
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          disabled={sending}
          onPress={() => respond({ requestId: dialog.requestId, cancelled: true })}
          style={styles.later}
        >
          <Text style={[styles.laterText, { color: palette.textMuted }]}>Not now</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  kind: {
    fontSize: type.caption,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  count: { fontSize: type.caption },
  title: { fontSize: type.body, fontWeight: "600" },
  message: { fontSize: 14, lineHeight: 20 },
  options: { gap: spacing.xs },
  option: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  optionText: { fontSize: type.body },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: type.body,
  },
  editor: {
    minHeight: 120,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 15,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
  },
  error: { fontSize: 14 },
  actions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  button: {
    minHeight: 44,
    minWidth: 110,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
  },
  primaryText: { fontSize: type.body, fontWeight: "600" },
  buttonText: { fontSize: type.body, fontWeight: "600" },
  later: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.sm },
  laterText: { fontSize: 15 },
});
