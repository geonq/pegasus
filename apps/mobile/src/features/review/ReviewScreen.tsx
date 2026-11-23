import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, spacing, type, usePalette } from "../../theme";
import { FileDiffSheet, type PendingComment } from "./FileDiffSheet";
import { Button, GitActionsSheet } from "./GitActionsSheet";
import { errorMessage, useReviewApi } from "./review-api";
import {
  formatCommentsPrompt,
  sortFiles,
  splitPath,
  stageActionsFor,
  statusOf,
  totals,
  turnOptions,
  type TurnOption,
} from "./review-logic";
import type { ReviewFileEntry, ReviewResult, ReviewScope, TurnChangesResult } from "./types";

type Mode = "turn" | "uncommitted" | "branch";

const MODES: readonly { readonly id: Mode; readonly label: string }[] = [
  { id: "turn", label: "Turns" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "branch", label: "Branch" },
];

interface ReviewScreenProps {
  readonly route: { readonly params: { readonly workspaceId: string; readonly sessionId: string } };
}

/**
 * What a chat changed on the PC: per captured turn, uncommitted, or the whole branch. Tap a file
 * for its diff; stage, mark reviewed, comment on lines, and run the next git step from here.
 */
export default function ReviewScreen({ route }: ReviewScreenProps) {
  const { workspaceId, sessionId } = route.params;
  const target = useMemo(() => ({ workspaceId, sessionId }), [workspaceId, sessionId]);
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const api = useReviewApi();
  const [mode, setMode] = useState<Mode>("turn");
  const [turns, setTurns] = useState<TurnChangesResult | null>(null);
  const [checkpointId, setCheckpointId] = useState<string | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyFiles, setBusyFiles] = useState<ReadonlySet<string>>(new Set());
  // By path: a reload after staging brings new file ids, and the open diff should follow its file.
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [comments, setComments] = useState<readonly PendingComment[]>([]);
  const [sending, setSending] = useState(false);
  const nonce = useRef(0);

  const options: TurnOption[] = useMemo(
    () => (turns?.state === "available" ? turnOptions(turns.turns) : []),
    [turns],
  );
  const turn = options.find((option) => option.checkpointId === checkpointId) ?? options[0];

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.turnChanges(target).then(
      (next) => {
        if (!cancelled) setTurns(next);
      },
      (failure: unknown) => {
        if (!cancelled)
          setTurns({ state: "failed", code: "turns-failed", message: errorMessage(failure) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, target]);

  const scope: ReviewScope | null =
    mode === "turn"
      ? turn
        ? { kind: "turn", checkpointId: turn.checkpointId }
        : null
      : { kind: mode };
  const checkoutId = mode === "turn" && turn ? turn.checkoutId : workspaceId;
  const scopeKey = JSON.stringify(scope);

  const load = useCallback(() => {
    if (!api || !scope) {
      setResult(null);
      return;
    }
    const current = ++nonce.current;
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    api
      .review({ target, checkoutId, scope })
      .then(
        (next) => {
          if (nonce.current === current) setResult(next);
        },
        (failure: unknown) => {
          if (nonce.current === current) {
            setResult(null);
            setLoadError(errorMessage(failure));
          }
        },
      )
      .finally(() => {
        if (nonce.current === current) setLoading(false);
      });
    // scopeKey stands in for scope, which is rebuilt every render.
  }, [api, target, checkoutId, scopeKey]);

  useEffect(() => {
    // Comments quote lines of one comparison; a new comparison starts without them.
    setComments([]);
    setResult(null);
    load();
  }, [load]);

  const review = result?.state === "available" ? result : null;
  const files = useMemo(() => (review ? sortFiles(review.files) : []), [review]);
  const sum = useMemo(() => totals(files), [files]);
  const openFile = files.find((file) => file.path === openPath) ?? null;

  const setBusy = (id: string, on: boolean) =>
    setBusyFiles((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const toggleReviewed = (file: ReviewFileEntry) => {
    if (!api || !review) return;
    const reviewId = review.reviewId;
    setBusy(file.id, true);
    api
      .setReviewed(reviewId, file.id, !file.reviewed)
      .then(
        (next) => {
          if (next.state !== "available") {
            setActionError(next.message);
            if (next.state === "stale") load();
            return;
          }
          setResult((current) =>
            current?.state === "available" && current.reviewId === next.reviewId
              ? {
                  ...current,
                  files: current.files.map((entry) =>
                    entry.id === next.fileId ? { ...entry, reviewed: next.reviewed } : entry,
                  ),
                }
              : current,
          );
        },
        (failure: unknown) => setActionError(errorMessage(failure)),
      )
      .finally(() => setBusy(file.id, false));
  };

  const stage = (file: ReviewFileEntry, action: "stage" | "unstage") => {
    if (!api || !review) return;
    setBusy(file.id, true);
    api
      .stage(review.reviewId, file.id, action)
      .then(
        (next) => {
          if (next.state === "applied") load();
          else {
            setActionError(next.message);
            if (next.state === "stale") load();
          }
        },
        (failure: unknown) => setActionError(errorMessage(failure)),
      )
      .finally(() => setBusy(file.id, false));
  };

  const sendComments = () => {
    if (!api || comments.length === 0) return;
    setSending(true);
    setActionError(null);
    api
      .sendComments(target, formatCommentsPrompt(comments))
      .then(
        (next) => {
          if (next.state === "sent") setComments([]);
          else setActionError(next.message);
        },
        (failure: unknown) => setActionError(errorMessage(failure)),
      )
      .finally(() => setSending(false));
  };

  const empty =
    mode === "turn" && turns?.state === "available" && options.length === 0
      ? "No captured turn changed files in this chat yet."
      : mode === "turn" && turns && turns.state !== "available"
        ? turns.message
        : review && files.length === 0
          ? mode === "uncommitted"
            ? "No uncommitted changes."
            : "No changes."
          : null;

  if (!api) {
    return (
      <View style={[styles.center, { backgroundColor: palette.background }]}>
        <Text style={[styles.body, { color: palette.textMuted }]}>Pair this phone first.</Text>
      </View>
    );
  }

  const header = (
    <View style={styles.headerBlock}>
      <View
        style={[styles.segments, { backgroundColor: palette.surface, borderColor: palette.line }]}
      >
        {MODES.map((item) => {
          const selected = item.id === mode;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setMode(item.id)}
              style={[styles.segment, selected ? { backgroundColor: palette.surfaceRaised } : null]}
            >
              <Text
                style={[styles.segmentText, { color: selected ? palette.text : palette.textMuted }]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {mode === "turn" && options.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          {options.map((option) => {
            const selected = option.checkpointId === turn?.checkpointId;
            return (
              <Pressable
                key={option.checkpointId}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => setCheckpointId(option.checkpointId)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: selected ? palette.surfaceRaised : palette.surface,
                    borderColor: selected ? palette.accent : palette.line,
                  },
                ]}
              >
                <Text style={[styles.chipLabel, { color: palette.text }]}>{option.label}</Text>
                <Counts added={option.totals.added} removed={option.totals.removed} />
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {review ? (
        <View style={styles.summary}>
          <Text style={[styles.caption, { color: palette.textMuted }]} numberOfLines={1}>
            {sum.files} {sum.files === 1 ? "file" : "files"} · {sum.reviewed} reviewed
            {review.branchName ? ` · ${review.branchName}` : ""}
            {review.baseLabel ? ` vs ${review.baseLabel}` : ""}
          </Text>
          <Counts added={sum.added} removed={sum.removed} />
        </View>
      ) : null}
      {review?.coverage.state === "partial" && review.coverage.notes.length > 0 ? (
        <Text style={[styles.caption, { color: palette.warning }]}>
          {review.coverage.notes.join(" ")}
        </Text>
      ) : null}
      {review && review.scope.kind !== "turn" ? (
        <Button label="Commit, push or open a PR" onPress={() => setGitOpen(true)} />
      ) : null}
      {actionError ? (
        <Text accessibilityRole="alert" style={[styles.body, { color: palette.danger }]}>
          {actionError}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.fill, { backgroundColor: palette.background }]}>
      <FlatList
        data={files}
        keyExtractor={(file) => file.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={loading && result !== null}
            onRefresh={load}
            tintColor={palette.accent}
          />
        }
        ListHeaderComponent={header}
        ListEmptyComponent={
          loadError ||
          result?.state === "failed" ||
          result?.state === "unavailable" ||
          result?.state === "stale" ? (
            <Text accessibilityRole="alert" style={[styles.body, { color: palette.danger }]}>
              {loadError ?? (result && result.state !== "available" ? result.message : "")}
            </Text>
          ) : empty ? (
            <Text style={[styles.body, { color: palette.textMuted }]}>{empty}</Text>
          ) : (
            <ActivityIndicator color={palette.accent} style={styles.start} />
          )
        }
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: palette.line }]} />
        )}
        renderItem={({ item }) => (
          <FileRow
            file={item}
            busy={busyFiles.has(item.id)}
            canStage={review ? stageActionsFor(review.scope, item) : []}
            comments={comments.filter((comment) => comment.path === item.path).length}
            onOpen={() => setOpenPath(item.path)}
            onToggleReviewed={() => toggleReviewed(item)}
          />
        )}
      />
      {comments.length > 0 ? (
        <View
          style={[
            styles.commentBar,
            {
              backgroundColor: palette.surface,
              borderColor: palette.line,
              paddingBottom: insets.bottom + spacing.sm,
            },
          ]}
        >
          <Button label="Discard" disabled={sending} onPress={() => setComments([])} />
          <Button
            primary
            label={
              sending
                ? "Sending…"
                : `Send ${comments.length} ${comments.length === 1 ? "comment" : "comments"} to the chat`
            }
            disabled={sending}
            onPress={sendComments}
          />
        </View>
      ) : null}
      {review ? (
        <>
          <FileDiffSheet
            api={api}
            review={review}
            file={openFile}
            busy={openFile ? busyFiles.has(openFile.id) : false}
            comments={comments}
            onClose={() => setOpenPath(null)}
            onToggleReviewed={toggleReviewed}
            onStage={stage}
            onAddComment={(comment) => setComments((current) => [...current, comment])}
          />
          <GitActionsSheet
            api={api}
            reviewId={review.reviewId}
            visible={gitOpen}
            onClose={() => setGitOpen(false)}
            onChanged={load}
          />
        </>
      ) : null}
    </View>
  );
}

function FileRow({
  file,
  busy,
  canStage,
  comments,
  onOpen,
  onToggleReviewed,
}: {
  readonly file: ReviewFileEntry;
  readonly busy: boolean;
  readonly canStage: readonly ("stage" | "unstage")[];
  readonly comments: number;
  readonly onOpen: () => void;
  readonly onToggleReviewed: () => void;
}) {
  const palette = usePalette();
  const parts = splitPath(file.path);
  const status = statusOf(file.status);
  const statusColor =
    file.status === "deleted" || file.conflicted
      ? palette.danger
      : file.status === "added" || file.status === "untracked"
        ? palette.success
        : palette.warning;
  const staged = canStage.length > 0 && file.hasStagedChanges && !file.hasUnstagedChanges;
  return (
    <View style={styles.fileRow}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={`Reviewed ${parts.name}`}
        accessibilityState={{ checked: file.reviewed, disabled: busy }}
        disabled={busy}
        hitSlop={8}
        onPress={onToggleReviewed}
        style={[
          styles.check,
          { borderColor: file.reviewed ? palette.accent : palette.line },
          file.reviewed ? { backgroundColor: palette.accent } : null,
        ]}
      >
        {busy ? (
          <ActivityIndicator
            size="small"
            color={file.reviewed ? palette.onAccent : palette.accent}
          />
        ) : file.reviewed ? (
          <Text style={[styles.checkMark, { color: palette.onAccent }]}>✓</Text>
        ) : null}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${parts.name}, ${status.label}`}
        accessibilityHint="Shows the diff"
        onPress={onOpen}
        style={({ pressed }) => [styles.fileMain, pressed ? { opacity: 0.6 } : null]}
      >
        <View style={styles.fileText}>
          <Text
            numberOfLines={1}
            style={[styles.fileName, { color: file.reviewed ? palette.textMuted : palette.text }]}
          >
            {parts.name}
          </Text>
          <Text
            numberOfLines={1}
            ellipsizeMode="head"
            style={[styles.caption, { color: palette.textMuted }]}
          >
            {file.previousPath ? `from ${file.previousPath}` : parts.folder || "/"}
            {staged ? " · staged" : canStage.length === 2 ? " · partly staged" : ""}
            {comments > 0 ? ` · ${comments} ${comments === 1 ? "comment" : "comments"}` : ""}
          </Text>
        </View>
        {file.lines ? (
          <Counts added={file.lines.added} removed={file.lines.removed} />
        ) : (
          <Text style={[styles.caption, { color: palette.textMuted }]}>binary</Text>
        )}
        <Text
          accessibilityLabel={status.label}
          style={[styles.status, { color: statusColor, borderColor: statusColor }]}
        >
          {status.letter}
        </Text>
      </Pressable>
    </View>
  );
}

function Counts({ added, removed }: { readonly added: number; readonly removed: number }) {
  const palette = usePalette();
  return (
    <Text style={styles.counts} accessibilityLabel={`${added} added, ${removed} removed`}>
      <Text style={{ color: palette.success }}>+{added}</Text>
      <Text style={{ color: palette.danger }}> −{removed}</Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg },
  list: { padding: spacing.lg, paddingBottom: spacing.xl * 3 },
  headerBlock: { gap: spacing.md, marginBottom: spacing.md },
  segments: {
    flexDirection: "row",
    padding: 2,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  segment: {
    flex: 1,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm - 2,
  },
  segmentText: { fontSize: 14, fontWeight: "600" },
  chips: { gap: spacing.sm },
  chip: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  chipLabel: { fontSize: 14, fontWeight: "600" },
  summary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  caption: { fontSize: type.caption, lineHeight: 17, flexShrink: 1 },
  body: { fontSize: 15, lineHeight: 21 },
  start: { alignSelf: "flex-start" },
  separator: { height: StyleSheet.hairlineWidth },
  fileRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 56 },
  check: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  checkMark: { fontSize: 15, fontWeight: "700" },
  fileMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 56 },
  fileText: { flex: 1, gap: 2 },
  fileName: { fontSize: type.body, fontWeight: "500" },
  counts: { fontSize: type.caption, fontVariant: ["tabular-nums"], fontWeight: "600" },
  status: {
    width: 20,
    textAlign: "center",
    fontSize: 11,
    fontWeight: "700",
    borderWidth: 1,
    borderRadius: 4,
    overflow: "hidden",
  },
  commentBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
