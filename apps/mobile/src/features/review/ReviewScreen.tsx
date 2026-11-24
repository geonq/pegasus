import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { hitSize, maxFontScale, radius, spacing, text, usePalette, weight } from "../../theme";
import {
  BarButton,
  Button,
  EmptyState,
  GlassCard,
  Icon,
  PressableScale,
  SegmentedControl,
  Spinner,
  TopBar,
} from "../../ui";
import { FileDiffSheet, type PendingComment } from "./FileDiffSheet";
import { GitActionsSheet } from "./GitActionsSheet";
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
  const scrollY = useSharedValue(0);

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
      <View style={[styles.fill, { backgroundColor: palette.background }]}>
        <TopBar back title="Review" />
        <EmptyState icon="iphone.slash" title="Pair this phone first" />
      </View>
    );
  }

  const failure = loadError ?? (result && result.state !== "available" ? result.message : null);

  const header = (
    <View style={styles.headerBlock}>
      <SegmentedControl onChange={setMode} options={MODES} value={mode} />
      {mode === "turn" && options.length > 0 ? (
        <ScrollView
          contentContainerStyle={styles.chips}
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          {options.map((option) => {
            const selected = option.checkpointId === turn?.checkpointId;
            return (
              <PressableScale
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                key={option.checkpointId}
                onPress={() => setCheckpointId(option.checkpointId)}
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
                <Text
                  maxFontSizeMultiplier={maxFontScale.chrome}
                  style={[
                    text.subheadline,
                    styles.semibold,
                    { color: selected ? palette.onPrimary : palette.text },
                  ]}
                >
                  {option.label}
                </Text>
                <Counts
                  added={option.totals.added}
                  inverse={selected}
                  removed={option.totals.removed}
                />
              </PressableScale>
            );
          })}
        </ScrollView>
      ) : null}
      {review ? (
        <View style={styles.summary}>
          <View style={styles.flex}>
            <Text style={[text.headline, { color: palette.textStrong }]}>
              {sum.files} {sum.files === 1 ? "file" : "files"}
              <Text style={{ color: palette.textMuted, fontWeight: weight.normal }}>
                {` · ${sum.reviewed} reviewed`}
              </Text>
            </Text>
            {review.branchName || review.baseLabel ? (
              <Text numberOfLines={1} style={[text.caption, { color: palette.textMuted }]}>
                {review.branchName ?? ""}
                {review.baseLabel && review.baseLabel !== review.branchName
                  ? ` vs ${review.baseLabel}`
                  : ""}
              </Text>
            ) : null}
          </View>
          <Counts added={sum.added} removed={sum.removed} />
        </View>
      ) : null}
      {review?.coverage.state === "partial" && review.coverage.notes.length > 0 ? (
        <Text style={[text.footnote, { color: palette.warningText }]}>
          {review.coverage.notes.join(" ")}
        </Text>
      ) : null}
      {actionError ? (
        <Text accessibilityRole="alert" style={[text.footnote, { color: palette.dangerText }]}>
          {actionError}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.fill, { backgroundColor: palette.background }]}>
      <TopBar
        back
        scrollY={scrollY}
        title="Review"
        trailing={
          review && review.scope.kind !== "turn" ? (
            <BarButton
              accessibilityLabel="Commit, push or open a pull request"
              icon="arrow.triangle.branch"
              onPress={() => setGitOpen(true)}
              tone="filled"
            />
          ) : null
        }
      />
      <FlatList
        ListEmptyComponent={
          failure ? (
            <EmptyState
              action={<Button label="Try again" onPress={load} variant="secondary" />}
              icon="exclamationmark.triangle"
              message={failure}
              title="Could not load the changes"
            />
          ) : empty ? (
            <EmptyState icon="checkmark.seal" title={empty} />
          ) : (
            <View accessibilityLabel="Loading changes" style={styles.loading}>
              <Spinner color={palette.textMuted} size={16} />
            </View>
          )
        }
        ListHeaderComponent={header}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + (comments.length > 0 ? 120 : spacing.xxl) },
        ]}
        data={files}
        keyExtractor={(file) => file.id}
        onScroll={(event) => {
          scrollY.value = event.nativeEvent.contentOffset.y;
        }}
        refreshControl={
          <RefreshControl
            onRefresh={load}
            refreshing={loading && result !== null}
            tintColor={palette.textMuted}
          />
        }
        renderItem={({ item, index }) => (
          <FileRow
            busy={busyFiles.has(item.id)}
            canStage={review ? stageActionsFor(review.scope, item) : []}
            comments={comments.filter((comment) => comment.path === item.path).length}
            file={item}
            first={index === 0}
            last={index === files.length - 1}
            onOpen={() => setOpenPath(item.path)}
            onToggleReviewed={() => toggleReviewed(item)}
          />
        )}
        scrollEventThrottle={16}
      />
      {comments.length > 0 ? (
        <View
          pointerEvents="box-none"
          style={[styles.commentDock, { paddingBottom: insets.bottom + spacing.sm }]}
        >
          <GlassCard padded={false} style={styles.commentBar}>
            <Text
              maxFontSizeMultiplier={maxFontScale.chrome}
              style={[text.footnote, styles.flex, { color: palette.textStrong }]}
            >
              {comments.length} {comments.length === 1 ? "comment" : "comments"} ready
            </Text>
            <Button
              disabled={sending}
              label="Discard"
              onPress={() => setComments([])}
              variant="secondary"
            />
            <Button busy={sending} label="Send to chat" onPress={sendComments} variant="primary" />
          </GlassCard>
        </View>
      ) : null}
      {review ? (
        <>
          <FileDiffSheet
            api={api}
            busy={openFile ? busyFiles.has(openFile.id) : false}
            comments={comments}
            file={openFile}
            onAddComment={(comment) => setComments((current) => [...current, comment])}
            onClose={() => setOpenPath(null)}
            onStage={stage}
            onToggleReviewed={toggleReviewed}
            review={review}
          />
          <GitActionsSheet
            api={api}
            onChanged={load}
            onClose={() => setGitOpen(false)}
            reviewId={review.reviewId}
            visible={gitOpen}
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
  first,
  last,
  onOpen,
  onToggleReviewed,
}: {
  readonly file: ReviewFileEntry;
  readonly busy: boolean;
  readonly canStage: readonly ("stage" | "unstage")[];
  readonly comments: number;
  readonly first: boolean;
  readonly last: boolean;
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
    <View
      style={[
        styles.fileCard,
        {
          backgroundColor: palette.surfaceElevated,
          borderColor: palette.borderDefault,
          borderTopWidth: first ? StyleSheet.hairlineWidth : 0,
          borderBottomWidth: last ? StyleSheet.hairlineWidth : 0,
          borderTopLeftRadius: first ? radius.float : 0,
          borderTopRightRadius: first ? radius.float : 0,
          borderBottomLeftRadius: last ? radius.float : 0,
          borderBottomRightRadius: last ? radius.float : 0,
        },
      ]}
    >
      <View style={styles.fileRow}>
        <Pressable
          accessibilityLabel={`Reviewed ${parts.name}`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: file.reviewed, disabled: busy }}
          disabled={busy}
          hitSlop={10}
          onPress={onToggleReviewed}
          style={[
            styles.check,
            file.reviewed
              ? { backgroundColor: palette.success, borderColor: palette.success }
              : { borderColor: palette.lineStrong },
          ]}
        >
          {busy ? (
            <Spinner color={file.reviewed ? palette.onAccent : palette.textMuted} size={10} />
          ) : file.reviewed ? (
            <Icon color={palette.onAccent} name="checkmark" size={11} weight="bold" />
          ) : null}
        </Pressable>
        <Pressable
          accessibilityHint="Shows the diff"
          accessibilityLabel={`${parts.name}, ${status.label}`}
          accessibilityRole="button"
          onPress={onOpen}
          style={({ pressed }) => [styles.fileMain, pressed ? { opacity: 0.6 } : null]}
        >
          <View style={styles.flex}>
            <Text
              numberOfLines={1}
              style={[
                text.subheadline,
                styles.medium,
                { color: file.reviewed ? palette.textMuted : palette.textStrong },
              ]}
            >
              {parts.name}
            </Text>
            <Text
              ellipsizeMode="head"
              numberOfLines={1}
              style={[text.caption, { color: palette.textMuted }]}
            >
              {file.previousPath ? `from ${file.previousPath}` : parts.folder || "/"}
              {staged ? " · staged" : canStage.length === 2 ? " · partly staged" : ""}
              {comments > 0 ? ` · ${comments} ${comments === 1 ? "comment" : "comments"}` : ""}
            </Text>
          </View>
          {file.lines ? (
            <Counts added={file.lines.added} removed={file.lines.removed} />
          ) : (
            <Text style={[text.caption, { color: palette.textMuted }]}>binary</Text>
          )}
          <View style={[styles.status, { backgroundColor: palette.overlaySubtle }]}>
            <Text
              accessibilityLabel={status.label}
              maxFontSizeMultiplier={maxFontScale.chrome}
              style={[text.caption2, { color: statusColor }]}
            >
              {status.letter}
            </Text>
          </View>
        </Pressable>
      </View>
      {!last ? (
        <View style={[styles.separator, { backgroundColor: palette.borderDefault }]} />
      ) : null}
    </View>
  );
}

