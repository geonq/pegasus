import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { projectsOf } from "../../api/chats";
import type { RootStackParamList } from "../../navigation";
import { usePegasus } from "../../state/PegasusProvider";
import { radius, spacing, text, usePalette } from "../../theme";
import { Button, Chip, SectionHeader } from "../../ui";
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
 * Starts a chat on the PC: project, optional model and effort (the project's defaults otherwise),
 * and the first message. `startThread` opens it in this phone's view; the chat screen follows.
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
      .then((target) =>
        navigation.replace("Chat", { ...target, title: prompt.trim().split("\n")[0] ?? "" }),
      )
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setStarting(false);
      });
  };

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: palette.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={64}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <SectionHeader title="Project" />
        <View style={styles.chips}>
          {projects.map((entry) => (
            <Chip
              key={entry.id}
              label={entry.name}
              selected={entry.id === project?.id}
              onPress={() => {
                setWorkspaceId(entry.id);
                setModel(undefined);
                setLevel(undefined);
              }}
            />
          ))}
        </View>
        {projects.length === 0 ? (
          <Text style={[text.footnote, { color: palette.textMuted }]}>
            No project on this PC is shared with this phone.
          </Text>
        ) : null}

        <SectionHeader title="Model" />
        {runtime.loaded ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            {runtime.models.map((entry) => (
              <Chip
                key={`${entry.provider}/${entry.modelId}`}
                label={
                  sameModel(entry, runtime.defaultModel) ? `${entry.label} (default)` : entry.label
                }
                selected={sameModel(entry, shownModel)}
                onPress={() => setModel(entry)}
              />
            ))}
          </ScrollView>
        ) : (
          <Text style={[text.footnote, { color: palette.textMuted }]}>
            Loading models… The project default is used if you start now.
          </Text>
        )}

        <SectionHeader title="Thinking" />
        <View style={styles.chips}>
          {levels.map((entry) => (
            <Chip
              key={entry}
              label={LEVEL_LABELS[entry] ?? entry}
              selected={entry === shownLevel}
              onPress={() => setLevel(entry)}
            />
          ))}
        </View>

        <SectionHeader title="Message" />
        <TextInput
          accessibilityLabel="First message"
          multiline
          autoFocus
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should Pegasus do?"
          placeholderTextColor={palette.textSoft}
          style={[
            text.body,
            styles.input,
            { color: palette.text, backgroundColor: palette.surface, borderColor: palette.line },
          ]}
        />
        {error ? (
          <Text accessibilityRole="alert" style={[text.footnote, { color: palette.dangerText }]}>
            {error}
          </Text>
        ) : null}
        <Button
          label="Start chat"
          onPress={start}
          busy={starting}
          disabled={!project || !prompt.trim() || starting}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  input: {
    minHeight: 120,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    textAlignVertical: "top",
  },
});
