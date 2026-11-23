import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, spacing, type, usePalette } from "../../theme";
import { DiffView } from "./DiffView";
import { Button } from "./GitActionsSheet";
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
    <Modal
      visible={file !== null}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[styles.sheet, { backgroundColor: palette.background, paddingTop: insets.top }]}
      >
        {file && parts ? (
          <>
            <View style={[styles.header, { borderColor: palette.line }]}>
              <View style={styles.headerText}>
                <Text
                  accessibilityRole="header"
                  numberOfLines={1}
                  style={[styles.title, { color: palette.text }]}
                >
                  {parts.name}
                </Text>
                <Text
                  numberOfLines={1}
                  ellipsizeMode="head"
                  style={[styles.sub, { color: palette.textMuted }]}
                >
                  {statusOf(file.status).label}
                  {file.previousPath
                    ? ` from ${file.previousPath}`
                    : parts.folder
                      ? ` · ${parts.folder}`
                      : ""}
                </Text>
              </View>
              <Pressable accessibilityRole="button" hitSlop={12} onPress={close}>
                <Text style={[styles.link, { color: palette.accentText }]}>Close</Text>
              </Pressable>
            </View>
            <View style={[styles.toolbar, { borderColor: palette.line }]}>
              <Button
                label={file.reviewed ? "Reviewed ✓" : "Mark reviewed"}
                primary={!file.reviewed}
                disabled={busy}
                onPress={() => onToggleReviewed(file)}
              />
              {actions.map((action) => (
                <Button
                  key={action}
                  label={action === "stage" ? "Stage" : "Unstage"}
                  disabled={busy}
                  onPress={() => onStage(file, action)}
                />
              ))}
            </View>
            {loadError ? (
              <Text accessibilityRole="alert" style={[styles.message, { color: palette.danger }]}>
                {loadError}
              </Text>
            ) : result === null ? (
              <ActivityIndicator color={palette.accent} style={styles.message} />
            ) : result.state !== "available" ? (
              <Text accessibilityRole="alert" style={[styles.message, { color: palette.danger }]}>
                {result.message}
              </Text>
            ) : rows.length === 0 ? (
              <Text style={[styles.message, { color: palette.textMuted }]}>
                {result.summary ?? "No line changes to show."}
              </Text>
            ) : (
              <DiffView
                rows={rows}
                palette={palette}
                commented={commented}
                onLongPressRow={(row, index) => {
                  setDraft("");
                  setComposing({ row, index });
                }}
              />
            )}
            {composing ? (
              <View
                style={[
                  styles.composer,
                  {
                    backgroundColor: palette.surface,
                    borderColor: palette.line,
                    paddingBottom: insets.bottom + spacing.sm,
                  },
                ]}
              >
                <Text numberOfLines={1} style={[styles.quote, { color: palette.textMuted }]}>
                  Comment on line{" "}
                  {composing.row.kind === "removed"
                    ? composing.row.oldNumber
                    : composing.row.newNumber}
                  : {composing.row.text.trim()}
                </Text>
                <TextInput
                  autoFocus
                  multiline
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="What should the agent change here?"
                  placeholderTextColor={palette.textMuted}
                  style={[
                    styles.input,
                    {
                      color: palette.text,
                      backgroundColor: palette.background,
                      borderColor: palette.line,
                    },
                  ]}
                />
                <View style={styles.row}>
                  <Button label="Cancel" onPress={() => setComposing(null)} />
                  <Button
                    primary
                    label="Add comment"
                    disabled={!draft.trim()}
                    onPress={saveComment}
                  />
                </View>
              </View>
            ) : (
              <Text
                style={[
                  styles.hint,
                  { color: palette.textMuted, paddingBottom: insets.bottom + spacing.sm },
                ]}
              >
                Long-press a line to comment on it.
              </Text>
            )}
          </>
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerText: { flex: 1, gap: 2 },
  title: { fontSize: type.title, fontWeight: "600" },
  sub: { fontSize: type.caption },
  link: { fontSize: type.body, fontWeight: "600" },
  toolbar: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  message: { padding: spacing.lg, fontSize: 15, lineHeight: 21, alignSelf: "flex-start" },
  composer: { gap: spacing.sm, padding: spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  quote: {
    fontSize: type.caption,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
  },
  input: {
    minHeight: 64,
    maxHeight: 140,
    fontSize: type.body,
    padding: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: { flexDirection: "row", gap: spacing.sm },
  hint: { fontSize: type.caption, textAlign: "center", paddingTop: spacing.sm },
});
