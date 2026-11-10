import { isRunningLow, orderByTightestLimit } from "./limit-order";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  AccountLimits,
  AccountStatus,
  ProviderState,
  SignInStatus,
} from "../../../contracts/usage";
import { ProviderIcon } from "../../ui/icons";
import { OPENSCALE_GRADIENT, brandOf, providerColor } from "./brand-color";

const LABELS: Record<ProviderState, string> = {
  ready: "Ready",
  limited: "Limited",
  relogin: "Sign in again",
  expiring: "Sign in soon",
  unknown: "Not checked",
};
const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" });
const limitsAsOf = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const weekdayTime = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const atLabel = (at: number) =>
  at - Date.now() < 86_400_000 ? time.format(at) : weekdayTime.format(at);

export interface ProviderStatus {
  readonly state: ProviderState;
  /** Limited: when the binding window resets. Expiring: when the sign-in ends. */
  readonly until?: number;
}

/**
 * One status per provider, by the same rules for Claude, ChatGPT and Antigravity: a lost sign-in wins,
 * then a sign-in about to end, then a used-up plan window, else ready once anything confirmed it.
 * `accounts` is the Claude ledger (it also knows cooldowns from real 429s); `codex` (the CLI) is not a provider.
 */
export function providerStatuses(
  accounts: ReadonlyMap<string, AccountStatus>,
  signIns: readonly SignInStatus[],
  limits: readonly AccountLimits[],
  now = Date.now(),
): ReadonlyMap<string, ProviderStatus> {
  const ids = new Set([
    ...[...accounts.values()]
      .filter((account) => account.state !== "disabled")
      .map((account) => account.id),
    ...signIns.filter((signIn) => signIn.id !== "codex").map((signIn) => signIn.id),
    ...limits.map((entry) => entry.id),
  ]);
  const result = new Map<string, ProviderStatus>();
  for (const id of ids) {
    const account = accounts.get(id);
    if (account?.state === "disabled") continue;
    const signIn = signIns.find((entry) => entry.id === id);
    // The latest reset among used-up windows: a spent weekly window outlasts a fresh 5-hour one.
    const accountWindows = limits.find((entry) => entry.id === id)?.windows ?? [];
    let spent = accountWindows.filter((window) => window.usedPercent >= 100);
    if (id === "antigravity") {
      const pools = [...new Set(accountWindows.map((window) => window.label.split(" · ")[0]))];
      if (
        !pools.length ||
        !pools.every((pool) => spent.some((window) => window.label.startsWith(`${pool} · `)))
      )
        spent = [];
    }
    const windowReset = spent.length
      ? Math.max(...spent.map((window) => window.resetsAt ?? 0))
      : undefined;
    const cooldown =
      account?.state === "limited" && (account.resetAt ?? 0) > now ? account.resetAt : undefined;
    if (signIn?.state === "signed-out" || account?.state === "relogin")
      result.set(id, { state: "relogin" });
    else if (signIn?.state === "expiring")
      result.set(id, { state: "expiring", until: signIn.expiresAt });
    else if (spent.length || cooldown)
      result.set(id, {
        state: "limited",
        until: Math.max(windowReset ?? 0, cooldown ?? 0) || undefined,
      });
    else if (signIn?.state === "unknown") result.set(id, { state: "unknown" });
    else if (
      signIn?.state === "ok" ||
      account?.state === "ready" ||
      account?.state === "busy" ||
      limits.some((entry) => entry.id === id && entry.windows.length)
    )
      result.set(id, { state: "ready" });
    else result.set(id, { state: "unknown" });
  }
  return result;
}

const snapshot = (value: unknown) => JSON.stringify(value instanceof Map ? [...value] : value);

interface PolledStore<T> {
  value: T;
  readAt: number;
  inFlight: boolean;
  timer: number | undefined;
  readonly listeners: Set<() => void>;
}

/**
 * One poller per reader for the whole window, however many components show its answer: each used to
 * poll on its own, and for the Mac every read is a round trip to Windows. The last answer outlives
 * the components, so a page opened again shows it at once and re-reads only once it is stale.
 */