function Counts({
  added,
  removed,
  inverse,
}: {
  readonly added: number;
  readonly removed: number;
  /** On an ink chip: the counts take its ink, tinted by weight only. */
  readonly inverse?: boolean;
}) {
  const palette = usePalette();
  return (
    <Text
      accessibilityLabel={`${added} added, ${removed} removed`}
      maxFontSizeMultiplier={maxFontScale.chrome}
      style={[text.caption, styles.counts]}
    >
      <Text style={{ color: inverse ? palette.onPrimary : palette.successText }}>+{added}</Text>
      <Text style={{ color: inverse ? palette.onPrimary : palette.dangerText }}> −{removed}</Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  semibold: { fontWeight: weight.semibold },
  medium: { fontWeight: weight.medium },
  list: { paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  headerBlock: { gap: spacing.md, marginBottom: spacing.md },
  chips: { gap: spacing.sm, paddingHorizontal: spacing.xxs },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: hitSize.compact + 4,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  summary: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.xs,
  },
  loading: { alignItems: "center", paddingVertical: spacing.xxl },
  fileCard: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 60,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  fileMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 60 },
  counts: { fontVariant: ["tabular-nums"], fontWeight: weight.semibold },
  status: {
    width: 22,
    height: 22,
    borderRadius: radius.sm2,
    alignItems: "center",
    justifyContent: "center",
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: spacing.lg + 22 + spacing.md },
  commentDock: { position: "absolute", left: spacing.gutter, right: spacing.gutter, bottom: 0 },
  commentBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.sm,
    paddingLeft: spacing.lg,
    borderRadius: radius.composer,
  },
});
