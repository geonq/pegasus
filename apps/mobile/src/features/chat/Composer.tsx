import * as Haptics from "expo-haptics";
import { useState, type ReactNode } from "react";
import {
  ActionSheetIOS,
  Alert,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { QueuedComposerMessage } from "../../api/types";
import { PressableScale } from "../../ui";
import {
  hitSize,
  maxFontScale,
  radius,
  spacing,
  text,
  usePalette,
  useScheme,
  elevation,
} from "../../theme";
import { messageOf, type ChatActions } from "./actions";
import { PhotoCapture } from "./PhotoCapture";
import {
  attachmentProblem,
  PERMISSION_OPTIONS,
  thinkingLabel,
  thinkingOptionsFor,
  type ImageAttachment,
  type RuntimeModel,
  type SessionConfig,
  type SessionPermission,
} from "./wire";

export interface ComposerProps {
  readonly actions: ChatActions;
  readonly running: boolean;
  /** The event stream is live; sending needs it so the result can be seen. */
  readonly live: boolean;
  readonly queued: readonly QueuedComposerMessage[];
  readonly onRemoveQueued: (id: string) => Promise<void>;
  readonly onSteerQueued: (id: string) => Promise<void>;
  readonly onStop: () => Promise<void>;
  readonly onSent: () => void;
  readonly config: SessionConfig;
  readonly models: readonly RuntimeModel[];
  readonly modelsLoaded: boolean;
  readonly permission: SessionPermission | null | undefined;
  readonly bottomInset: number;
}

/**
 * The chat's composer, like the desktop's and T3's: a floating card with the text field, photos,
 * the session's model, effort and permission under it, and one round action that is Send, or Stop
 * while the run works and nothing is typed. Typing during a run offers Queue (next turn) and Steer
 * (this turn); queued messages sit above the card with Steer now and Remove.
 */
export function Composer({
  actions,
  running,
  live,
  queued,
  onRemoveQueued,
  onSteerQueued,
  onStop,
  onSent,
  config,
  models,
  modelsLoaded,
  permission,
  bottomInset,
}: ComposerProps) {
  const palette = usePalette();
  const scheme = useScheme();
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<readonly ImageAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);

  const model = models.find(
    (entry) => entry.providerId === config.provider && entry.modelId === config.modelId,
  );
  const hasContent = draft.trim().length > 0 || images.length > 0;
  const canSend = live && !sending && hasContent;

  const fail = (reason: unknown) => {
    setError(messageOf(reason));
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
  };

  const submit = (mode: "followUp" | "steer") => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    actions
      .send(draft.trim(), mode, images)
      .then(() => {
        setDraft("");
        setImages([]);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        onSent();
      })
      .catch(fail)
      .finally(() => setSending(false));
  };

  const stop = () => {
    if (stopping) return;
    setStopping(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    onStop()
      .catch(fail)
      .finally(() => setStopping(false));
  };

  const pick = (
    title: string,
    options: readonly { readonly label: string; readonly value: string; readonly selected?: boolean }[],
    onPick: (value: string) => Promise<void>,
  ) => {
    if (options.length === 0) return;
    const labels = options.map((option) => (option.selected ? `✓ ${option.label}` : option.label));
    const run = (index: number) => {
      const option = options[index];
      if (!option || option.selected) return;
      Haptics.selectionAsync().catch(() => undefined);
      onPick(option.value).catch(fail);
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { title, options: [...labels, "Cancel"], cancelButtonIndex: labels.length },
        run,
      );
    } else {
      Alert.alert(title, undefined, [
        ...labels.map((label, index) => ({ text: label, onPress: () => run(index) })),
        { text: "Cancel", style: "cancel" as const },
      ]);
    }
  };

  const chooseModel = () => {
    if (!modelsLoaded) {
      actions.loadRuntime().catch(fail);
      return;
    }
    pick(
      "Model for this chat",
      models.map((entry) => ({
        label: `${entry.label} · ${entry.providerName}`,
        value: `${entry.providerId}\u0000${entry.modelId}`,
        selected: entry.providerId === config.provider && entry.modelId === config.modelId,
      })),
      (value) => {
        const [provider = "", modelId = ""] = value.split("\u0000");
        return actions.setModel(provider, modelId);
      },
    );
  };

  const chooseThinking = () =>
    pick(
      "Effort",
      thinkingOptionsFor(model).map((level) => ({
        label: thinkingLabel(level),
        value: level,
        selected: level === config.thinkingLevel,
      })),
      actions.setThinking,
    );

  const choosePermission = () =>
    pick(
      "Permissions",
      PERMISSION_OPTIONS.map((option) => ({
        label: `${option.label}: ${option.description}`,
        value: option.value,
        selected: option.value === permission,
      })),
      (value) => actions.setPermission(value as SessionPermission),
    );

  const addPhoto = (photo: ImageAttachment) => {
    const problem = attachmentProblem(images, photo);
    if (problem) {
      setError(problem);
      return;
    }
    setImages((current) => [...current, photo]);
  };

  const modelLabel = model?.label ?? config.modelId ?? (modelsLoaded ? "Choose model" : "Model");
  const permissionLabel =
    PERMISSION_OPTIONS.find((option) => option.value === permission)?.label ?? "Permissions";
  const placeholder = !live
    ? "Reconnecting…"
    : running
      ? "Queue a follow-up or steer this run"
      : "Message Pegasus";

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(bottomInset, spacing.sm) }]}>
      {queued.length > 0 ? (
        <View
          style={[
            styles.queue,
            { backgroundColor: palette.surfaceElevated, borderColor: palette.borderDefault },
          ]}
        >
          <Text
            accessibilityRole="header"
            maxFontSizeMultiplier={maxFontScale.chrome}
            style={[text.caption, styles.semibold, { color: palette.textMuted }]}
          >
            {queued.length === 1 ? "1 message queued" : `${queued.length} messages queued`}
          </Text>
          {queued.map((message) => (
            <QueuedRow
              disabled={!live}
              key={message.id}
              message={message}
              onRemove={() => {
                onRemoveQueued(message.id).catch(fail);
              }}
              onSteer={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
                onSteerQueued(message.id).catch(fail);
              }}
            />
          ))}
        </View>
      ) : null}

      {error ? (
        <PressableScale
          accessibilityHint="Dismisses the message"
          accessibilityRole="alert"
          onPress={() => setError(null)}
          style={[styles.error, { backgroundColor: palette.dangerTint, borderColor: palette.dangerTintBorder }]}
        >
          <Text style={[text.footnote, { color: palette.dangerText }]}>{error}</Text>
        </PressableScale>
      ) : null}

      <View
        style={[
          styles.card,
          {
            backgroundColor: palette.surfaceElevated,
            borderColor: palette.borderHeavy,
          },
          elevation(scheme, "float"),
        ]}
      >
        {images.length > 0 ? (
          <ScrollView contentContainerStyle={styles.thumbs} horizontal showsHorizontalScrollIndicator={false}>
            {images.map((image) => (
              <View key={image.id}>
                <Image
                  accessibilityLabel={image.name}
                  source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
                  style={[styles.thumb, { backgroundColor: palette.surface }]}
                />
                <PressableScale
                  accessibilityLabel={`Remove ${image.name}`}
                  accessibilityRole="button"
                  hitSlop={10}
                  onPress={() => setImages((current) => current.filter((entry) => entry.id !== image.id))}
                  style={[styles.thumbRemove, { backgroundColor: palette.primaryFill }]}
                >
                  <Text style={[text.caption2, { color: palette.onPrimary }]}>✕</Text>
                </PressableScale>
              </View>
            ))}
          </ScrollView>
        ) : null}

        <TextInput
          accessibilityLabel="Message"
          editable={!sending}
          multiline
          onChangeText={setDraft}
          placeholder={placeholder}
          placeholderTextColor={palette.textSoft}
          style={[styles.input, { color: palette.text }]}
          value={draft}
        />

        <View style={styles.toolbar}>
          <ToolbarButton
            accessibilityLabel="Attach a photo"
            disabled={!live || sending}
            label="＋"
            onPress={() => setCamera(true)}
          />
          <ScrollView
            contentContainerStyle={styles.pills}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.flex}
          >
            <Pill
              accessibilityHint="Changes the model for this chat"
              disabled={!live}
              label={modelLabel}
              onPress={chooseModel}
            />
            {config.thinkingLevel || model?.thinkingLevels.length ? (
              <Pill
                accessibilityHint="Changes how hard the model thinks"
                disabled={!live}
                label={thinkingLabel(config.thinkingLevel ?? "medium")}
                onPress={chooseThinking}
              />
            ) : null}
            {permission !== undefined ? (
              <Pill
                accessibilityHint="Changes what the agent may do without asking"
                disabled={!live}
                label={permissionLabel}
                onPress={choosePermission}
              />
            ) : null}
          </ScrollView>

          {running && hasContent ? (
            <PressableScale
              accessibilityHint="Sends it once the current run finishes"
              accessibilityLabel="Queue"
              accessibilityRole="button"
              disabled={!canSend}
              onPress={() => submit("followUp")}
              style={[styles.textAction, { opacity: canSend ? 1 : 0.45 }]}
            >
              <Text style={[text.subheadline, styles.semibold, { color: palette.accentText }]}>Queue</Text>
            </PressableScale>
          ) : null}

          {running && !hasContent ? (
            <RoundButton
              accessibilityLabel="Stop"
              busy={stopping}
              fill={palette.primaryFill}
              onPress={stop}
            >
              <View style={[styles.stopGlyph, { backgroundColor: palette.onPrimary }]} />
            </RoundButton>
          ) : (
            <RoundButton
              accessibilityHint={running ? "Reaches the running turn now" : undefined}
              accessibilityLabel={running ? "Steer" : "Send"}
              busy={sending}
              disabled={!canSend}
              fill={canSend ? palette.accent : palette.primaryDisabledFill}
              onPress={() => submit(running ? "steer" : "followUp")}
            >
              <Text style={[styles.sendGlyph, { color: canSend ? palette.onAccent : palette.onPrimaryDisabled }]}>
                {running ? "↪" : "↑"}
              </Text>
            </RoundButton>
          )}
        </View>
      </View>
      <PhotoCapture onClose={() => setCamera(false)} onPhoto={addPhoto} visible={camera} />
    </View>
  );
}