function polledStore<T>(read: () => Promise<T> | undefined, initial: T, everyMs: number) {
  const store: PolledStore<T> = {
    value: initial,
    readAt: 0,
    inFlight: false,
    timer: undefined,
    listeners: new Set(),
  };
  const load = () => {
    if (store.inFlight) return;
    const request = read();
    if (!request) return;
    store.inFlight = true;
    request
      .then((next) => {
        store.readAt = Date.now();
        if (snapshot(store.value) === snapshot(next)) return;
        store.value = next;
        for (const listener of store.listeners) listener();
      })
      .catch(() => undefined)
      .finally(() => {
        store.inFlight = false;
      });
  };
  const subscribe = (listener: () => void) => {
    store.listeners.add(listener);
    if (store.listeners.size === 1) {
      if (Date.now() - store.readAt >= everyMs) load();
      store.timer = window.setInterval(load, everyMs);
    }
    return () => {
      store.listeners.delete(listener);
      if (store.listeners.size === 0) {
        window.clearInterval(store.timer);
        store.timer = undefined;
      }
    };
  };
  const getValue = () => store.value;
  return function usePolledValue(): T {
    return useSyncExternalStore(subscribe, getValue);
  };
}

const readAccounts = () =>
  window.piApp
    ?.getAccountStates()
    .then(
      (list) =>
        new Map(list.map((status) => [status.id, status])) as ReadonlyMap<string, AccountStatus>,
    );
const readSignIns = () => window.piApp?.getSignIns();
const readCachedLimits = () => window.piApp?.getAccountLimits({ cachedOnly: true });
const NO_ACCOUNTS: ReadonlyMap<string, AccountStatus> = new Map();
const NONE: readonly never[] = [];
const useAccounts = polledStore(readAccounts, NO_ACCOUNTS, 5_000);
const useSignInList = polledStore<readonly SignInStatus[]>(readSignIns, NONE, 60_000);
const useCachedLimits = polledStore<readonly AccountLimits[]>(readCachedLimits, NONE, 60_000);

/** The hourly sign-in check (memory read in the main process). */
export function useSignIns(): readonly SignInStatus[] {
  return useSignInList();
}

/**
 * Every provider's status. Pass `limits` where they were just read (Usage page); elsewhere the last
 * cached limits are used, so the model picker never contacts a provider.
 */
export function useProviderStatuses(
  limits?: readonly AccountLimits[],
): ReadonlyMap<string, ProviderStatus> {
  const accounts = useAccounts();
  const signIns = useSignIns();
  const cached = useCachedLimits();
  return useMemo(
    () => providerStatuses(accounts, signIns, limits ?? cached),
    [accounts, signIns, limits, cached],
  );
}

let lastReadLimits: readonly AccountLimits[] = [];

/**
 * Plan windows per account: read when Usage opens and on refresh, never on a timer. The main
 * process answers from a 5-minute cache, so neither path can hammer the providers.
 */
