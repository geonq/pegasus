import { type LegendListRef } from "@legendapp/list/react-native";
import { KeyboardAwareLegendList, useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  StyleSheet,
  Text,
  View,
  type HostInstance,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pendingDialogsOf, sessionKey } from "../api/chats";
import { transcriptFor } from "../api/transcript-cache";
import type { PendingDialogAnswer, TranscriptItem } from "../api/types";
import { LIMIT_WARNING_PERCENT, planStatus, resetsIn } from "../api/usage";
import { groupTranscript } from "../api/worklog";
import { ApprovalCard } from "../components/ApprovalCard";
import { messageOf, useChatActions } from "../features/chat/actions";
import { ChatTitle, type ChatStatus } from "../features/chat/ChatHeader";
import { Composer } from "../features/chat/Composer";
import { FloatingStatus } from "../features/chat/FloatingStatus";
import { SubagentRows } from "../features/chat/SubagentRows";
import { selectionHaptic, TranscriptRow } from "../features/chat/TranscriptRow";
import { hasRuntime, modelsOf, permissionOf, sessionConfigOf } from "../features/chat/wire";
import type { RootStackParamList } from "../navigation";
import { usePegasus } from "../state/PegasusProvider";
import {
  BarButton,
  Button,
  EmptyState,
  Icon,
  PressableScale,
  Skeleton,
  Spinner,
  TopBar,
  useOverlay,
  type MenuSection,
} from "../ui";
import { maxFontScale, radius, spacing, text, usePalette } from "../theme";

/** Past this many points from the end, the person is reading back: stop following, offer a jump. */
const FOLLOW_THRESHOLD = 120;

/**
 * One chat: its work log as it streams in, approvals and questions inline at its end, and the
 * composer that sends, queues or steers. A chat opened before draws its last copy at once while
 * the PC selects it; the live transcript then replaces it in place. The composer rides on the
 * keyboard and the list's end inset follows the composer's height, so the last message is never
 * covered. Everything is drawn from the PC's state; the screen only owns what was typed, which
 * rows are expanded, and whether the person scrolled up.
 */
