import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { sessionKey } from "../api/chats";
import { accountsByFullest, planStatus, resetsIn } from "../api/usage";
import type { AccountLimits } from "../api/types";
import { AccountCard, Meter } from "../features/settings/UsageParts";
import { usePegasus } from "../state/PegasusProvider";
import { spacing, text, usePalette } from "../theme";
import { SectionHeader, SheetHeader, Skeleton, Surface } from "../ui";
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
      <SheetHeader title="Usage" subtitle="Plan limits on the PC's accounts" />
      <View style={styles.block}>
        <SectionHeader title="This chat" />
        {plan ? (
          <Surface>
            <Text style={[text.headline, { color: palette.textStrong }]}>{plan.provider}</Text>
            <Meter
              label="Fullest window"
              percent={plan.usedPercent}
              reset={resetsIn(plan.resetsAt, now)}
            />
          </Surface>
        ) : (
          <Text style={[text.subheadline, styles.inset, { color: palette.textMuted }]}>
            This chat reports no plan limits yet.
          </Text>
        )}
        {usage ? (
          <Text style={[text.footnote, styles.inset, { color: palette.textMuted }]}>
            {usage.subscription
              ? "Billed through a subscription, so the cost below is not money spent."
              : "Billed per request."}
            {usage.totals ? ` $${usage.totals.cost.toFixed(2)} so far.` : ""}
          </Text>
        ) : null}
      </View>

      <View style={styles.block}>
        <SectionHeader title="Accounts" />
        {error ? (
          <Text
            accessibilityRole="alert"
            style={[text.subheadline, styles.inset, { color: palette.dangerText }]}
          >
            {error}
          </Text>
        ) : accounts === null ? (
          <Surface>
            <View accessible accessibilityLabel="Loading accounts" style={styles.skeleton}>
              <Skeleton width="40%" height={17} />
              <Skeleton height={6} />
              <Skeleton width="60%" />
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.xl },
  block: { gap: spacing.sm },
  inset: { paddingHorizontal: spacing.lg },
  skeleton: { gap: spacing.sm },
});
