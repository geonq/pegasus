import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { projectsOf } from "../../api/chats";
import type { RootStackParamList } from "../../navigation";
import { usePegasus } from "../../state/PegasusProvider";
import { hitSize, maxFontScale, radius, spacing, text, usePalette, weight } from "../../theme";
import {
  EmptyState,
  Icon,
  ListGroup,
  ListRow,
  PressableScale,
  Spinner,
  TopBar,
  type MenuSection,
} from "../../ui";
import { newChatRuntime, thinkingOptions, type NewChatModel } from "./new-chat";

const LEVEL_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const sameModel = (a: NewChatModel | undefined, b: NewChatModel | undefined) =>
  a?.provider === b?.provider && a?.modelId === b?.modelId;

/**
 * Starts a chat on the PC: the message first (it has the focus), then project, model and effort
 * from project chips and Pegasus picker menus (the project's defaults otherwise). Start sits in the
 * top bar as the one ink button. `startThread` opens the chat in this phone's view; the chat screen replaces this.
 */
export default function NewChatScreen({
  navigation,
  route,
}: NativeStackScreenProps<RootStackParamList, "NewChat">) {
  const palette = usePalette();
  const { state, loadRuntime, startThread } = usePegasus();
  const projects = useMemo(() => (state ? projectsOf(state) : []), [state]);
  const [workspaceId, setWorkspaceId] = useState(
    route.params?.workspaceId ?? state?.selectedWorkspaceId ?? "",
  );
  const project = projects.find((entry) => entry.id === workspaceId) ?? projects[0];
  const runtime = useMemo(() => newChatRuntime(state, project?.id ?? ""), [state, project?.id]);
  const [model, setModel] = useState<NewChatModel | undefined>();
  const [level, setLevel] = useState<string | undefined>();
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Models arrive with the project's runtime; ask the PC to load it once per project.
  useEffect(() => {
    if (project && !runtime.loaded) loadRuntime(project.id).catch(() => undefined);
  }, [project, runtime.loaded, loadRuntime]);

  const shownModel = model ?? runtime.defaultModel;
  const levels = thinkingOptions(shownModel);
  const shownLevel = level ?? runtime.defaultThinkingLevel;
  const ready = Boolean(project && prompt.trim()) && !starting;

  const start = () => {
    if (!project || !prompt.trim() || starting) return;
    setStarting(true);
    setError(null);
    startThread({
      rootWorkspaceId: project.id,
      environment: "local",
      prompt: prompt.trim(),
      ...(model ? { provider: model.provider, modelId: model.modelId } : {}),
      ...(level && levels.includes(level) ? { thinkingLevel: level } : {}),
    })
      .then((target) => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        navigation.replace("Chat", { ...target, title: prompt.trim().split("\n")[0] ?? "" });
      })
      .catch((reason: unknown) => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
        setError(reason instanceof Error ? reason.message : String(reason));
        setStarting(false);
      });
  };

  const providers = [...new Set(runtime.models.map((entry) => entry.provider))];
  const modelMenu: MenuSection[] = providers.map((provider) => ({
    title: provider,
    items: runtime.models
      .filter((entry) => entry.provider === provider)
      .map((entry) => ({
        id: `model:${entry.provider}/${entry.modelId}`,
        label: sameModel(entry, runtime.defaultModel) ? `${entry.label} (default)` : entry.label,
        selected: sameModel(entry, shownModel),
        onPress: () => setModel(entry),
      })),
  }));
  const levelMenu: MenuSection[] = [
    {
      items: levels.map((entry) => ({
        id: `level:${entry}`,
        label: LEVEL_LABELS[entry] ?? entry,
        selected: entry === shownLevel,
        onPress: () => setLevel(entry),
      })),
    },
  ];

  const bar = (
    <TopBar
      leading={
        <PressableScale
          accessibilityRole="button"
          hitSlop={4}
          onPress={() => navigation.goBack()}
          style={styles.textButton}
        >
          <Text style={[text.body, { color: palette.textMuted }]}>Cancel</Text>
        </PressableScale>
      }
      sheet
      title="New chat"
      trailing={
        <PressableScale
          accessibilityLabel="Start chat"
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready, busy: starting }}
          disabled={!ready}
          onPress={start}
          pressedStyle={{ opacity: 0.85 }}
          style={[
            styles.start,
            { backgroundColor: ready ? palette.primaryFill : palette.primaryDisabledFill },
          ]}
        >
          {starting ? <Spinner color={palette.onPrimary} size={11} /> : null}
          <Text
            maxFontSizeMultiplier={maxFontScale.chrome}
            style={[
              text.subheadline,
              styles.semibold,
              { color: ready ? palette.onPrimary : palette.onPrimaryDisabled },
            ]}
          >
            {starting ? "Starting" : "Start"}
          </Text>
        </PressableScale>
      }
    />
  );

  if (state && projects.length === 0) {
    return (
      <View style={[styles.screen, { backgroundColor: palette.background }]}>
        {bar}
        <View style={[styles.flex, styles.center]}>
          <EmptyState
            icon="folder.badge.plus"
            title="No projects on this PC"
            message="Add a project in Pegasus on the PC. It shows up here at once."
          />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      {bar}
      <KeyboardAwareScrollView
        bottomOffset={spacing.xl}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        style={styles.flex}
      >
        <View
          style={[
            styles.prompt,
            { backgroundColor: palette.surfaceElevated, borderColor: palette.borderDefault },
          ]}
        >
          <TextInput
            accessibilityLabel="First message"
            autoFocus
            multiline
            onChangeText={setPrompt}
            placeholder="What should Pegasus do?"
            placeholderTextColor={palette.textSoft}
            style={[text.body, styles.input, { color: palette.textStrong }]}
            value={prompt}
          />
          <View style={styles.promptFoot}>
            <Icon color={palette.textSoft} name="folder" size={12} />
            <Text
              maxFontSizeMultiplier={maxFontScale.chrome}
              numberOfLines={1}
              style={[text.caption, styles.flex, { color: palette.textMuted }]}
            >
              {project?.name ?? "No project"} · {shownModel?.label ?? "Project default"}
            </Text>
          </View>
        </View>

        {error ? (
          <View
            accessibilityRole="alert"
            style={[
              styles.error,
              { backgroundColor: palette.dangerTint, borderColor: palette.dangerTintBorder },
            ]}
          >
            <Icon name="exclamationmark.triangle.fill" color={palette.dangerText} size={14} />
            <Text style={[text.footnote, styles.flex, { color: palette.dangerText }]}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.block}>
          <Text
            accessibilityRole="header"
            style={[text.footnote, styles.label, { color: palette.textMuted }]}
          >
            Project
          </Text>
          <ScrollView
            contentContainerStyle={styles.chips}
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
          >
            {projects.map((entry) => {
              const selected = entry.id === project?.id;
              return (
                <PressableScale
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  key={entry.id}
                  onPress={() => {
                    setWorkspaceId(entry.id);
                    setModel(undefined);
                    setLevel(undefined);
                    Haptics.selectionAsync().catch(() => undefined);
                  }}
                  style={[
                    styles.chip,
                    selected
                      ? { backgroundColor: palette.primaryFill, borderColor: palette.primaryFill }
                      : {
                          backgroundColor: palette.surfaceElevated,
                          borderColor: palette.borderDefault,
                        },
                  ]}
                >
                  <Icon
                    color={selected ? palette.onPrimary : palette.textMuted}
                    name={selected ? "folder.fill" : "folder"}
                    size={12}
                  />
                  <Text
                    maxFontSizeMultiplier={maxFontScale.chrome}
                    style={[
                      text.subheadline,
                      {
                        color: selected ? palette.onPrimary : palette.text,
                        fontWeight: selected ? weight.semibold : weight.medium,
                      },
                    ]}
                  >
                    {entry.name}
                  </Text>
                </PressableScale>
              );
            })}
          </ScrollView>
        </View>

        <ListGroup
          footer={
            runtime.loaded
              ? "Model and effort apply to this chat only."
              : "Loading models… The project's default is used if you start now."
          }
          title="Run with"
        >
          {runtime.loaded && runtime.models.length > 0 ? (
            <ListRow
              detail={shownModel?.label ?? "Project default"}
              label="Model"
              leading={<Icon name="cpu" color={palette.textMuted} />}
              menu={modelMenu}
              menuTitle="Model"
            />
          ) : (
            <ListRow
              detail={runtime.loaded ? "Project default" : "Loading…"}
              disabled
              label="Model"
              leading={<Icon name="cpu" color={palette.textMuted} />}
            />
          )}
          <ListRow
            detail={shownLevel ? (LEVEL_LABELS[shownLevel] ?? shownLevel) : "Model default"}
            label="Effort"
            leading={<Icon name="brain" color={palette.textMuted} />}
            menu={levelMenu}
            menuTitle="Effort"
          />
        </ListGroup>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  center: { justifyContent: "center" },
  semibold: { fontWeight: weight.semibold },
  content: { padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.xl },
  textButton: { minHeight: hitSize.min, justifyContent: "center", paddingHorizontal: spacing.sm },
  start: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm2,
    minHeight: 34,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
  },
  prompt: {
    borderRadius: radius.composer,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.sm,
  },
  input: { minHeight: 140, textAlignVertical: "top", paddingTop: 0 },
  promptFoot: { flexDirection: "row", alignItems: "center", gap: spacing.sm2 },
  block: { gap: spacing.sm },
  label: { fontWeight: weight.semibold, paddingHorizontal: spacing.lg },
  chips: { gap: spacing.sm, paddingHorizontal: spacing.xxs },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm2,
    minHeight: hitSize.compact + 4,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  error: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
