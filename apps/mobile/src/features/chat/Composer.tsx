import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { useRef, useState, type ReactNode } from "react";
import { Image, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { newSendId } from "../../api/client";
import type { QueuedComposerMessage } from "../../api/types";
import {
  GlassCard,
  Icon,
  MenuButton,
  PressableScale,
  type IconName,
  type MenuSection,
} from "../../ui";
import { hitSize, maxFontScale, radius, spacing, text, usePalette } from "../../theme";
import { messageOf, type ChatActions } from "./actions";
import { photoName } from "./photo-name";
import { PhotoCapture } from "./PhotoCapture";
import {
  attachmentProblem,
  IMAGES_MAX_COUNT,
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
 * The chat's composer, like the desktop's and T3's: a floating glass card with the text field,
 * photos (camera or library), the session's model, effort and permission as native menus under
 * it, and one round action that is Send, or Stop while the run works and nothing is typed. Typing
 * during a run offers Queue (next turn) and Steer (this turn); queued messages sit above the card
 * with Steer now and Remove.
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

  // A second tap before React re-renders still sees canSend true; the ref stops it at once.
  const inFlight = useRef(false);
  // One id per draft: a failed send retried unchanged reuses it, so the PC sends it at most once.
  const pendingSend = useRef<{ key: string; id: string } | null>(null);
  const submit = (mode: "followUp" | "steer") => {
    if (!canSend || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    const text = draft.trim();
    const key = JSON.stringify([text, mode, images.map((image) => image.id)]);
    if (pendingSend.current?.key !== key) pendingSend.current = { key, id: newSendId() };
    actions
      .send(text, mode, images, pendingSend.current.id)
      .then(() => {
        pendingSend.current = null;
        setDraft("");
        setImages([]);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        onSent();
      })
      .catch(fail)
      .finally(() => {
        inFlight.current = false;
        setSending(false);
      });
  };

  const stop = () => {
    if (stopping) return;
    setStopping(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    onStop()
      .catch(fail)
      .finally(() => setStopping(false));
  };

  /** A picker menu's choice: picking the current one does nothing. */
  const choice = (selected: boolean, run: () => Promise<void>) => () => {
    if (!selected) run().catch(fail);
  };

  // Grouped by provider, like the desktop's model picker.
  const providers = [...new Set(models.map((entry) => entry.providerName))];
  const modelMenu: MenuSection[] = providers.map((provider) => ({
    title: provider,
    items: models
      .filter((entry) => entry.providerName === provider)
      .map((entry) => {
        const selected = entry.providerId === config.provider && entry.modelId === config.modelId;
        return {
          id: `model:${entry.providerId}/${entry.modelId}`,
          label: entry.label,
          selected,
          onPress: choice(selected, () => actions.setModel(entry.providerId, entry.modelId)),
        };
      }),
  }));

  const thinkingMenu: MenuSection[] = [
    {
      title: "Effort",
      items: thinkingOptionsFor(model).map((level) => ({
        id: `effort:${level}`,
        label: thinkingLabel(level),
        selected: level === config.thinkingLevel,
        onPress: choice(level === config.thinkingLevel, () => actions.setThinking(level)),
      })),
    },
  ];

  const permissionMenu: MenuSection[] = [
    {
      title: "What the agent may do without asking",
      items: PERMISSION_OPTIONS.map((option) => ({
        id: `permission:${option.value}`,
        label: option.label,
        description: option.description,
        icon: PERMISSION_ICONS[option.value],
        selected: option.value === permission,
        onPress: choice(option.value === permission, () =>
          actions.setPermission(option.value as SessionPermission),
        ),
      })),
    },
  ];

  const addPhoto = (photo: ImageAttachment) => {
    const problem = attachmentProblem(images, photo);
    if (problem) {
      setError(problem);
      return;
    }
    setImages((current) => [...current, photo]);
  };

  // The system photo picker runs out of process and needs no library permission.
  const pickFromLibrary = () => {
    const room = IMAGES_MAX_COUNT - images.length;
    if (room <= 0) {
      setError(`At most ${IMAGES_MAX_COUNT} photos per message.`);
      return;
    }
    ImagePicker.launchImageLibraryAsync({
      mediaTypes: "images",
      allowsMultipleSelection: true,
      selectionLimit: room,
      // 0.6 keeps a phone photo near 1-2 MB, well under the PC's 10 MB per image.
      quality: 0.6,
      base64: true,
    })
      .then((result) => {
        if (result.canceled) return;
        const at = Date.now();
        result.assets.forEach((asset, index) => {
          if (!asset.base64) return;
          addPhoto({
            id: `phone-${at}-${index}`,
            kind: "image",
            name: photoName(asset.fileName, at, index),
            mimeType: "image/jpeg",
            data: asset.base64,
          });
        });
      })
      .catch(fail);
  };

  const photoMenu: MenuSection[] = [
    {
      items: [
        {
          id: "photo:library",
          label: "Photo library",
          icon: "photo.on.rectangle",
          onPress: pickFromLibrary,
        },
        { id: "photo:camera", label: "Take photo", icon: "camera", onPress: () => setCamera(true) },
      ],
    },
  ];

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
          style={[
            styles.error,
            { backgroundColor: palette.dangerTint, borderColor: palette.dangerTintBorder },
          ]}
        >
          <Text style={[text.footnote, { color: palette.dangerText }]}>{error}</Text>
        </PressableScale>
      ) : null}

      <GlassCard padded={false} style={styles.card}>
        {images.length > 0 ? (
          <ScrollView
            contentContainerStyle={styles.thumbs}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
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
                  onPress={() =>
                    setImages((current) => current.filter((entry) => entry.id !== image.id))
                  }
                  style={[styles.thumbRemove, { backgroundColor: palette.primaryFill }]}
                >
                  <Icon name="xmark" color={palette.onPrimary} size={10} weight="bold" />
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
          <MenuPill
            accessibilityLabel="Attach a photo"
            disabled={!live || sending}
            icon="plus"
            round
            sections={photoMenu}
          />
          <ScrollView
            contentContainerStyle={styles.pills}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.pillsScroll}
          >
            {modelsLoaded ? (
              <MenuPill
                accessibilityHint="Changes the model for this chat"
                disabled={!live || models.length === 0}
                icon="cpu"
                label={modelLabel}
                sections={modelMenu}
              />
            ) : (
              <Pill
                accessibilityHint="Loads the models from the PC"
                disabled={!live}
                icon="cpu"
                label={modelLabel}
                onPress={() => actions.loadRuntime().catch(fail)}
              />
            )}
            {config.thinkingLevel || model?.thinkingLevels.length ? (
              <MenuPill
                accessibilityHint="Changes how hard the model thinks"
                disabled={!live}
                icon="brain"
                label={thinkingLabel(config.thinkingLevel ?? "medium")}
                sections={thinkingMenu}
              />
            ) : null}
            {permission !== undefined ? (
              <MenuPill
                accessibilityHint="Changes what the agent may do without asking"
                disabled={!live}
                icon={permission ? PERMISSION_ICONS[permission] : "lock"}
                label={permissionLabel}
                sections={permissionMenu}
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
              <Text style={[text.subheadline, styles.semibold, { color: palette.accentText }]}>
                Queue
              </Text>
            </PressableScale>
          ) : null}

          {running && !hasContent ? (
            <RoundButton
              accessibilityLabel="Stop"
              busy={stopping}
              fill={palette.primaryFill}
              onPress={stop}
            >
              <Icon name="stop.fill" color={palette.onPrimary} size={12} />
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
              <Icon
                color={canSend ? palette.onAccent : palette.onPrimaryDisabled}
                name={running ? "arrow.turn.down.right" : "arrow.up"}
                size={15}
                weight="bold"
              />
            </RoundButton>
          )}
        </View>
      </GlassCard>
      <PhotoCapture onClose={() => setCamera(false)} onPhoto={addPhoto} visible={camera} />
    </View>
  );
}

const PERMISSION_ICONS: Record<SessionPermission, IconName> = {
  plan: "doc.text.magnifyingglass",
  ask: "hand.raised",
  edits: "pencil",
  full: "bolt.shield",
};

/** What a toolbar pill shows: an icon, its label and a chevron (or just the icon when round). */
function PillFace({
  icon,
  label,
  round,
  disabled,
}: {
  readonly icon: IconName;
  readonly label?: string;
  readonly round?: boolean;
  readonly disabled?: boolean;
}) {
  const palette = usePalette();
  if (round) {
    return (
      <View style={[styles.round, { opacity: disabled ? 0.45 : 1 }]}>
        <View
          style={[
            styles.roundFill,
            { borderWidth: StyleSheet.hairlineWidth, borderColor: palette.borderHeavy },
          ]}
        >
          <Icon name={icon} color={palette.textMuted} size={15} weight="semibold" />
        </View>
      </View>
    );
  }
  return (
    <View
      style={[
        styles.pill,
        {
          opacity: disabled ? 0.45 : 1,
          backgroundColor: palette.overlaySubtle,
          borderColor: palette.borderDefault,
        },
      ]}
    >
      <Icon name={icon} color={palette.textMuted} size={12} />
      <Text
        maxFontSizeMultiplier={maxFontScale.chrome}
        numberOfLines={1}
        style={[text.footnote, styles.pillText, { color: palette.textMuted }]}
      >
        {label}
      </Text>
      <Icon name="chevron.down" color={palette.textSoft} size={8} weight="bold" />
    </View>
  );
}

/** A toolbar control that opens a native menu (a picker with a checkmark on the current one). */
function MenuPill({
  sections,
  icon,
  label,
  round,
  disabled,
  accessibilityLabel,
  accessibilityHint,
}: {
  readonly sections: readonly MenuSection[];
  readonly icon: IconName;
  readonly label?: string;
  readonly round?: boolean;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
}) {
  return (
    <MenuButton
      accessibilityLabel={accessibilityLabel ?? label ?? ""}
      disabled={disabled}
      hitSlop={4}
      pressedStyle={styles.pressed}
      sections={sections}
      {...(accessibilityHint ? { accessibilityHint } : {})}
    >
      <PillFace disabled={disabled} icon={icon} round={round} {...(label ? { label } : {})} />
    </MenuButton>
  );
}

/** A toolbar pill that runs an action instead of opening a menu. */
function Pill({
  label,
  icon,
  onPress,
  disabled,
  accessibilityHint,
}: {
  readonly label: string;
  readonly icon: IconName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly accessibilityHint?: string;
}) {
  return (
    <PressableScale
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={{ top: 6, bottom: 6 }}
      onPress={onPress}
    >
      <PillFace disabled={disabled} icon={icon} label={label} />
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
      <View style={[styles.roundFill, { backgroundColor: fill, opacity: busy ? 0.6 : 1 }]}>
        {children}
      </View>
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
      <Icon
        color={palette.textSoft}
        name={message.mode === "steer" ? "arrow.turn.down.right" : "clock"}
        size={12}
      />
      <Text numberOfLines={2} style={[text.subheadline, styles.flex, { color: palette.text }]}>
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
        <Icon name="xmark" color={palette.textMuted} size={13} />
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
  // The chip row scrolls inside its own slot and is clipped there, so a long model name or a third
  // chip never runs under Queue / Stop / Send (it did in a running chat: "Ac…" under Stop).
  toolbar: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  pillsScroll: { flex: 1, minWidth: 0, overflow: "hidden" },
  pills: {
    alignItems: "center",
    gap: spacing.sm2,
    paddingHorizontal: spacing.xxs,
    paddingRight: spacing.sm,
  },
  pressed: { opacity: 0.7 },
  pill: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs + 1,
    paddingHorizontal: spacing.md2,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 200,
  },
  pillText: { fontWeight: "500", flexShrink: 1 },
  textAction: { minHeight: hitSize.min, justifyContent: "center", paddingHorizontal: spacing.sm },
  round: {
    width: hitSize.min,
    height: hitSize.min,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  roundFill: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
