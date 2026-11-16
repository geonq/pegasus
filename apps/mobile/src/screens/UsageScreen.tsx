import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { sessionKey } from "../api/chats";
import { accountsByFullest, LIMIT_WARNING_PERCENT, planStatus, resetsIn } from "../api/usage";
import type { AccountLimits } from "../api/types";
import { usePegasus } from "../state/PegasusProvider";
import { radius, spacing, type, usePalette } from "../theme";
import type { RootStackParamList } from "../navigation";

/**
 * The PC's plan windows for the signed-in accounts, and what this chat has used. The numbers come
 * from the PC (`getAccountLimits`) and from the state it already streams; the phone adds no maths
 * of its own beyond picking the fullest window to show first.
 */
export function UsageScreen({ route }: NativeStackScreenProps<RootStackParamList, "Usage">) {
  const palette = usePalette();
  const { accountLimits, state } = usePegasus();
  const [accounts, setAccounts] = useState<readonly AccountLimits[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const usage =
    state?.sessionUsageBySession?.[sessionKey(route.params.workspaceId, route.params.sessionId)];
  const plan = planStatus(usage);

  useEffect(() => {
    let cancelled = false;
    accountLimits()
      .then((next) => {
        if (!cancelled) setAccounts(accountsByFullest(next));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [accountLimits]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.section, { color: palette.textMuted }]}>This chat</Text>
      {plan ? (
        <View
          style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.line }]}
        >
          <Text style={[styles.cardTitle, { color: palette.text }]}>{plan.provider}</Text>
          <Meter
            label="Fullest window"
            percent={plan.usedPercent}
            reset={resetsIn(plan.resetsAt, now)}
          />
        </View>
      ) : (
        <Text style={[styles.empty, { color: palette.textMuted }]}>
          This chat reports no plan limits yet.
        </Text>
      )}
      {usage ? (
        <Text style={[styles.note, { color: palette.textMuted }]}>
          {usage.subscription
            ? "Billed through a subscription, so the cost below is not money spent."
            : "Billed per request."}
          {usage.totals ? ` $${usage.totals.cost.toFixed(2)} so far.` : ""}
        </Text>
      ) : null}

      <Text style={[styles.section, { color: palette.textMuted }]}>Accounts</Text>
      {error ? (
        <Text accessibilityRole="alert" style={[styles.empty, { color: palette.danger }]}>
          {error}
        </Text>
      ) : accounts === null ? (
        <ActivityIndicator color={palette.accent} style={styles.spinner} />
      ) : accounts.length === 0 ? (
        <Text style={[styles.empty, { color: palette.textMuted }]}>
          No signed-in account reports plan limits.
        </Text>
      ) : (
        accounts.map((account) => (
          <View
            key={account.id}
            style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.line }]}
          >
            <Text style={[styles.cardTitle, { color: palette.text }]}>{account.name}</Text>
            {account.windows.length === 0 ? (
              <Text style={[styles.note, { color: palette.textMuted }]}>
                {account.note ?? "This account reports no windows."}
              </Text>
            ) : (
              account.windows.map((window) => (
                <Meter
                  key={`${account.id}:${window.label}`}
                  label={window.label}
                  percent={window.usedPercent}
                  reset={resetsIn(
                    window.resetsAt === undefined
                      ? undefined
                      : new Date(window.resetsAt).toISOString(),
                    now,
                  )}
                />
              ))
            )}
          </View>
        ))
      )}
    </ScrollView>
  );
}

function Meter({
  label,
  percent,
  reset,
}: {
  readonly label: string;
  readonly percent: number;
  readonly reset: string | null;
}) {
  const palette = usePalette();
  const used = Math.min(100, Math.max(0, percent));
  const color = used >= LIMIT_WARNING_PERCENT ? palette.warning : palette.accent;
  // A template literal, not a plain string: React Native's width wants a percentage literal.
  const width = `${Math.round(used)}%` as `${number}%`;
  return (
    <View style={styles.meter}>
      <View style={styles.meterHead}>
        <Text style={[styles.meterLabel, { color: palette.text }]}>{label}</Text>
        <Text style={[styles.meterValue, { color }]}>{Math.round(used)}%</Text>
      </View>
      <View style={[styles.track, { backgroundColor: palette.line }]}>
        <View style={[styles.fill, { backgroundColor: color, width }]} />
      </View>
      {reset ? <Text style={[styles.note, { color: palette.textMuted }]}>{reset}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm },
  section: {
    fontSize: type.caption,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: spacing.md,
  },
  card: {
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardTitle: { fontSize: type.body, fontWeight: "600" },
  meter: { gap: spacing.xs },
  meterHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  meterLabel: { fontSize: 14 },
  meterValue: { fontSize: 14, fontWeight: "600" },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6 },
  note: { fontSize: type.caption, lineHeight: 17 },
  empty: { fontSize: 14, lineHeight: 20 },
  spinner: { alignSelf: "flex-start" },
});
