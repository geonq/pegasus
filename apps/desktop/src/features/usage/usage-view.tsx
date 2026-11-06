import { useCallback, useEffect, useMemo, useState } from "react";
import { Area } from "@/components/charts/area";
import { AreaChart } from "@/components/charts/area-chart";
import { Bar } from "@/components/charts/bar";
import { BarChart } from "@/components/charts/bar-chart";
import { BarYAxis } from "@/components/charts/bar-y-axis";
import { Grid } from "@/components/charts/grid";
import { Ring } from "@/components/charts/ring";
import { RingCenter } from "@/components/charts/ring-center";
import { RingChart } from "@/components/charts/ring-chart";
import { ChartTooltip } from "@/components/charts/tooltip/chart-tooltip";
import { XAxis } from "@/components/charts/x-axis";
import type { WorkspaceRecord } from "../../../contracts/desktop-state";
import { totalTokens, type UsageBreakdown, type UsageReport } from "../../../contracts/usage";
import {
  AccountLimitsCard,
  ProviderStatusBadge,
  SignInNotice,
  useAccountLimits,
  useProviderStatuses,
  useSignIns,
} from "./account-state";
import {
  addWeight,
  BRAND_LABEL,
  brandOf,
  mixBrands,
  OTHER_LABEL,
  providerColor,
  providerColors,
  seriesColor,
  type BrandWeights,
} from "./brand-color";
import { TokenHeatmap } from "./token-heatmap";
import { ModelAnalytics } from "./model-analytics";
import { ProviderIcon, RefreshIcon } from "../../ui/icons";

const DAY = 86_400_000;
const ALL = "all";
const PERIODS = [
  { id: "7", label: "7 days", days: 7 },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "all", label: "All time", days: 0 },
] as const;
type PeriodId = (typeof PERIODS)[number]["id"];

// The app is English, so numbers read "17.5B" on every system locale.
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const providerOf = (modelKey: string) => modelKey.split("/")[0] ?? "";
/** The provider logo carries the brand, so "claude-haiku-5-5" reads "haiku-5-5". */
const shortName = (modelKey: string) =>
  (modelKey.split("/").slice(1).join("/") || modelKey).replace(/^(claude|gpt)-/i, "");

/** A provider id is one signed-in account; name it the way people know it. */
function defaultAccountName(provider: string): string {
  const slot = /^claude-code-account-(\d)$/.exec(provider)?.[1];
  if (slot) return `Claude account ${slot}`;
  const known: Record<string, string> = {
    anthropic: "Anthropic API",
    openai: "OpenAI",
    "openai-codex": "ChatGPT",
    antigravity: "Antigravity",
    "history-codex": "Codex history",
    "history-claude": "Claude history",
    "history-agy": "AGY history",
    pi: "Compaction & cache",
    openscale: "OpenScale",
  };
  return known[provider] ?? provider;
}

/** Short names, with the provider added where two models would otherwise read the same. */
function modelNames(
  keys: readonly string[],
  accountName: (provider: string) => string,
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(shortName(key), (counts.get(shortName(key)) ?? 0) + 1);
  return new Map(
    keys.map((key) => [
      key,
      (counts.get(shortName(key)) ?? 0) > 1
        ? `${shortName(key)} · ${accountName(providerOf(key))}`
        : shortName(key),
    ]),
  );
}

