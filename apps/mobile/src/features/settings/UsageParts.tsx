import { StyleSheet, Text, View } from "react-native";
import { LIMIT_WARNING_PERCENT, resetsIn } from "../../api/usage";
import type { AccountLimits } from "../../api/types";
import { radius, spacing, text, usePalette, weight } from "../../theme";
import { Surface } from "../../ui";

/** One plan window: label, percent and a bar; amber from the warning threshold on. */
export function Meter({
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
  const warn = used >= LIMIT_WARNING_PERCENT;
  // A template literal, not a plain string: React Native's width wants a percentage literal.
  const width = `${Math.round(used)}%` as `${number}%`;
  return (
    <View
      style={styles.meter}
      accessible
      accessibilityLabel={`${label}, ${Math.round(used)} percent used${reset ? `, ${reset}` : ""}`}
    >
      <View style={styles.meterHead}>
        <Text style={[text.subheadline, styles.shrink, { color: palette.text }]}>{label}</Text>
        <Text
          style={[
            text.subheadline,
            styles.value,
            { color: warn ? palette.warningText : palette.textStrong },
          ]}
        >
          {Math.round(used)}%
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: palette.overlayActive }]}>
        <View
          style={[styles.fill, { backgroundColor: warn ? palette.warning : palette.accent, width }]}
        />
      </View>
      {reset ? <Text style={[text.footnote, { color: palette.textMuted }]}>{reset}</Text> : null}
    </View>
  );
}

/** A card per signed-in account with its plan windows, fullest first (the caller sorts). */
export function AccountCard({ account, now }: { readonly account: AccountLimits; readonly now: number }) {
  const palette = usePalette();
  return (
    <Surface>
      <Text style={[text.headline, { color: palette.textStrong }]}>{account.name}</Text>
      {account.windows.length === 0 ? (
        <Text style={[text.footnote, { color: palette.textMuted }]}>
          {account.note ?? "This account reports no windows."}
        </Text>
      ) : (
        account.windows.map((window) => (
          <Meter
            key={`${account.id}:${window.label}`}
            label={window.label}
            percent={window.usedPercent}
            reset={resetsIn(
              window.resetsAt === undefined ? undefined : new Date(window.resetsAt).toISOString(),
              now,
            )}
          />
        ))
      )}
    </Surface>
  );
}

const styles = StyleSheet.create({
  meter: { gap: spacing.sm2 },
  meterHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.sm },
  shrink: { flexShrink: 1 },
  value: { fontWeight: weight.semibold, fontVariant: ["tabular-nums"] },
  track: { height: 6, borderRadius: radius.pill, overflow: "hidden" },
  fill: { height: 6, borderRadius: radius.pill },
});
