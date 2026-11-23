import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pendingDialogsOf, sessionKey } from "../api/chats";
import type { PendingDialogAnswer, TranscriptItem } from "../api/types";
import { LIMIT_WARNING_PERCENT, planStatus, resetsIn } from "../api/usage";
import { groupTranscript } from "../api/worklog";
import { ApprovalCard } from "../components/ApprovalCard";
import { messageOf, useChatActions } from "../features/chat/actions";
import { ChatMenuButton, ChatTitle, type ChatMenuItem } from "../features/chat/ChatHeader";
import { Composer } from "../features/chat/Composer";
import { FloatingStatus } from "../features/chat/FloatingStatus";
import { SubagentRows } from "../features/chat/SubagentRows";
import { selectionHaptic, TranscriptRow } from "../features/chat/TranscriptRow";
import { hasRuntime, modelsOf, permissionOf, sessionConfigOf } from "../features/chat/wire";
import type { RootStackParamList } from "../navigation";
import { usePegasus } from "../state/PegasusProvider";
import { Button, EmptyState, PressableScale, Skeleton } from "../ui";
import { maxFontScale, radius, spacing, text, usePalette } from "../theme";

/** Past this many points from the end, the person is reading back: stop following, offer a jump. */
const FOLLOW_THRESHOLD = 120;

/**
 * One chat: its work log as it streams in, approvals and questions inline at its end, and the
 * composer that sends, queues or steers. Everything is drawn from the PC's state; the screen only
 * owns what was typed, which rows are expanded, and whether the person scrolled up.
 */
export function ChatScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, "Chat">) {
  const { workspaceId, sessionId, title: routeTitle } = route.params;
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { state, transcript, status, openChat, stop, answer, removeQueued, steerQueued } =
    usePegasus();
  const actions = useChatActions(workspaceId, sessionId);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const list = useRef<LegendListRef>(null);

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

  const items = useMemo(
    () =>
      transcript?.workspaceId === workspaceId && transcript.sessionId === sessionId
        ? transcript.transcript.filter(isShown)
        : null,
    [transcript, workspaceId, sessionId],
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
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
    setAwayFromEnd(distance > FOLLOW_THRESHOLD);
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

  const openReview = useCallback(() => {
    // The Review screen is registered by the review feature; older builds without it say so.
    if (!navigation.getState().routeNames.includes("Review" as keyof RootStackParamList)) {
      Alert.alert("Review is not available", "This build of the app has no review screen yet.");
      return;
    }
    (navigation.navigate as (name: string, params: object) => void)("Review", {
      workspaceId,
      sessionId,
    });
  }, [navigation, sessionId, workspaceId]);

  const title = session?.title || routeTitle || "Chat";
  const model = models.find(
    (entry) => entry.providerId === config.provider && entry.modelId === config.modelId,
  );
  const subtitle = [workspace?.name, model?.label ?? config.modelId].filter(Boolean).join(" · ");
  const headerStatus = !live
    ? "offline"
    : asked
      ? "waiting"
      : running
        ? "working"
        : session?.status === "failed"
          ? "failed"
          : "idle";

  const menu = useMemo<ChatMenuItem[]>(() => {
    const fail = (label: string) => (reason: unknown) => Alert.alert(label, messageOf(reason));
    const items: ChatMenuItem[] = [
      { label: "Review changes", onPress: openReview },
      { label: "Usage", onPress: () => navigation.navigate("Usage", { workspaceId, sessionId }) },
    ];
    if (session) {
      items.push({
        label: session.pinnedAt ? "Unpin" : "Pin",
        onPress: () => actions.setPinned(!session.pinnedAt).catch(fail("Could not change the pin")),
      });
      items.push(
        session.archivedAt
          ? {
              label: "Unarchive",
              onPress: () => actions.unarchive().catch(fail("Could not unarchive the chat")),
            }
          : {
              label: "Archive",
              destructive: true,
              onPress: () =>
                Alert.alert(
                  "Archive this chat?",
                  "It leaves the list. You can find it on the PC.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Archive",
                      style: "destructive",
                      onPress: () =>
                        actions
                          .archive()
                          .then(() => navigation.goBack())
                          .catch(fail("Could not archive the chat")),
                    },
                  ],
                ),
            },
      );
    }
    return items;
  }, [actions, navigation, openReview, session, sessionId, workspaceId]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => <ChatTitle status={headerStatus} subtitle={subtitle} title={title} />,
      headerRight: () => <ChatMenuButton items={menu} />,
    });
  }, [headerStatus, menu, navigation, subtitle, title]);

  const banner =
    status.state === "retrying"
      ? `${status.reason} Retrying in ${Math.round(status.inMs / 1000)} s. Showing the last update.`
      : status.state === "revoked"
        ? status.reason
        : status.state === "connecting" && state
          ? "Reconnecting…"
          : null;

  const limitReset = plan ? resetsIn(plan.resetsAt, Date.now()) : null;
  const sessionGone = Boolean(state) && !session;
  const since = running && session?.runningSince ? Date.parse(session.runningSince) : NaN;

  let body: ReactNode;
  if (sessionGone) {
    body = (
      <View style={styles.center}>
        <EmptyState
          action={
            <Button label="Back to chats" onPress={() => navigation.goBack()} variant="secondary" />
          }
          message="It was deleted, or this phone may no longer see its project."
          title="This chat is not on the PC"
        />
      </View>
    );
  } else if (items === null && openError) {
    body = (
      <View style={styles.center}>
        <EmptyState
          action={
            <Button
              label="Try again"
              onPress={() => setOpening((value) => value + 1)}
              variant="primary"
            />
          }
          message={openError}
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
      <LegendList
        ListEmptyComponent={
          asked ? null : (
            <View style={styles.center}>
              <EmptyState
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
        data={rows}
        estimatedItemSize={88}
        extraData={expanded}
        getItemType={(row) => row.kind}
        initialScrollIndex={Math.max(0, rows.length - 1)}
        keyExtractor={(row) => row.id}
        keyboardDismissMode="interactive"
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
        scrollEventThrottle={64}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={headerHeight}
      style={[styles.screen, { backgroundColor: palette.background }]}
    >
      {banner ? (
        <View
          accessibilityLiveRegion="polite"
          style={[styles.banner, { backgroundColor: palette.warningTint }]}
        >
          <Text style={[text.footnote, styles.flex, { color: palette.warningText }]}>{banner}</Text>
        </View>
      ) : null}

      <View style={styles.flex}>{body}</View>

      {!sessionGone ? (
        <>
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
            live={live}
            models={models}
            modelsLoaded={modelsLoaded}
            onRemoveQueued={removeQueued}
            onSent={jumpToLatest}
            onSteerQueued={steerQueued}
            onStop={() => stop({ workspaceId, sessionId })}
            permission={permission}
            queued={items === null ? [] : queued}
            running={running}
          />
        </>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function isShown(item: TranscriptItem): boolean {
  return ["message", "thinking", "tool", "activity", "custom"].includes(item.kind);
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  banner: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, flexDirection: "row" },
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
  limit: {
    alignSelf: "center",
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
});