function todayStart(): number {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Session folders and app workspaces can differ in slash direction and case on Windows. */
const samePath = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();

const sumValues = (values: Iterable<number>) => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

function breakdownTokens(row: UsageBreakdown): number {
  return row.byProvider ? sumValues(Object.values(row.byProvider)) : totalTokens(row.tokens);
}

function rankBreakdowns(
  rows: readonly UsageBreakdown[],
  limit: number,
): readonly { readonly row: UsageBreakdown; readonly amount: number }[] {
  return rows
    .map((row) => ({ row, amount: breakdownTokens(row) }))
    .filter((entry) => entry.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

let lastUsageReport: UsageReport | null = null;

/** Token usage per account and model across every saved session, drawn with Bklit UI charts. */
export function UsageView({ workspaces }: { readonly workspaces: readonly WorkspaceRecord[] }) {
  // The last report shows at once while the new one is read (every saved thread, over the network
  // for the Mac), so going back to Usage no longer starts from an empty page.
  const [report, setReport] = useState<UsageReport | null>(() => lastUsageReport);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // Opens on the full history; shorter periods are one click away.
  const [period, setPeriod] = useState<PeriodId>("all");
  const [account, setAccount] = useState<string>(ALL);
  const [analytics, setAnalytics] = useState(false);
  const {
    error: limitsError,
    limits,
    loading: limitsLoading,
    reload: reloadLimits,
  } = useAccountLimits();
  const statuses = useProviderStatuses(limits);
  const signIns = useSignIns();
  // Names the owner gave the accounts ("Claude · work"), where the provider reports one.
  const accountName = useCallback(
    (provider: string) =>
      limits.find((entry) => entry.id === provider)?.name ?? defaultAccountName(provider),
    [limits],
  );

  const planLimitsCard = (
    <AccountLimitsCard
      error={limitsError}
      limits={
        account === ALL
          ? limits
          : limits.filter(
              (entry) =>
                entry.id === account || (entry.id === "openai" && account === "openai-codex"),
            )
      }
      loading={limitsLoading}
    />
  );

  const load = useCallback(() => {
    setLoading(true);
    window.piApp
      ?.getUsageReport()
      .then((next) => {
        lastUsageReport = next;
        setReport(next);
        setError("");
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const view = useMemo(() => {
    if (!report) return null;
    const days = PERIODS.find((entry) => entry.id === period)?.days ?? 0;
    const start = days ? todayStart() - (days - 1) * DAY : -Infinity;
    const inPeriod = report.days.filter((day) => day.dayStart >= start);
    const inAccount = (modelKey: string) => account === ALL || providerOf(modelKey) === account;
    const dayTotal = (byModel: Readonly<Record<string, number>> | undefined) =>
      sumValues(
        Object.entries(byModel ?? {})
          .filter(([key]) => inAccount(key))
          .map(([, value]) => value),
      );
    const byDay = new Map(inPeriod.map((day) => [day.dayStart, day.byModel]));
    // Bounded periods show every day, so quiet days read as zero instead of vanishing.
    const series = days
      ? Array.from({ length: days }, (_, index) => start + index * DAY).map((dayStart) => ({
          date: new Date(dayStart),
          tokens: dayTotal(byDay.get(dayStart)),
        }))
      : inPeriod.map((day) => ({ date: new Date(day.dayStart), tokens: dayTotal(day.byModel) }));

    const modelTotals = new Map<string, number>();
    for (const day of inPeriod) {
      for (const [key, value] of Object.entries(day.byModel))
        modelTotals.set(key, (modelTotals.get(key) ?? 0) + value);
    }
    // Brand colors by usage: every chart leans toward the provider that was used most.
    const brandsByDay = new Map<number, BrandWeights>();
    for (const day of report.days) {
      const weights: BrandWeights = {};
      for (const [key, value] of Object.entries(day.byModel))
        if (inAccount(key)) addWeight(weights, providerOf(key), value);
      brandsByDay.set(day.dayStart, weights);
    }
    const periodWeights: BrandWeights = {};
    for (const [key, value] of modelTotals)
      if (inAccount(key)) addWeight(periodWeights, providerOf(key), value);
    const tint = mixBrands(periodWeights);
    const accountTotals = new Map<string, number>();
    for (const [key, value] of modelTotals)
      accountTotals.set(providerOf(key), (accountTotals.get(providerOf(key)) ?? 0) + value);
    const accounts = [...accountTotals].sort(([, a], [, b]) => b - a);
    const ranked = [...modelTotals].filter(([key]) => inAccount(key)).sort(([, a], [, b]) => b - a);
    const total = sumValues(ranked.map(([, value]) => value));
    const names = modelNames([...modelTotals.keys()], accountName);
    // The ring compares accounts across everything, or models inside one account.
    const share = (account === ALL ? accounts : ranked).slice(0, 4).map(([key, value]) => ({
      key,
      value,
      provider: account === ALL ? key : providerOf(key),
      label: account === ALL ? accountName(key) : (names.get(key) ?? shortName(key)),
    }));
    const allTime = report.models.filter((model) => inAccount(model.key));
    // What these tokens would have cost at public API prices, priced per request.
    const apiCost = sumValues(allTime.map((model) => model.tokens.apiCost ?? 0));
    const unpriced = sumValues(allTime.map((model) => model.tokens.unpricedTokens ?? 0));
    const amountOf = (row: UsageBreakdown) =>
      account === ALL ? breakdownTokens(row) : (row.byProvider?.[account] ?? 0);
    // Projects read as the user named them in the app, not by folder name.
    const projectNames = new Map(
      workspaces.map((workspace) => [samePath(workspace.path), workspace.name]),
    );
    const renamed = (row: UsageBreakdown) => ({
      ...row,
      label: projectNames.get(samePath(row.key)) ?? row.label,
    });
    const tokensByDay = new Map(report.days.map((day) => [day.dayStart, dayTotal(day.byModel)]));
    const ranks = (rows: readonly UsageBreakdown[], limit: number) =>
      rows
        .map((row) => ({ row, amount: amountOf(row) }))
        .filter((entry) => entry.amount > 0)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, limit);
    const shareColors = providerColors(share.map((entry) => entry.provider));
    const labelOf = (key: string) => {
      const brand = brandOf(providerOf(key));
      return brand ? BRAND_LABEL[brand] : OTHER_LABEL;
    };
    const topModels = ranked.slice(0, 6);
    const modelBars = {
      rows: topModels.map(([key, tokens]) => ({
        model: names.get(key) ?? shortName(key),
        [labelOf(key)]: tokens,
      })),
      series: [...new Set(topModels.map(([key]) => labelOf(key)))],
    };
    return {
      modelBars,
      series,
      brandsByDay,
      tint,
      shareColors,
      accounts,
      ranked,
      total,
      share,
      name: (key: string) => names.get(key) ?? shortName(key),
      allTimeTokens: sumValues(allTime.map((model) => totalTokens(model.tokens))),
      requests: sumValues(allTime.map((model) => model.replies)),
      apiCost,
      unpriced,
      workspaces: ranks(report.workspaces.map(renamed), 6),
      tokensByDay,
      threads: ranks(report.threads, 8),
    };
  }, [report, period, account, workspaces, accountName]);

  const history = report?.history;
  const potentialOverlap = history?.potentialOverlap;

  return (
    <section className="canvas usage-view" data-testid="usage-view">
      <header className="view-header">
        <div>
          <h1 className="view-header__title">Usage</h1>
          <p className="view-header__body">
            Tokens per account and model across saved Pi sessions and imported CLI history where
            available.
          </p>
        </div>
        <div className="view-header__actions">
          <label className="usage-view__period">
            <span className="sr-only">Period</span>
            <select
              value={period}
              onChange={(event) => setPeriod(event.currentTarget.value as PeriodId)}
            >
              {PERIODS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <button
            aria-label="Refresh usage"
            className="icon-button"
            disabled={loading}
            onClick={() => {
              load();
              reloadLimits();
            }}
            type="button"
          >
            <RefreshIcon />
          </button>
        </div>
      </header>

      {error ? (
        <p className="usage-view__note" role="alert">
          Usage could not be read: {error}
        </p>
      ) : null}
      {history?.status === "missing" ? (
        <p className="usage-view__note" data-testid="usage-history-status">
          Historical CLI usage has not been imported. Showing saved Pi-session usage only.
        </p>
      ) : null}
      {history?.status === "unavailable" ? (
        <p className="usage-view__note" role="status" data-testid="usage-history-status">
          Historical CLI usage could not be read or failed validation. Showing saved Pi-session
          usage only.
        </p>
      ) : null}
      {history?.status === "available" ? (
        <p className="usage-view__note" data-testid="usage-history-status">
          {history.complete === false
            ? history.safeEventCount
              ? "Imported Codex and Claude history. Importing remaining files…"
              : "Importing Codex and Claude history…"
            : "Imported Codex and Claude history."}
        </p>
      ) : null}
      {history?.status === "available" && history.tokenCoveragePartial ? (
        <p className="usage-view__note" role="status" data-testid="usage-history-token-coverage">
          Token coverage is partial.{" "}
          {history.normalizationNote ??
            "Some Codex history is excluded from token totals because its source is ambiguous."}
        </p>
      ) : null}
      {!report || !view ? (
        <>
          <p className="usage-view__note" aria-live="polite">
            {loading ? "Reading saved threads…" : "No usage yet."}
          </p>
          {planLimitsCard}
        </>
      ) : (
        <>
          <div aria-label="Account" className="usage-accounts" role="group">
            {[ALL, ...view.accounts.map(([provider]) => provider)].map((provider) => (
              <button
                aria-pressed={account === provider}
                className="usage-account"
                key={provider}
                style={
                  provider === ALL
                    ? undefined
                    : ({ "--brand": providerColor(provider) } as React.CSSProperties)
                }
                onClick={() => setAccount(provider)}
                type="button"
              >
                {provider === ALL ? null : <ProviderIcon providerId={provider} />}
                <span>{provider === ALL ? "All accounts" : accountName(provider)}</span>
                <ProviderStatusBadge status={statuses.get(provider)} />
                <span className="usage-account__value">
                  {compact.format(
                    provider === ALL
                      ? sumValues(view.accounts.map(([, value]) => value))
                      : (view.accounts.find(([key]) => key === provider)?.[1] ?? 0),
                  )}
                </span>
              </button>
            ))}
          </div>

          <SignInNotice signIns={signIns} />

          <div role="group" aria-label="Usage view" className="usage-accounts">
            <button
              type="button"
              className="usage-account"
              aria-pressed={!analytics}
              onClick={() => setAnalytics(false)}
            >
              Overview
            </button>
            <button
              type="button"
              className="usage-account"
              aria-pressed={analytics}
              onClick={() => setAnalytics(true)}
            >
              Model analytics
            </button>
          </div>
          {analytics ? (
            <ModelAnalytics
              report={report}
              account={account}
              since={period === "all" ? -Infinity : todayStart() - (Number(period) - 1) * DAY}
            />
          ) : null}
          <div className="usage-overview" hidden={analytics}>
            {planLimitsCard}
            <section className="usage-view__stats" aria-label="Totals">
              <Stat
                label={
                  period === "all"
                    ? "Tokens, all time"
                    : `Tokens, ${PERIODS.find((entry) => entry.id === period)?.label ?? period}`
                }
                value={compact.format(view.total)}
              />
              {period === "all" ? null : (
                <Stat label="Tokens, all time" value={compact.format(view.allTimeTokens)} />
              )}
              {view.apiCost > 0 ? (
                <Stat
                  label="API value, all time"
                  title={`What these tokens would cost at public API prices.${view.unpriced ? ` ${compact.format(view.unpriced)} tokens of models without a public price are not included.` : ""}`}
                  value={usd.format(Math.round(view.apiCost))}
                />
              ) : null}
              <Stat label="Requests, all time" value={compact.format(view.requests)} />
            </section>

            <TokenHeatmap brandsByDay={view.brandsByDay} tokensByDay={view.tokensByDay} />

            <section className="usage-card">
              <h3>Tokens per day</h3>
              <AreaChart data={view.series} aspectRatio="3 / 1">
                <Grid horizontal />
                <Area
                  dataKey="tokens"
                  fill={view.tint}
                  fillOpacity={0.35}
                  stroke={view.tint}
                  strokeWidth={2}
                />
                <XAxis />
                <ChartTooltip />
              </AreaChart>
            </section>

            {view.ranked.length ? (
              <div className="usage-view__split">
                <section className="usage-card">
                  <h3>By model</h3>
                  <BarChart
                    // One series per brand, stacked: each model keeps its own provider's color.
                    data={view.modelBars.rows}
                    stacked
                    xDataKey="model"
                    aspectRatio="4 / 3"
                    // Horizontal bars keep long model names readable on the left.
                    margin={{ left: 120, right: 16 }}
                    orientation="horizontal"
                  >
                    <Grid vertical />
                    {view.modelBars.series.map((label) => (
                      <Bar dataKey={label} fill={seriesColor(label)} key={label} lineCap="round" />
                    ))}
                    <BarYAxis />
                    <ChartTooltip />
                  </BarChart>
                </section>
                <section className="usage-card usage-card--ring">
                  <h3>{account === ALL ? "Share by account" : "Share by model"}</h3>
                  <RingChart
                    data={view.share.map((entry) => ({
                      label: entry.label,
                      value: entry.value,
                      maxValue: Math.max(1, sumValues(view.share.map((item) => item.value))),
                    }))}
                    size={180}
                  >
                    {view.share.map((entry, index) => (
                      <Ring color={view.shareColors[index]} index={index} key={entry.key} />
                    ))}
                    {/* Compact, so billions fit inside the innermost ring. */}
                    <RingCenter
                      defaultLabel="tokens"
                      formatOptions={{ notation: "compact", maximumFractionDigits: 1 }}
                    />
                  </RingChart>
                  <ul className="usage-list">
                    {view.share.map((entry, index) => (
                      <li key={entry.key}>
                        <span
                          className="usage-list__swatch"
                          style={{ background: view.shareColors[index] }}
                        />
                        <ProviderIcon providerId={entry.provider} />
                        <span className="usage-list__label">{entry.label}</span>
                        <span className="usage-list__value">{compact.format(entry.value)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            ) : (
              <p className="usage-view__note">No usage for this account in this period.</p>
            )}

            <div className="usage-view__split">
              <Breakdown title="Workspaces, all time" rows={view.workspaces} />
              <Breakdown title="Threads, all time" rows={view.threads} />
            </div>
            {potentialOverlap ? (
              <section className="usage-card" data-testid="usage-potential-overlap">
                <h3>{potentialOverlap.label}</h3>
                <p className="usage-view__note">
                  {compact.format(totalTokens(potentialOverlap.totals))} recorded tokens across{" "}
                  {compact.format(potentialOverlap.sessions)} sessions. Kept separate from combined
                  totals because these events may overlap native Pi usage. Some cache metrics were
                  not recorded; cost is unavailable.
                </p>
                {/* Lists sit inside this card, so they drop their own card chrome; empty ones are left out. */}
                <div className="usage-view__split usage-view__split--bare">
                  {potentialOverlap.models.some((model) => model.label !== "unknown") ? (
                    <Breakdown
                      bare
                      title="Models"
                      rows={rankBreakdowns(potentialOverlap.models, 6)}
                    />
                  ) : null}
                  {potentialOverlap.workspaces.length ? (
                    <Breakdown
                      bare
                      title="Historical workspaces"
                      rows={rankBreakdowns(potentialOverlap.workspaces, 6)}
                    />
                  ) : null}
                  <Breakdown
                    bare
                    title="Largest sessions"
                    rows={rankBreakdowns(potentialOverlap.threads, 8)}
                  />
                </div>
              </section>
            ) : null}
            {report.unreadable ? (
              <p className="usage-view__note">
                {report.unreadable} thread files could not be read.
              </p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  title,
}: {
  readonly label: string;
  readonly value: string;
  readonly title?: string;
}) {
  return (
    <div className="usage-stat" title={title}>
      <span className="usage-stat__value">{value}</span>
      <span className="usage-stat__label">{label}</span>
    </div>
  );
}

/**
 * Imported CLI sessions carry no title (prompts stay private), only a generic source label,
 * so they read by model and size instead of eight identical "… CLI history" rows.
 */
function breakdownLabel(row: UsageBreakdown): string {
  if (!row.provider?.startsWith("history-")) {
    // Some imported folder names arrive URL-encoded ("LifeOS%20Design").
    try {
      return decodeURIComponent(row.label);
    } catch {
      return row.label;
    }
  }
  const model = !row.detail || /unknown/i.test(row.detail) ? "Unknown model" : row.detail;
  return `${model} · ${compact.format(row.replies)} replies`;
}

function Breakdown({
  title,
  rows,
  bare = false,
}: {
  readonly title: string;
  readonly rows: readonly { readonly row: UsageBreakdown; readonly amount: number }[];
  readonly bare?: boolean;
}) {
  const max = Math.max(1, ...rows.map((entry) => entry.amount));
  return (
    <section className={bare ? "usage-breakdown" : "usage-card"}>
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="usage-card__empty">Nothing recorded yet.</p> : null}
      <ul className="usage-list">
        {rows.map(({ row, amount }) => (
          <li key={row.key} title={row.label}>
            <span className="usage-list__label">{breakdownLabel(row)}</span>
            <span className="usage-list__value">{compact.format(amount)}</span>
            <span className="usage-list__bar" style={{ width: `${(amount / max) * 100}%` }} />
          </li>
        ))}
      </ul>
    </section>
  );
}
