import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { sessionKey } from "../api/chats";
import { accountsByFullest, planStatus, resetsIn } from "../api/usage";
import type { AccountLimits } from "../api/types";
import { AccountCard, Meter } from "../features/settings/UsageParts";
import { usePegasus } from "../state/PegasusProvider";
import { spacing, text, usePalette } from "../theme";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BarButton, SectionHeader, Skeleton, Surface, TopBar } from "../ui";
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
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
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
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <View style={[styles.grabber, { backgroundColor: palette.lineStrong }]} />
      <TopBar
        sheet
        subtitle="Plan limits on the PC's accounts"
        title="Usage"
        trailing={
          <BarButton
            accessibilityLabel="Close"
            icon="xmark"
            onPress={() => navigation.goBack()}
            tone="filled"
          />
        }
      />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        <View style={styles.block}>
          <SectionHeader title="This chat" />
          {plan ? (
            <Surface tone="float">
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
            <Surface tone="float">
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
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 3, marginTop: spacing.sm },
  content: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.xl },
  block: { gap: spacing.sm },
  inset: { paddingHorizontal: spacing.lg },
  skeleton: { gap: spacing.sm },
});
