import { useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { maxFontScale, radius, spacing, text, usePalette, weight } from "../../theme";
import { BarButton, Button, GlassCard, Icon, Layer, Spinner, TopBar } from "../../ui";
import { DiffView } from "./DiffView";
import { errorMessage, type ReviewApi } from "./review-api";
import {
  buildComment,
  parsePatch,
  splitPath,
  stageActionsFor,
  statusOf,
  type CommentableRow,
  type LineComment,
} from "./review-logic";
import type { AvailableReview, ReviewFileEntry, ReviewFileResult } from "./types";

export interface PendingComment extends LineComment {
  readonly path: string;
  readonly rowIndex: number;
}

/**
 * One file's diff, full screen: mark reviewed, stage or unstage, and long-press a line to leave a
 * comment for the chat.
 */
export function FileDiffSheet({
  api,
  review,
  file,
  busy,
  comments,
  onClose,
  onToggleReviewed,
  onStage,
  onAddComment,
}: {
  readonly api: ReviewApi;
  readonly review: AvailableReview;
  readonly file: ReviewFileEntry | null;
  readonly busy: boolean;
  readonly comments: readonly PendingComment[];
  readonly onClose: () => void;
  readonly onToggleReviewed: (file: ReviewFileEntry) => void;
  readonly onStage: (file: ReviewFileEntry, action: "stage" | "unstage") => void;
  readonly onAddComment: (comment: PendingComment) => void;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<ReviewFileResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [composing, setComposing] = useState<{ row: CommentableRow; index: number } | null>(null);
  const [draft, setDraft] = useState("");
  const nonce = useRef(0);
  const reviewId = review.reviewId;
  const fileId = file?.id;

  useEffect(() => {
    if (!fileId) return;
    const current = ++nonce.current;
    setResult(null);
    setLoadError(null);
    api.file(reviewId, fileId).then(
      (next) => {
        if (nonce.current === current) setResult(next);
      },
      (failure: unknown) => {
        if (nonce.current === current) setLoadError(errorMessage(failure));
      },
    );
  }, [api, reviewId, fileId]);

  const rows = useMemo(
    () => (result?.state === "available" ? parsePatch(result.patch) : []),
    [result],
  );
  const commented = useMemo(
    () => new Set(comments.filter((c) => c.path === file?.path).map((c) => c.rowIndex)),
    [comments, file?.path],
  );

  const close = () => {
    setComposing(null);
    setDraft("");
    onClose();
  };

  const saveComment = () => {
    if (!composing || !file) return;
    const comment = buildComment(
      file.path,
      composing.row,
      draft,
      `${Date.now()}:${composing.index}`,
    );
    if (comment) onAddComment({ ...comment, path: file.path, rowIndex: composing.index });
    setComposing(null);
    setDraft("");
  };

  const parts = file ? splitPath(file.path) : null;
  const actions = file ? stageActionsFor(review.scope, file) : [];

  return (
    <Layer visible={file !== null}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.sheet}
      >
        {file && parts ? (
          <>
            <TopBar
              center={
                <View accessibilityRole="header" accessible style={styles.title}>
                  <Text
                    maxFontSizeMultiplier={maxFontScale.chrome}
                    numberOfLines={1}
                    style={[text.headline, { color: palette.textStrong }]}
                  >
                    {parts.name}
                  </Text>
                  <Text
                    ellipsizeMode="head"
                    maxFontSizeMultiplier={maxFontScale.chrome}
                    numberOfLines={1}
                    style={[text.caption, { color: palette.textMuted }]}
                  >
                    {statusOf(file.status).label}
                    {file.previousPath
                      ? ` from ${file.previousPath}`
                      : parts.folder
                        ? ` · ${parts.folder}`
                        : ""}
                  </Text>
                </View>
              }
              trailing={
                <BarButton accessibilityLabel="Close" icon="xmark" onPress={close} tone="filled" />
              }
            />
            <View style={[styles.toolbar, { borderColor: palette.line }]}>
              <Button
                disabled={busy}
                label={file.reviewed ? "Reviewed" : "Mark reviewed"}
                onPress={() => onToggleReviewed(file)}
                style={styles.flex}
                variant={file.reviewed ? "secondary" : "primary"}
              />
              {actions.map((action) => (
                <Button
                  disabled={busy}
                  key={action}
                  label={action === "stage" ? "Stage" : "Unstage"}
                  onPress={() => onStage(file, action)}
                  variant="secondary"
                />
              ))}
            </View>
            {loadError ? (
              <Text
                accessibilityRole="alert"
                style={[text.subheadline, styles.message, { color: palette.dangerText }]}
              >
                {loadError}
              </Text>
            ) : result === null ? (
              <View accessibilityLabel="Loading the diff" style={styles.message}>
                <Spinner color={palette.textMuted} size={16} />
              </View>
            ) : result.state !== "available" ? (
              <Text
                accessibilityRole="alert"
                style={[text.subheadline, styles.message, { color: palette.dangerText }]}
              >
                {result.message}
              </Text>
            ) : rows.length === 0 ? (
              <Text style={[text.subheadline, styles.message, { color: palette.textMuted }]}>
                {result.summary ?? "No line changes to show."}
              </Text>
            ) : (
              <DiffView
                commented={commented}
                onLongPressRow={(row, index) => {
                  setDraft("");
                  setComposing({ row, index });
                }}
                palette={palette}
                rows={rows}
              />
            )}
            {composing ? (
              <View style={[styles.dock, { paddingBottom: insets.bottom + spacing.sm }]}>
                <GlassCard padded={false} style={styles.composer}>
                  <Text
                    numberOfLines={1}
                    style={[text.caption, styles.quote, { color: palette.textMuted }]}
                  >
                    Line{" "}
                    {composing.row.kind === "removed"
                      ? composing.row.oldNumber
                      : composing.row.newNumber}
                    : {composing.row.text.trim()}
                  </Text>
                  <TextInput
                    accessibilityLabel="Comment"
                    autoFocus
                    multiline
                    onChangeText={setDraft}
                    placeholder="What should the agent change here?"
                    placeholderTextColor={palette.textSoft}
                    style={[text.body, styles.input, { color: palette.textStrong }]}
                    value={draft}
                  />
                  <View style={styles.row}>
                    <Button
                      label="Cancel"
                      onPress={() => setComposing(null)}
                      style={styles.flex}
                      variant="secondary"
                    />
                    <Button
                      disabled={!draft.trim()}
                      label="Add comment"
                      onPress={saveComment}
                      style={styles.flex}
                    />
                  </View>
                </GlassCard>
              </View>
            ) : (
              <View
                style={[
                  styles.hint,
                  { borderColor: palette.line, paddingBottom: insets.bottom + spacing.sm },
                ]}
              >
                <Icon color={palette.textSoft} name="hand.tap" size={12} />
                <Text style={[text.caption, { color: palette.textMuted }]}>
                  Long-press a line to comment on it.
                </Text>
              </View>
            )}
          </>
        ) : null}
      </KeyboardAvoidingView>
    </Layer>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  title: { alignItems: "center", maxWidth: "100%" },
  toolbar: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  message: { padding: spacing.xl, alignItems: "center" },
  dock: { paddingHorizontal: spacing.gutter, paddingTop: spacing.sm },
  composer: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.composer },
  quote: {
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontWeight: weight.medium,
  },
  input: { minHeight: 64, maxHeight: 140, paddingVertical: spacing.xs },
  row: { flexDirection: "row", gap: spacing.sm },
  hint: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm2,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
