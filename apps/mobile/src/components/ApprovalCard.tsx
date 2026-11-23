import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Platform, StyleSheet, Text, TextInput, View } from "react-native";
import type { PendingDialog, PendingDialogAnswer } from "../api/types";
import { Button, Icon, PressableScale } from "../ui";
import { hitSize, maxFontScale, radius, spacing, text, usePalette } from "../theme";

const KIND_LABELS: Record<PendingDialog["kind"], string> = {
  confirm: "Approval needed",
  select: "Choice needed",
  input: "Input needed",
  editor: "Input needed",
};

/**
 * One extension dialog the PC is waiting on, drawn inline at the end of the work log. The PC owns
 * the dialog: it stays on screen until the host reports the answer and drops it from
 * `pendingDialogs`, so nothing is dismissed optimistically and a failed answer leaves the card up
 * with the reason. Mount it with `key={dialog.requestId}` so a new dialog starts with its own draft.
 */
export function ApprovalCard({
  dialog,
  waiting,
  onAnswer,
}: {
  readonly dialog: PendingDialog;
  /** How many dialogs wait in all, so one card's place in the line is visible. */
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
    const declined = "cancelled" in answer || ("confirmed" in answer && !answer.confirmed);
    Haptics.impactAsync(
      declined ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Medium,
    ).catch(() => undefined);
    void onAnswer(answer)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      })
      .finally(() => setSending(false));
  };

  const answerWith = (value: string) => respond({ requestId: dialog.requestId, value });
  const confirm = dialog.kind === "confirm";

  return (
    <View
      accessibilityLabel={`${KIND_LABELS[dialog.kind]}: ${dialog.title}`}
      style={[
        styles.card,
        {
          backgroundColor: palette.surfaceElevated,
          borderColor: confirm ? palette.warning : palette.accent,
        },
      ]}
    >
      <View style={styles.head}>
        <View
          style={[
            styles.badge,
            { backgroundColor: confirm ? palette.warningTint : palette.accentTint },
          ]}
        >
          <Text
            maxFontSizeMultiplier={maxFontScale.chrome}
            style={[text.caption2, { color: confirm ? palette.warningText : palette.accentText }]}
          >
            {KIND_LABELS[dialog.kind]}
          </Text>
        </View>
        {waiting && waiting > 1 ? (
          <Text style={[text.caption, { color: palette.textMuted }]}>{waiting} waiting</Text>
        ) : null}
      </View>
      <Text accessibilityRole="header" style={[text.headline, { color: palette.textStrong }]}>
        {dialog.title}
      </Text>

      {dialog.kind === "confirm" && dialog.message ? (
        <Text
          selectable
          style={[styles.message, { color: palette.text, backgroundColor: palette.codeBlock }]}
        >
          {dialog.message}
        </Text>
      ) : null}

      {dialog.kind === "select" ? (
        <View style={styles.options}>
          {dialog.options.map((option, index) => (
            <PressableScale
              accessibilityRole="button"
              accessibilityState={{ disabled: sending }}
              disabled={sending}
              key={`${index}:${option}`}
              onPress={() => answerWith(option)}
              pressedStyle={{ backgroundColor: palette.overlayActive }}
              style={[
                styles.option,
                {
                  backgroundColor: palette.surface,
                  borderColor: palette.borderDefault,
                  opacity: sending ? 0.5 : 1,
                },
              ]}
            >
              <Text style={[text.callout, styles.flex, { color: palette.text }]}>{option}</Text>
              <Icon name="chevron.right" color={palette.textSoft} size={13} weight="semibold" />
            </PressableScale>
          ))}
        </View>
      ) : null}

      {dialog.kind === "input" ? (
        <TextInput
          accessibilityLabel={dialog.title}
          editable={!sending}
          onChangeText={setDraft}
          onSubmitEditing={() => answerWith(draft)}
          placeholder={dialog.placeholder ?? "Enter a value"}
          placeholderTextColor={palette.textSoft}
          returnKeyType="send"
          style={[
            styles.input,
            {
              backgroundColor: palette.background,
              borderColor: palette.borderDefault,
              color: palette.text,
            },
          ]}
          value={draft}
        />
      ) : null}

      {dialog.kind === "editor" ? (
        <TextInput
          accessibilityLabel={dialog.title}
          editable={!sending}
          multiline
          onChangeText={setDraft}
          placeholder="Enter a value"
          placeholderTextColor={palette.textSoft}
          style={[
            styles.editor,
            {
              backgroundColor: palette.background,
              borderColor: palette.borderDefault,
              color: palette.text,
            },
          ]}
          value={draft}
        />
      ) : null}

      {error ? (
        <Text accessibilityRole="alert" style={[text.footnote, { color: palette.dangerText }]}>
          {error}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {dialog.kind === "confirm" ? (
          <>
            <Button
              busy={sending}
              label="Allow once"
              onPress={() => respond({ requestId: dialog.requestId, confirmed: true })}
              style={styles.flex}
              variant="primary"
            />
            <Button
              disabled={sending}
              label="Decline"
              onPress={() => respond({ requestId: dialog.requestId, confirmed: false })}
              style={styles.flex}
              variant="destructive"
            />
          </>
        ) : dialog.kind === "select" ? null : (
          <Button
            busy={sending}
            label="Submit"
            onPress={() => answerWith(draft)}
            style={styles.flex}
            variant="primary"
          />
        )}
      </View>
      <PressableScale
        accessibilityHint="Tells the agent you will not answer now"
        accessibilityRole="button"
        disabled={sending}
        onPress={() => respond({ requestId: dialog.requestId, cancelled: true })}
        style={styles.later}
      >
        <Text style={[text.subheadline, { color: palette.textMuted }]}>Not now</Text>
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
    gap: spacing.md,
    borderRadius: radius.float,
    borderWidth: 1,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  badge: { paddingHorizontal: spacing.sm2, paddingVertical: spacing.xxs, borderRadius: radius.sm2 },
  message: {
    ...text.footnote,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    padding: spacing.md,
    borderRadius: radius.md2,
    overflow: "hidden",
  },
  options: { gap: spacing.sm },
  option: {
    minHeight: hitSize.min,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  flex: { flex: 1 },
  input: {
    minHeight: hitSize.min,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    ...text.callout,
  },
  editor: {
    minHeight: 120,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    ...text.footnote,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    textAlignVertical: "top",
  },
  actions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  later: {
    minHeight: hitSize.min,
    alignSelf: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
});