function Pill({
  label,
  onPress,
  disabled,
  accessibilityHint,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly accessibilityHint?: string;
}) {
  const palette = usePalette();
  return (
    <PressableScale
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={{ top: 6, bottom: 6 }}
      onPress={onPress}
      pressedStyle={{ backgroundColor: palette.overlayActive }}
      style={[styles.pill, { opacity: disabled ? 0.45 : 1 }]}
    >
      <Text
        maxFontSizeMultiplier={maxFontScale.chrome}
        numberOfLines={1}
        style={[text.footnote, styles.pillText, { color: palette.textMuted }]}
      >
        {label} ⌄
      </Text>
    </PressableScale>
  );
}

function ToolbarButton({
  label,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly accessibilityLabel: string;
}) {
  const palette = usePalette();
  return (
    <PressableScale
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      pressedStyle={{ backgroundColor: palette.overlayActive }}
      style={[styles.round, { opacity: disabled ? 0.45 : 1 }]}
    >
      <Text maxFontSizeMultiplier={maxFontScale.chrome} style={[text.title3, { color: palette.textMuted }]}>
        {label}
      </Text>
    </PressableScale>
  );
}

function RoundButton({
  children,
  onPress,
  fill,
  disabled,
  busy,
  accessibilityLabel,
  accessibilityHint,
}: {
  readonly children: ReactNode;
  readonly onPress: () => void;
  readonly fill: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly accessibilityLabel: string;
  readonly accessibilityHint?: string | undefined;
}) {
  return (
    <PressableScale
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
      disabled={disabled || busy}
      hitSlop={4}
      onPress={onPress}
      style={styles.round}
    >
      <View style={[styles.roundFill, { backgroundColor: fill, opacity: busy ? 0.6 : 1 }]}>{children}</View>
    </PressableScale>
  );
}