export function ChatScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, "Chat">) {
  const { workspaceId, sessionId, title: routeTitle } = route.params;
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const {
    state,
    transcript: liveTranscript,
    cachedTranscript,
    status,
    openChat,
    stop,
    answer,
    removeQueued,
    steerQueued,
  } = usePegasus();
  const actions = useChatActions(workspaceId, sessionId);
  const overlay = useOverlay();
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const list = useRef<LegendListRef>(null);
  const dock = useRef<HostInstance>(null);
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(list, dock);

  const workspace = state?.workspaces.find((entry) => entry.id === workspaceId);
  const session = workspace?.sessions.find((entry) => entry.id === sessionId);
  const running = session?.status === "running";
  const live = status.state === "live";
  const key = sessionKey(workspaceId, sessionId);
  const config = sessionConfigOf(session);
  const models = useMemo(() => modelsOf(state, workspaceId), [state, workspaceId]);
  const modelsLoaded = hasRuntime(state, workspaceId);
  const permission = permissionOf(state, key);
  const pending = pendingDialogsOf(state?.sessionExtensionUiBySession, workspaceId, sessionId);
  const asked = pending[0];
  const queued = state?.queuedComposerMessages ?? [];
  const agents = useMemo(
    () =>
      (state?.orchestrationChildren ?? []).filter(
        (child) => child.parentWorkspaceId === workspaceId && child.parentSessionId === sessionId,
      ),
    [state?.orchestrationChildren, workspaceId, sessionId],
  );
  const plan = planStatus(state?.sessionUsageBySession?.[key]);

  // Opening a chat also tells the PC which chat this phone is looking at, so the transcript, the
  // queue and sendText all belong to the chat on screen after coming back from a child.
  useFocusEffect(
    useCallback(() => {
      setOpenError(null);
      openChat({ workspaceId, sessionId }).catch((reason: unknown) =>
        setOpenError(messageOf(reason)),
      );
    }, [openChat, sessionId, workspaceId, opening]),
  );

  // The model list comes with the project's runtime, which the PC loads on request.
  useEffect(() => {
    if (live && workspace && !modelsLoaded) actions.loadRuntime().catch(() => undefined);
  }, [actions, live, modelsLoaded, workspace]);

  const shown = transcriptFor(
    liveTranscript,
    { get: (w, s) => cachedTranscript({ workspaceId: w, sessionId: s }) },
    workspaceId,
    sessionId,
  );
  const stale = shown.stale;
  const items = useMemo(
    () => (shown.transcript ? shown.transcript.transcript.filter(isShown) : null),
    [shown.transcript],
  );
  const rows = useMemo(() => groupTranscript(items ?? []), [items]);
  const lastRowId = rows[rows.length - 1]?.id;

  // A new approval or question is news even when the phone is in hand: a warning tap.
  const askedId = asked?.requestId;
  useEffect(() => {
    if (!askedId) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
  }, [askedId]);

  // The run ending is the moment the person was waiting for.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      Haptics.notificationAsync(
        session?.status === "failed"
          ? Haptics.NotificationFeedbackType.Error
          : Haptics.NotificationFeedbackType.Success,
      ).catch(() => undefined);
    }
    wasRunning.current = running;
  }, [running, session?.status]);

  const jumpToLatest = useCallback(() => {
    setAwayFromEnd(false);
    list.current?.scrollToEnd({ animated: true }).catch(() => undefined);
  }, []);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement, contentInset } = event.nativeEvent;
    const distance =
      contentSize.height + (contentInset?.bottom ?? 0) - layoutMeasurement.height - contentOffset.y;
    const away = distance > FOLLOW_THRESHOLD;
    setAwayFromEnd((current) => (current === away ? current : away));
  }, []);

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    selectionHaptic();
  }, []);

  const submitAnswer = useCallback(
    (next: PendingDialogAnswer) => answer({ workspaceId, sessionId }, next),
    [answer, sessionId, workspaceId],
  );

  const title = session?.title || routeTitle || "Chat";
  const model = models.find(
    (entry) => entry.providerId === config.provider && entry.modelId === config.modelId,
  );
  const subtitle = [workspace?.name, model?.label ?? config.modelId].filter(Boolean).join(" · ");
  const headerStatus: ChatStatus = !live
    ? "offline"
    : asked
      ? "waiting"
      : running
        ? "working"
        : session?.status === "failed"
          ? "failed"
          : "idle";

  const menu = useMemo<MenuSection[]>(() => {
    const fail = (label: string) => (reason: unknown) =>
      overlay.toast({ message: `${label}: ${messageOf(reason)}`, tone: "danger" });
    const sections: MenuSection[] = [
      {
        items: [
          {
            id: "review",
            label: "Review changes",
            icon: "doc.text.magnifyingglass",
            onPress: () => navigation.navigate("Review", { workspaceId, sessionId }),
          },
          {
            id: "usage",
            label: "Usage",
            icon: "gauge.with.dots.needle.33percent",
            onPress: () => navigation.navigate("Usage", { workspaceId, sessionId }),
          },
          {
            id: "new",
            label: "New chat in this project",
            icon: "square.and.pencil",
            onPress: () =>
              navigation.navigate("NewChat", {
                workspaceId:
                  workspace?.kind === "worktree" && workspace.rootWorkspaceId
                    ? workspace.rootWorkspaceId
                    : workspaceId,
              }),
          },
        ],
      },
    ];
    if (session) {
      sections.push({
        items: [
          {
            id: "pin",
            label: session.pinnedAt ? "Unpin" : "Pin",
            icon: session.pinnedAt ? "pin.slash" : "pin",
            onPress: () =>
              actions.setPinned(!session.pinnedAt).catch(fail("Could not change the pin")),
          },
          session.archivedAt
            ? {
                id: "unarchive",
                label: "Unarchive",
                icon: "tray.and.arrow.up",
                onPress: () => actions.unarchive().catch(fail("Could not unarchive the chat")),
              }
            : {
                id: "archive",
                label: "Archive",
                icon: "archivebox",
                destructive: true,
                onPress: () =>
                  void overlay
                    .confirm({
                      title: "Archive this chat?",
                      message: "It leaves the list. You can find it on the PC.",
                      confirmLabel: "Archive",
                      destructive: true,
                    })
                    .then((ok) => {
                      if (!ok) return;
                      actions
                        .archive()
                        .then(() => navigation.goBack())
                        .catch(fail("Could not archive the chat"));
                    }),
              },
        ],
      });
    }
    return sections;
  }, [actions, navigation, overlay, session, sessionId, workspace, workspaceId]);

  const banner =
    status.state === "retrying"
      ? {
          tone: "warning" as const,
          line: `${status.reason} Retrying in ${Math.max(1, Math.round(status.inMs / 1000))} s. Showing the last update.`,
        }
      : status.state === "revoked"
        ? { tone: "warning" as const, line: status.reason }
        : status.state === "connecting" && state
          ? { tone: "quiet" as const, line: "Reconnecting…" }
          : stale && !openError
            ? { tone: "quiet" as const, line: "Loading the latest…" }
            : null;

  const limitReset = plan ? resetsIn(plan.resetsAt, Date.now()) : null;
  const sessionGone = Boolean(state) && !session;
  const since = running && session?.runningSince ? Date.parse(session.runningSince) : NaN;
  // Until the PC has this chat selected, a send would land in whichever chat it had open.
  const canSend = live && !stale;

  let body: ReactNode;
  if (sessionGone) {
    body = (
      <View style={styles.center}>
        <EmptyState
          icon="questionmark.bubble"
          action={
            <Button label="Back to chats" onPress={() => navigation.goBack()} variant="secondary" />
          }
          message="It was deleted or archived on the PC."
          title="This chat is not on the PC"
        />
      </View>
    );
  } else if (items === null && openError) {
    body = (
      <View style={styles.center}>
        <EmptyState
          icon="exclamationmark.triangle"
          action={
            <Button
              label="Try again"
              onPress={() => setOpening((value) => value + 1)}
              variant="primary"
            />
          }
          message={`${openError} Check that the PC is awake, then try again.`}
          title="Could not open this chat"
        />
      </View>
    );
  } else if (items === null) {
    body = (
      <View accessibilityLabel="Loading the chat" accessible style={styles.skeleton}>
        <View style={styles.skeletonUser}>
          <Skeleton height={40} rounded={radius.lg} width="60%" />
        </View>
        <Skeleton width="92%" />
        <Skeleton width="84%" />
        <Skeleton width="70%" />
        <Skeleton height={44} rounded={radius.md} />
        <Skeleton width="88%" />
        <Skeleton width="56%" />
      </View>
    );
  } else {
    body = (
      <KeyboardAwareLegendList
        ListEmptyComponent={
          asked ? null : (
            <View style={styles.center}>
              <EmptyState
                icon={running ? "ellipsis.bubble" : "bubble.left"}
                message={
                  running
                    ? "The first reply is on its way."
                    : "Ask for a change, a review or an answer."
                }
                title={running ? "Working on it" : "Start the conversation"}
              />
            </View>
          )
        }
        ListFooterComponent={
          <View style={styles.footer}>
            {agents.length > 0 ? (
              <SubagentRows
                agents={agents}
                onOpen={(agent) =>
                  navigation.push("Chat", {
                    workspaceId: agent.childWorkspaceId,
                    sessionId: agent.childSessionId,
                    title: agent.title,
                  })
                }
              />
            ) : null}
            {asked ? (
              <ApprovalCard
                dialog={asked}
                key={asked.requestId}
                onAnswer={submitAnswer}
                waiting={pending.length}
              />
            ) : null}
          </View>
        }
        alignItemsAtEnd
        contentContainerStyle={styles.content}
        // The TopBar already clears the status bar; an automatic inset here would add it twice.
        contentInsetAdjustmentBehavior="never"
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        data={rows}
        estimatedItemSize={88}
        extraData={expanded}
        getItemType={(row) => row.kind}
        initialScrollAtEnd
        keyExtractor={(row) => row.id}
        keyboardDismissMode="interactive"
        keyboardLiftBehavior="whenAtEnd"
        keyboardOffset={dockOffset(insets.bottom)}
        keyboardShouldPersistTaps="handled"
        maintainScrollAtEnd
        maintainScrollAtEndThreshold={0.15}
        maintainVisibleContentPosition
        onScroll={onScroll}
        ref={list}
        renderItem={({ item }) => (
          <TranscriptRow
            expanded={expanded.has(item.id)}
            isLast={item.id === lastRowId}
            onToggle={toggle}
            row={item}
            sessionId={sessionId}
            sessionRunning={running}
            workspaceId={workspaceId}
          />
        )}
        scrollEventThrottle={32}
      />
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <TopBar
        back
        center={<ChatTitle status={headerStatus} subtitle={subtitle} title={title} />}
        trailing={<BarButton accessibilityLabel="Chat actions" icon="ellipsis" menu={menu} />}
      />
      {banner ? (
        <View
          accessibilityLiveRegion="polite"
          style={[
            styles.banner,
            { backgroundColor: banner.tone === "warning" ? palette.warningTint : palette.surface },
          ]}
        >
          {banner.tone === "warning" ? (
            <Icon name="wifi.exclamationmark" color={palette.warningText} size={14} />
          ) : (
            <Spinner color={palette.textMuted} size={12} />
          )}
          <Text
            style={[
              text.footnote,
              styles.flex,
              { color: banner.tone === "warning" ? palette.warningText : palette.textMuted },
            ]}
          >
            {banner.line}
          </Text>
        </View>
      ) : null}

      <View style={styles.flex}>{body}</View>

      {!sessionGone ? (
        <KeyboardStickyView
          offset={{ closed: 0, opened: dockOffset(insets.bottom) }}
          style={styles.dock}
        >
          <View onLayout={onComposerLayout} pointerEvents="box-none" ref={dock}>
            <FloatingStatus
              onJump={jumpToLatest}
              showJump={awayFromEnd && items !== null && rows.length > 0}
              working={
                running && !Number.isNaN(since)
                  ? { since, ...(session?.currentStep ? { step: session.currentStep } : {}) }
                  : null
              }
            />
            {plan && plan.usedPercent >= LIMIT_WARNING_PERCENT ? (
              <PressableScale
                accessibilityHint="Opens usage"
                accessibilityRole="button"
                onPress={() => navigation.navigate("Usage", { workspaceId, sessionId })}
                style={styles.limit}
              >
                <Icon
                  name="gauge.with.dots.needle.67percent"
                  color={palette.warningText}
                  size={12}
                />
                <Text
                  maxFontSizeMultiplier={maxFontScale.chrome}
                  style={[text.caption, { color: palette.warningText }]}
                >
                  {plan.provider} usage {Math.round(plan.usedPercent)}%
                  {limitReset ? ` · ${limitReset}` : ""}
                </Text>
              </PressableScale>
            ) : null}
            <Composer
              actions={actions}
              bottomInset={insets.bottom}
              config={config}
              live={canSend}
              models={models}
              modelsLoaded={modelsLoaded}
              onRemoveQueued={removeQueued}
              onSent={jumpToLatest}
              onSteerQueued={steerQueued}
              onStop={() => stop({ workspaceId, sessionId })}
              permission={permission}
              queued={stale || items === null ? [] : queued}
              running={running}
            />
          </View>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
}

/**
 * How far the docked composer sinks while the keyboard is up: the safe-area part of its bottom
 * padding, which the keyboard already covers (Composer pads max(bottomInset, 8)).
 */
function dockOffset(bottomInset: number): number {
  return Math.max(0, Math.max(bottomInset, spacing.sm) - spacing.sm);
}

function isShown(item: TranscriptItem): boolean {
  return ["message", "thinking", "tool", "activity", "custom"].includes(item.kind);
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  banner: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.xs,
    borderRadius: radius.md2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  center: { flex: 1, justifyContent: "center" },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.md,
  },
  footer: { gap: spacing.md, paddingTop: spacing.xs },
  skeleton: { flex: 1, padding: spacing.lg, gap: spacing.md, justifyContent: "flex-end" },
  skeletonUser: { alignItems: "flex-end" },
  dock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  limit: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
});
