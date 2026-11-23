import Constants from "expo-constants";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionSheetIOS, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { PegasusClient } from "../../api/client";
import { accountsByFullest } from "../../api/usage";
import type { AccountLimits } from "../../api/types";
import { usePegasus } from "../../state/PegasusProvider";
import { spacing, text, usePalette } from "../../theme";
import {
  Badge,
  Button,
  ListGroup,
  ListRow,
  SectionHeader,
  Skeleton,
  Surface,
  type Tone,
} from "../../ui";
import {
  compactCount,
  defaultModel,
  settingsWorkspaceId,
  thinkingLabel,
  thinkingLevelsFor,
  totalTokens,
  type ClaudeSlot,
  type RuntimeSnapshot,
  type StateWithRuntime,
  type ThinkingLevel,
  type UsageReport,
} from "./settings-api";
import { AccountCard } from "./UsageParts";

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Settings: the paired PC and its connection, the PC's default model and effort, plan usage, the
 * app version, and unpairing. Model changes go to the PC (setDefaultModel and
 * setDefaultThinkingLevel), which then streams the new state back.
 */
export default function SettingsScreen() {
  const palette = usePalette();
  const { pairing, status, state, forget } = usePegasus();
  const client = useMemo(() => (pairing ? new PegasusClient(pairing) : null), [pairing]);
  const workspaceId = settingsWorkspaceId(state);
  const [loadedRuntime, setLoadedRuntime] = useState<RuntimeSnapshot | undefined>(undefined);
  const runtime =
    (workspaceId
      ? (state as StateWithRuntime | null)?.runtimeByWorkspace?.[workspaceId]
      : undefined) ?? loadedRuntime;
  const [pcVersion, setPcVersion] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<readonly AccountLimits[] | null>(null);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [slots, setSlots] = useState<readonly ClaudeSlot[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!client) return;
    let live = true;
    client
      .invoke<string>("getAppVersion")
      .then((value) => live && setPcVersion(value))
      .catch(() => undefined);
    client
      .invoke<readonly AccountLimits[]>("getAccountLimits")
      .then((value) => live && setAccounts(accountsByFullest(value)))
      .catch((reason: unknown) => live && setUsageError(message(reason)));
    client
      .invoke<UsageReport>("getUsageReport")
      .then((value) => live && setReport(value))
      .catch(() => undefined);
    client
      .invoke<readonly ClaudeSlot[]>("getClaudeSlots")
      .then((value) => live && setSlots(value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);

  // The PC loads a workspace's runtime (models, defaults) on demand; ask once if it is not in state.
  const hasRuntime = Boolean(runtime);
  useEffect(() => {
    if (!client || !workspaceId || hasRuntime) return;
    let live = true;
    client
      .invoke<StateWithRuntime>("loadWorkspaceRuntime", workspaceId)
      .then((next) => live && setLoadedRuntime(next.runtimeByWorkspace?.[workspaceId]))
      .catch((reason: unknown) => live && setModelError(message(reason)));
    return () => {
      live = false;
    };
  }, [client, workspaceId, hasRuntime]);

  const apply = useCallback(
    async (method: "setDefaultModel" | "setDefaultThinkingLevel", ...args: readonly unknown[]) => {
      if (!client || !workspaceId) return;
      setSaving(true);
      setModelError(null);
      try {
        const next = await client.invoke<StateWithRuntime>(method, workspaceId, ...args);
        setLoadedRuntime(next.runtimeByWorkspace?.[workspaceId]);
      } catch (reason) {
        setModelError(message(reason));
      } finally {
        setSaving(false);
      }
    },
    [client, workspaceId],
  );

  const current = defaultModel(runtime);
  const levels = thinkingLevelsFor(current);
  const currentLevel = runtime?.settings.defaultThinkingLevel;

  const pickModel = () => {
    const models = (runtime?.models ?? []).filter((model) => model.available);
    if (models.length === 0) return;
    const labels = models.map((model) => `${model.label} · ${model.providerName}`);
    ActionSheetIOS.showActionSheetWithOptions(
      { title: "Default model", options: ["Cancel", ...labels], cancelButtonIndex: 0 },
      (index) => {
        const model = models[index - 1];
        if (model) void apply("setDefaultModel", model.providerId, model.modelId);
      },
    );
  };

  const pickLevel = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "Thinking level",
        options: ["Cancel", ...levels.map(thinkingLabel)],
        cancelButtonIndex: 0,
      },
      (index) => {
        const level: ThinkingLevel | undefined = levels[index - 1];
        if (level) void apply("setDefaultThinkingLevel", level);
      },
    );
  };

  const unpair = () =>
    Alert.alert(
      "Unpair this phone?",
      `It stops following ${pairing?.hostName ?? "your PC"}. To use it again, scan the pairing code on the PC.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Unpair", style: "destructive", onPress: () => void forget() },
      ],
    );

  const connection: { label: string; tone: Tone; detail?: string } =
    status.state === "live"
      ? { label: "Connected", tone: "success" }
      : status.state === "connecting"
        ? { label: "Connecting", tone: "neutral" }
        : status.state === "retrying"
          ? {
              label: `Retrying in ${Math.ceil(status.inMs / 1000)} s`,
              tone: "warning",
              detail: status.reason,
            }
          : { label: "Key revoked", tone: "danger", detail: status.reason };

  const signedInSlots = slots?.filter((slot) => slot.signedIn) ?? [];
  const appVersion = Constants.expoConfig?.version ?? "unknown";

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={styles.content}
    >
      <ListGroup title="Your PC" {...(connection.detail ? { footer: connection.detail } : {})}>
        <ListRow
          label={pairing?.hostName ?? "Not paired"}
          trailing={<Badge label={connection.label} tone={connection.tone} />}
        />
        <ListRow label="Address" detail={pairing?.url ?? "—"} />
        {pcVersion ? <ListRow label="Pegasus on the PC" detail={pcVersion} /> : null}
      </ListGroup>

      <ListGroup
        title="New chats"
        footer={modelError ?? "What the PC starts new chats with. The PC's Settings change too."}
      >
        <ListRow
          label="Default model"
          detail={runtime ? (current?.label ?? "Not set") : "Loading"}
          disabled={!runtime || saving}
          onPress={pickModel}
        />
        {levels.length > 0 ? (
          <ListRow
            label="Thinking level"
            detail={currentLevel ? thinkingLabel(currentLevel) : "Model default"}
            disabled={saving}
            onPress={pickLevel}
          />
        ) : null}
      </ListGroup>

      <View style={styles.block}>
        <SectionHeader title="Plan limits" />
        {usageError ? (
          <Text
            accessibilityRole="alert"
            style={[text.subheadline, styles.inset, { color: palette.dangerText }]}
          >
            {usageError}
          </Text>
        ) : accounts === null ? (
          <Surface>
            <View accessible accessibilityLabel="Loading plan limits" style={styles.skeleton}>
              <Skeleton width="40%" height={17} />
              <Skeleton height={6} />
            </View>
          </Surface>
        ) : accounts.length === 0 ? (
          <Text style={[text.subheadline, styles.inset, { color: palette.textMuted }]}>
            No signed-in account reports plan limits.
          </Text>
        ) : (
          accounts.map((account) => <AccountCard key={account.id} account={account} now={now} />)
        )}
      </View>

      {report ? (
        <ListGroup title="All chats on the PC">
          <ListRow label="Tokens" detail={compactCount(totalTokens(report.totals))} />
          <ListRow label="Chats" detail={String(report.sessions)} />
          {report.totals.apiCost !== undefined ? (
            <ListRow label="At API prices" detail={`$${report.totals.apiCost.toFixed(2)}`} />
          ) : null}
          {report.models[0] ? (
            <ListRow label="Most used model" detail={report.models[0].label} />
          ) : null}
        </ListGroup>
      ) : null}

      {signedInSlots.length > 0 ? (
        <ListGroup title="Claude sign-ins">
          {signedInSlots.map((slot) => (
            <ListRow
              key={slot.slot}
              label={slot.name ?? `Slot ${slot.slot}`}
              {...(slot.plan ? { trailing: <Badge label={slot.plan} /> } : {})}
            />
          ))}
        </ListGroup>
      ) : null}

      <ListGroup title="About">
        <ListRow label="Pegasus for iPhone" detail={appVersion} />
      </ListGroup>

      <Button
        label="Unpair this phone"
        variant="destructive"
        onPress={unpair}
        disabled={!pairing}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.xl, paddingBottom: spacing.xxl },
  block: { gap: spacing.sm },
  inset: { paddingHorizontal: spacing.lg },
  skeleton: { gap: spacing.sm },
});
