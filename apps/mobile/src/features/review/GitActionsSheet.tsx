import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { radius, spacing, type, usePalette } from "../../theme";
import { errorMessage, type ReviewApi } from "./review-api";
import { nextGitStep } from "./review-logic";
import type { GitActionInput, GitActionState } from "./types";

const BUSY_LABEL = {
  stage: "Staging…",
  commit: "Committing…",
  push: "Pushing…",
  pr: "Creating PR…",
} as const;

type Busy = keyof typeof BUSY_LABEL;

interface Form {
  readonly kind: "commit" | "pr";
  readonly title: string;
  readonly body: string;
  readonly drafting: boolean;
  readonly edited: boolean;
  readonly note: string;
}

/**
 * The repository's next git step on the PC: stage all, commit, push, then pull request. Commit and
 * PR show text the chat's model drafted from the diff (draftGitText); both stay editable, and
 * stage and push ask before they run.
 */
export function GitActionsSheet({
  api,
  reviewId,
  visible,
  onClose,
  onChanged,
}: {
  readonly api: ReviewApi;
  readonly reviewId: string;
  readonly visible: boolean;
  readonly onClose: () => void;
  /** After a change, so the review reloads. */
  readonly onChanged: () => void;
}) {
  const palette = usePalette();
  const [state, setState] = useState<GitActionState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const draftNonce = useRef(0);
  const loadNonce = useRef(0);

  const load = useCallback(() => {
    const nonce = ++loadNonce.current;
    setLoadError(null);
    api.gitState(reviewId).then(
      (next) => {
        if (loadNonce.current !== nonce) return;
        if (next.state === "available") setState(next);
        else {
          setState(null);
          setLoadError(next.message);
        }
      },
      (failure: unknown) => {
        if (loadNonce.current !== nonce) return;
        setState(null);
        setLoadError(errorMessage(failure));
      },
    );
  }, [api, reviewId]);

  useEffect(() => {
    if (!visible) return;
    setForm(null);
    setError(null);
    setDone(null);
    return () => {
      draftNonce.current += 1;
    };
  }, [visible]);

  // Every review reload brings a new reviewId; the state reloads without clearing what was done.
  useEffect(() => {
    if (!visible) return;
    load();
    return () => {
      loadNonce.current += 1;
    };
  }, [visible, load]);

  const run = async (input: GitActionInput, label: Busy) => {
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      const result = await api.runGit(input);
      if (result.state === "done" || result.state === "pull-request") {
        draftNonce.current += 1;
        setForm(null);
        if (result.state === "pull-request") {
          setDone(
            result.opened === "created"
              ? "Pull request created."
              : "Open the page to finish the pull request.",
          );
          await Linking.openURL(result.url).catch(() => undefined);
        } else {
          setDone(label === "stage" ? "Staged." : label === "commit" ? "Committed." : "Pushed.");
        }
        load();
        onChanged();
        return;
      }
      setError(result.message);
    } catch (failure: unknown) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const openForm = (kind: "commit" | "pr") => {
    const nonce = ++draftNonce.current;
    setError(null);
    setDone(null);
    setForm({ kind, title: "", body: "", drafting: true, edited: false, note: "" });
    const couldNot = "Could not draft text. Write it here.";
    api.draft(reviewId, kind).then(
      (draft) => {
        if (draftNonce.current !== nonce) return;
        setForm((current) => {
          if (!current) return current;
          if (draft.state !== "drafted") return { ...current, drafting: false, note: couldNot };
          return {
            ...current,
            drafting: false,
            note: draft.fallback ? "The model was unavailable, so this is a plain summary." : "",
            ...(current.edited ? {} : { title: draft.title, body: draft.body }),
          };
        });
      },
      () => {
        if (draftNonce.current === nonce)
          setForm((current) =>
            current ? { ...current, drafting: false, note: couldNot } : current,
          );
      },
    );
  };

  const confirm = (title: string, message: string, label: string, action: () => void) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: label, onPress: action },
    ]);

  const step = state ? nextGitStep(state) : null;
  const onStep = () => {
    if (!step || !state) return;
    if (step.kind === "stage")
      confirm(
        "Stage all files?",
        step.hint,
        "Stage all",
        () => void run({ reviewId, action: "stage-all" }, "stage"),
      );
    else if (step.kind === "push")
      confirm("Push?", step.hint, "Push", () => void run({ reviewId, action: "push" }, "push"));
    else if (step.kind === "commit" || step.kind === "pr") openForm(step.kind);
    else if (step.kind === "view-pr" && state.pullRequest)
      Linking.openURL(state.pullRequest.url).catch((failure: unknown) =>
        setError(errorMessage(failure)),
      );
  };

  const submit = () => {
    if (!form || !form.title.trim()) return;
    const label = form.kind === "commit" ? "Commit" : "Create PR";
    confirm(
      form.kind === "commit" ? "Commit staged files?" : "Create pull request?",
      form.title.trim(),
      label,
      () =>
        void run({ reviewId, action: form.kind, title: form.title, body: form.body }, form.kind),
    );
  };

  const field = [
    styles.input,
    { color: palette.text, backgroundColor: palette.surface, borderColor: palette.line },
  ];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={busy ? () => undefined : onClose}
    >
      <View style={[styles.sheet, { backgroundColor: palette.background }]}>
        <View style={[styles.header, { borderColor: palette.line }]}>
          <Text accessibilityRole="header" style={[styles.title, { color: palette.text }]}>
            Git
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy !== null}
            hitSlop={12}
            onPress={onClose}
          >
            <Text style={[styles.link, { color: busy ? palette.textMuted : palette.accentText }]}>
              Done
            </Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {loadError ? (
            <Text accessibilityRole="alert" style={[styles.body, { color: palette.danger }]}>
              {loadError}
            </Text>
          ) : !state || !step ? (
            <ActivityIndicator color={palette.accent} style={styles.start} />
          ) : (
            <>
              <View
                style={[
                  styles.card,
                  { backgroundColor: palette.surface, borderColor: palette.line },
                ]}
              >
                <Fact label="Branch" value={state.branch ?? "Detached HEAD"} />
                <Fact label="Tracks" value={state.upstream ?? "Not published"} />
                <Fact label="Staged" value={String(state.staged)} />
                <Fact label="Not staged" value={String(state.unstaged)} />
                {state.ahead > 0 ? <Fact label="To push" value={`${state.ahead}`} /> : null}
                {state.pullRequest ? (
                  <Fact label="Pull request" value={`#${state.pullRequest.number}`} />
                ) : null}
              </View>
              {form ? (
                <View style={styles.form}>
                  <Text style={[styles.label, { color: palette.textMuted }]}>
                    {form.kind === "commit" ? "Commit message" : "Pull request title"}
                  </Text>
                  <TextInput
                    value={form.title}
                    editable={busy === null}
                    placeholder={form.drafting ? "Drafting…" : "Title"}
                    placeholderTextColor={palette.textMuted}
                    onChangeText={(title) =>
                      setForm((current) =>
                        current ? { ...current, title, edited: true } : current,
                      )
                    }
                    style={field}
                  />
                  <TextInput
                    value={form.body}
                    editable={busy === null}
                    multiline
                    placeholder={form.drafting ? "Drafting…" : "Description (optional)"}
                    placeholderTextColor={palette.textMuted}
                    onChangeText={(body) =>
                      setForm((current) => (current ? { ...current, body, edited: true } : current))
                    }
                    style={[field, styles.bodyInput]}
                  />
                  {form.drafting ? (
                    <View style={styles.inline}>
                      <ActivityIndicator color={palette.accent} />
                      <Text style={[styles.note, { color: palette.textMuted }]}>
                        The chat's model is drafting this.
                      </Text>
                    </View>
                  ) : form.note ? (
                    <Text style={[styles.note, { color: palette.textMuted }]}>{form.note}</Text>
                  ) : null}
                  <View style={styles.inline}>
                    <Button
                      label="Cancel"
                      disabled={busy !== null}
                      onPress={() => {
                        draftNonce.current += 1;
                        setForm(null);
                      }}
                    />
                    <Button
                      primary
                      label={
                        busy ? BUSY_LABEL[busy] : form.kind === "commit" ? "Commit" : "Create PR"
                      }
                      disabled={busy !== null || !form.title.trim()}
                      onPress={submit}
                    />
                  </View>
                </View>
              ) : (
                <>
                  <Button
                    primary
                    label={busy ? BUSY_LABEL[busy] : step.label}
                    disabled={busy !== null || step.kind === "none"}
                    onPress={onStep}
                  />
                  <Text style={[styles.note, { color: palette.textMuted }]}>{step.hint}</Text>
                </>
              )}
              {busy ? <ActivityIndicator color={palette.accent} style={styles.start} /> : null}
              {done ? (
                <Text
                  accessibilityLiveRegion="polite"
                  style={[styles.body, { color: palette.success }]}
                >
                  {done}
                </Text>
              ) : null}
              {error ? (
                <Text accessibilityRole="alert" style={[styles.body, { color: palette.danger }]}>
                  {error}
                </Text>
              ) : null}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  const palette = usePalette();
  return (
    <View style={styles.fact}>
      <Text style={[styles.body, { color: palette.textMuted }]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.body, styles.factValue, { color: palette.text }]}>
        {value}
      </Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled,
  primary,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly primary?: boolean;
}) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary
          ? { backgroundColor: palette.accent }
          : {
              backgroundColor: palette.surface,
              borderColor: palette.line,
              borderWidth: StyleSheet.hairlineWidth,
            },
        disabled ? styles.disabled : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={[styles.buttonText, { color: primary ? palette.onAccent : palette.text }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: type.title, fontWeight: "600" },
  link: { fontSize: type.body, fontWeight: "600" },
  content: { padding: spacing.lg, gap: spacing.md },
  card: {
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  fact: { flexDirection: "row", justifyContent: "space-between", gap: spacing.md },
  factValue: { flexShrink: 1, fontWeight: "600" },
  form: { gap: spacing.sm },
  label: { fontSize: type.caption, fontWeight: "600" },
  input: {
    fontSize: type.body,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  bodyInput: { minHeight: 120, textAlignVertical: "top" },
  inline: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  body: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: type.caption, lineHeight: 17 },
  start: { alignSelf: "flex-start" },
  button: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    flexGrow: 1,
  },
  buttonText: { fontSize: type.body, fontWeight: "600" },
  disabled: { opacity: 0.45 },
  pressed: { transform: [{ scale: 0.97 }] },
});