export function useAccountLimits() {
  // Opens on the last reading (marked "Updating") instead of an empty card.
  const [limits, setLimits] = useState<readonly AccountLimits[]>(() => lastReadLimits);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestId = useRef(0);
  const load = useCallback(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(false);
    const request = window.piApp?.getAccountLimits();
    if (!request) {
      setError(true);
      setLoading(false);
      return;
    }
    request
      .then((next) => {
        lastReadLimits = next;
        if (id === requestId.current) setLimits(next);
      })
      .catch(() => {
        if (id === requestId.current) setError(true);
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, []);
  useEffect(load, [load]);
  useEffect(
    () => () => {
      requestId.current += 1;
    },
    [],
  );
  return { error, limits, loading, reload: load };
}

/** How much of each plan window is used, per account; only windows the plan actually has. */
export function AccountLimitsCard({
  limits,
  loading,
  error,
}: {
  readonly limits: readonly AccountLimits[];
  readonly loading: boolean;
  readonly error: boolean;
}) {
  const hasLimits = limits.length > 0;
  return (
    <section
      aria-label="Plan limits"
      aria-busy={loading}
      className="usage-card usage-limits"
      role="region"
    >
      <div className="usage-limits__heading">
        <h3>Plan limits</h3>
        {loading && hasLimits ? (
          <span className="usage-limits__refreshing" role="status">
            Updating
          </span>
        ) : null}
        {!loading && error && hasLimits ? (
          <span className="usage-limits__refreshing" role="status">
            Showing last reading
          </span>
        ) : null}
      </div>
      {loading && !hasLimits ? (
        <div aria-label="Loading plan limits" className="usage-limits__skeleton" role="status">
          <span className="usage-limits__skeleton-name" />
          <div className="usage-limits__skeleton-row">
            <span className="usage-limits__skeleton-label" />
            <span className="usage-limits__skeleton-bar" />
            <span className="usage-limits__skeleton-value" />
          </div>
          <div className="usage-limits__skeleton-row">
            <span className="usage-limits__skeleton-label" />
            <span className="usage-limits__skeleton-bar" />
            <span className="usage-limits__skeleton-value" />
          </div>
        </div>
      ) : null}
      {!loading && !hasLimits ? (
        <p aria-live="polite" className="usage-limits__empty">
          {error
            ? "Plan limits could not be read. Refresh to retry."
            : "No plan limits were reported."}
        </p>
      ) : null}
      {hasLimits
        ? orderByTightestLimit(limits).map((account) => (
            <div className="usage-limits__account" key={account.id}>
              <div className="usage-limits__name">
                <ProviderIcon providerId={account.id} />
                <span
                  title={[account.note, `As of ${limitsAsOf.format(account.asOf)}`]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  {account.name}
                </span>
                {isRunningLow(account) ? (
                  <span className="usage-limits__low" data-testid="usage-limit-low">
                    Low
                  </span>
                ) : null}
              </div>
              {account.windows.length === 0 ? (
                <p className="usage-limits__empty">{account.note ?? "No numbers yet"}</p>
              ) : null}
              {account.windows.map((window) => {
                const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
                const brand = providerColor(account.id);
                return (
                  <div className="usage-limits__window" key={window.label}>
                    <span className="usage-limits__label">{window.label}</span>
                    <div
                      aria-label={`${window.label}: ${Math.round(remaining)}% left`}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={Math.round(remaining)}
                      className="usage-limits__bar"
                      role="meter"
                    >
                      <span
                        style={{
                          width: `${remaining}%`,
                          backgroundColor: `color-mix(in srgb, ${brand} ${remaining}%, color-mix(in srgb, ${brand} 35%, white))`,
                          ...(brandOf(account.id) === "openscale"
                            ? { backgroundImage: OPENSCALE_GRADIENT }
                            : {}),
                        }}
                      />
                    </div>
                    <span className="usage-limits__value">
                      {Math.round(remaining)}% left
                      {window.resetsAt ? ` · resets ${atLabel(window.resetsAt)}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          ))
        : null}
    </section>
  );
}

/** Sign-ins that need the owner, with what to run. Nothing when every sign-in works. */
export function SignInNotice({ signIns }: { readonly signIns: readonly SignInStatus[] }) {
  const problems = signIns.filter((signIn) => signIn.state !== "ok");
  if (problems.length === 0) return null;
  return (
    <section aria-label="Sign-ins" className="usage-card usage-signins" role="status">
      <h3>Sign-ins</h3>
      {problems.map((signIn) => (
        <div className="usage-signins__row" key={signIn.id}>
          <ProviderIcon providerId={signIn.id} />
          <span className="usage-signins__name">{signIn.name}</span>
          <span className="usage-signins__state" data-state={signIn.state}>
            {signIn.state === "expiring" && signIn.expiresAt
              ? `Sign-in ends ${atLabel(signIn.expiresAt)}`
              : signIn.state === "unknown"
                ? "Could not verify sign-in"
                : "Signed out"}
          </span>
          {signIn.fix ? <code className="usage-signins__fix">{signIn.fix}</code> : null}
        </div>
      ))}
    </section>
  );
}

export function ProviderStatusBadge({ status }: { readonly status: ProviderStatus | undefined }) {
  if (!status) return null;
  const label =
    status.state === "limited" && status.until
      ? `Limited until ${atLabel(status.until)}`
      : LABELS[status.state];
  return (
    <span className="account-state" data-state={status.state}>
      <span aria-hidden="true" className="account-state__dot" />
      {label}
    </span>
  );
}
