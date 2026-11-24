import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { hitSize, radius, spacing, text, usePalette, weight } from "../../theme";
import { BarButton, Button, Icon, Layer, Spinner, TopBar, useOverlay } from "../../ui";
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
  const overlay = useOverlay();
  const insets = useSafeAreaInsets();
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
    void overlay.confirm({ title, message, confirmLabel: label }).then((ok) => {
      if (ok) action();
    });

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
    {
      color: palette.textStrong,
      backgroundColor: palette.surfaceElevated,
      borderColor: palette.borderDefault,
    },
  ];

  return (
    <Layer visible={visible}>
      <TopBar
        center={
          <View accessibilityRole="header" accessible style={styles.title}>
            <Text style={[text.headline, { color: palette.textStrong }]}>Git</Text>
            {state?.branch ? (
              <Text numberOfLines={1} style={[text.caption, { color: palette.textMuted }]}>
                {state.branch}
              </Text>
            ) : null}
          </View>
        }
        trailing={
          <BarButton
            accessibilityLabel="Close"
            disabled={busy !== null}
            icon="xmark"
            onPress={onClose}
            tone="filled"
          />
        }
      />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {loadError ? (
          <Text accessibilityRole="alert" style={[text.subheadline, { color: palette.dangerText }]}>
            {loadError}
          </Text>
        ) : !state || !step ? (
          <View accessibilityLabel="Loading" style={styles.loading}>
            <Spinner color={palette.textMuted} size={16} />
          </View>
        ) : (
          <>
            <View
              style={[
                styles.card,
                { backgroundColor: palette.surfaceElevated, borderColor: palette.borderDefault },
              ]}
            >
              <Fact
                icon="arrow.triangle.branch"
                label="Branch"
                value={state.branch ?? "Detached HEAD"}
              />
              <Fact icon="icloud" label="Tracks" value={state.upstream ?? "Not published"} />
              <Fact icon="tray.full" label="Staged" value={String(state.staged)} />
              <Fact icon="pencil.line" label="Not staged" value={String(state.unstaged)} />
              {state.ahead > 0 ? (
                <Fact icon="arrow.up.circle" label="To push" value={`${state.ahead}`} />
              ) : null}
              {state.pullRequest ? (
                <Fact
                  icon="arrow.triangle.pull"
                  label="Pull request"
                  value={`#${state.pullRequest.number}`}
                />
              ) : null}
            </View>
            {form ? (
              <View style={styles.form}>
                <Text style={[text.footnote, styles.label, { color: palette.textMuted }]}>
                  {form.kind === "commit" ? "Commit message" : "Pull request title"}
                </Text>
                <TextInput
                  accessibilityLabel={
                    form.kind === "commit" ? "Commit message" : "Pull request title"
                  }
                  editable={busy === null}
                  onChangeText={(title) =>
                    setForm((current) => (current ? { ...current, title, edited: true } : current))
                  }
                  placeholder={form.drafting ? "Drafting…" : "Title"}
                  placeholderTextColor={palette.textSoft}
                  style={field}
                  value={form.title}
                />
                <TextInput
                  accessibilityLabel="Description"
                  editable={busy === null}
                  multiline
                  onChangeText={(body) =>
                    setForm((current) => (current ? { ...current, body, edited: true } : current))
                  }
                  placeholder={form.drafting ? "Drafting…" : "Description (optional)"}
                  placeholderTextColor={palette.textSoft}
                  style={[field, styles.bodyInput]}
                  value={form.body}
                />
                {form.drafting ? (
                  <View style={styles.inline}>
                    <Spinner color={palette.textMuted} size={11} />
                    <Text style={[text.footnote, { color: palette.textMuted }]}>
                      The chat's model is drafting this.
                    </Text>
                  </View>
                ) : form.note ? (
                  <Text style={[text.footnote, { color: palette.textMuted }]}>{form.note}</Text>
                ) : null}
                <View style={styles.inline}>
                  <Button
                    disabled={busy !== null}
                    label="Cancel"
                    onPress={() => {
                      draftNonce.current += 1;
                      setForm(null);
                    }}
                    style={styles.flex}
                    variant="secondary"
                  />
                  <Button
                    busy={busy !== null}
                    disabled={busy !== null || !form.title.trim()}
                    label={
                      busy ? BUSY_LABEL[busy] : form.kind === "commit" ? "Commit" : "Create PR"
                    }
                    onPress={submit}
                    style={styles.flex}
                  />
                </View>
              </View>
            ) : (
              <View style={styles.form}>
                <Button
                  busy={busy !== null}
                  disabled={busy !== null || step.kind === "none"}
                  label={busy ? BUSY_LABEL[busy] : step.label}
                  onPress={onStep}
                />
                <Text style={[text.footnote, styles.center, { color: palette.textMuted }]}>
                  {step.hint}
                </Text>
              </View>
            )}
            {done ? (
              <View
                accessibilityLiveRegion="polite"
                style={[styles.note, { backgroundColor: palette.successTint }]}
              >
                <Icon color={palette.successText} name="checkmark.circle.fill" size={14} />
                <Text style={[text.subheadline, { color: palette.successText }]}>{done}</Text>
              </View>
            ) : null}
            {error ? (
              <View
                accessibilityRole="alert"
                style={[styles.note, { backgroundColor: palette.dangerTint }]}
              >
                <Icon color={palette.dangerText} name="exclamationmark.triangle.fill" size={14} />
                <Text style={[text.subheadline, styles.flex, { color: palette.dangerText }]}>
                  {error}
                </Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </Layer>
  );
}

function Fact({
  icon,
  label,
  value,
}: {
  readonly icon: Parameters<typeof Icon>[0]["name"];
  readonly label: string;
  readonly value: string;
}) {
  const palette = usePalette();
  return (
    <View style={styles.fact}>
      <Icon color={palette.textSoft} name={icon} size={14} />
      <Text style={[text.subheadline, styles.flex, { color: palette.textMuted }]}>{label}</Text>
      <Text
        numberOfLines={1}
        style={[text.subheadline, styles.factValue, { color: palette.textStrong }]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  center: { textAlign: "center" },
  title: { alignItems: "center" },
  content: { padding: spacing.md, gap: spacing.lg },
  loading: { alignItems: "center", paddingVertical: spacing.xxl },
  card: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.float,
    borderWidth: StyleSheet.hairlineWidth,
  },
  fact: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: hitSize.min - 4 },
  factValue: { flexShrink: 1, fontWeight: weight.semibold, fontVariant: ["tabular-nums"] },
  form: { gap: spacing.sm },
  label: { fontWeight: weight.semibold, paddingHorizontal: spacing.xs },
  input: {
    ...text.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md2,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  bodyInput: { minHeight: 120, textAlignVertical: "top" },
  inline: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
  },
});