function QueuedRow({
  message,
  disabled,
  onSteer,
  onRemove,
}: {
  readonly message: QueuedComposerMessage;
  readonly disabled: boolean;
  readonly onSteer: () => void;
  readonly onRemove: () => void;
}) {
  const palette = usePalette();
  return (
    <View style={[styles.queuedRow, { borderTopColor: palette.borderDefault }]}>
      <Text numberOfLines={2} style={[text.subheadline, styles.flex, { color: palette.text }]}>
        {message.mode === "steer" ? "↪ " : ""}
        {message.text || "Photo"}
      </Text>
      {message.mode !== "steer" ? (
        <PressableScale
          accessibilityHint="Sends it into the running turn now"
          accessibilityLabel="Steer now"
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onSteer}
          style={styles.queuedAction}
        >
          <Text
            style={[
              text.subheadline,
              styles.semibold,
              { color: disabled ? palette.textSoft : palette.accentText },
            ]}
          >
            Steer
          </Text>
        </PressableScale>
      ) : null}
      <PressableScale
        accessibilityLabel="Remove from the queue"
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onRemove}
        pressedStyle={{ backgroundColor: palette.overlayActive }}
        style={styles.round}
      >
        <Text style={[text.subheadline, { color: palette.textMuted }]}>✕</Text>
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.gutter, paddingTop: spacing.xs, gap: spacing.sm },
  flex: { flex: 1, minWidth: 0 },
  semibold: { fontWeight: "600" },
  queue: {
    borderRadius: radius.float,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    gap: spacing.xs,
  },
  queuedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    minHeight: hitSize.min,
  },
  queuedAction: { minHeight: hitSize.min, justifyContent: "center", paddingHorizontal: spacing.sm },
  error: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  card: {
    borderRadius: radius.composer,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs,
  },
  thumbs: { gap: spacing.sm, paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
  thumb: { width: 64, height: 64, borderRadius: radius.md2 },
  thumbRemove: {
    position: "absolute",
    top: -spacing.xs,
    right: -spacing.xs,
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    ...text.body,
    minHeight: hitSize.min,
    maxHeight: 180,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    textAlignVertical: "top",
  },
  toolbar: { flexDirection: "row", alignItems: "center", gap: spacing.xxs },
  pills: { alignItems: "center", gap: spacing.xxs },
  pill: {
    minHeight: hitSize.compact,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    maxWidth: 200,
  },
  pillText: { fontWeight: "500" },
  textAction: { minHeight: hitSize.min, justifyContent: "center", paddingHorizontal: spacing.sm },
  round: {
    width: hitSize.min,
    height: hitSize.min,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  roundFill: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  stopGlyph: { width: 12, height: 12, borderRadius: 2 },
  sendGlyph: { fontSize: 18, fontWeight: "700", marginTop: -1 },
});
