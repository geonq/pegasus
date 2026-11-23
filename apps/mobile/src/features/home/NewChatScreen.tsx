import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { projectsOf } from "../../api/chats";
import type { RootStackParamList } from "../../navigation";
import { usePegasus } from "../../state/PegasusProvider";
import { radius, spacing, text, usePalette } from "../../theme";
import { EmptyState, Icon, ListGroup, ListRow, NativeMenu, type MenuSection } from "../../ui";
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
 * as native picker menus (the project's defaults otherwise). Start sits in the sheet's bar, like
 * Mail's Send. `startThread` opens the chat in this phone's view; the chat screen replaces this.
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

  useLayoutEffect(() => {
    navigation.setOptions({
      unstable_headerLeftItems: () => [
        {
          type: "button",
          label: "Cancel",
          onPress: () => navigation.goBack(),
        },
      ],
      unstable_headerRightItems: () => [
        {
          type: "button",
          label: starting ? "Starting…" : "Start",
          variant: "done",
          disabled: !ready,
          accessibilityLabel: "Start chat",
          onPress: start,
        },
      ],
    });
  });

  const projectMenu: MenuSection[] = [
    {
      items: projects.map((entry) => ({
        id: `project:${entry.id}`,
        label: entry.name,
        icon: "folder",
        selected: entry.id === project?.id,
        onPress: () => {
          setWorkspaceId(entry.id);
          setModel(undefined);
          setLevel(undefined);
        },
      })),
    },
  ];
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

  if (state && projects.length === 0) {
    return (
      <View style={[styles.screen, styles.center, { backgroundColor: palette.background }]}>
        <EmptyState
          icon="folder.badge.plus"
          title="No projects on this PC"
          message="Add a project in Pegasus on the PC. It shows up here at once."
        />
      </View>
    );
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      style={[styles.screen, { backgroundColor: palette.background }]}
    >
      <TextInput
        accessibilityLabel="First message"
        multiline
        autoFocus
        value={prompt}
        onChangeText={setPrompt}
        placeholder="What should Pegasus do?"
        placeholderTextColor={palette.textSoft}
        style={[text.body, styles.input, { color: palette.text, backgroundColor: palette.surface }]}
      />
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

      <ListGroup
        footer={
          runtime.loaded
            ? "Model and effort apply to this chat only."
            : "Loading models… The project's default is used if you start now."
        }
      >
        <NativeMenu sections={projectMenu} title="Project">
          <ListRow
            accessory="menu"
            detail={project?.name ?? "None"}
            label="Project"
            leading={<Icon name="folder" color={palette.textMuted} />}
          />
        </NativeMenu>
        {runtime.loaded && runtime.models.length > 0 ? (
          <NativeMenu sections={modelMenu} title="Model">
            <ListRow
              accessory="menu"
              detail={shownModel?.label ?? "Project default"}
              label="Model"
              leading={<Icon name="cpu" color={palette.textMuted} />}
            />
          </NativeMenu>
        ) : (
          <ListRow
            detail={runtime.loaded ? "Project default" : "Loading…"}
            disabled
            label="Model"
            leading={<Icon name="cpu" color={palette.textMuted} />}
          />
        )}
        <NativeMenu sections={levelMenu} title="Effort">
          <ListRow
            accessory="menu"
            detail={shownLevel ? (LEVEL_LABELS[shownLevel] ?? shownLevel) : "Model default"}
            label="Effort"
            leading={<Icon name="brain" color={palette.textMuted} />}
          />
        </NativeMenu>
      </ListGroup>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { justifyContent: "center" },
  flex: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xl },
  input: {
    minHeight: 132,
    padding: spacing.md,
    borderRadius: radius.md,
    textAlignVertical: "top",
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
