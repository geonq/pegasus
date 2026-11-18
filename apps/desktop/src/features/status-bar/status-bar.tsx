import { useEffect, useState } from "react";
import type { HostConnectionStatus, PiDesktopApi } from "../../../contracts/ipc";
import type { UpdateStatus } from "../../../contracts/updates";
import type { UsageLimitWindow } from "../../../contracts/usage";
import { useCachedAccountLimits } from "../usage/account-state";
import { LOW_LIMIT_USED_PERCENT } from "../usage/limit-order";

const HOST_POLL_MS = 30_000;

/**
 * One line along the bottom of the window: plan usage of the selected model's account (opens
 * Usage), the app update while one is under way, and whether the Rust host answers.
 */
export function StatusBar({
  api,
  provider,
  onOpenUsage,
}: {
  readonly api: PiDesktopApi | undefined;
  readonly provider: string | undefined;
  readonly onOpenUsage: () => void;
}) {
  return (
    <footer className="status-bar" data-testid="status-bar">
      <UsageSegment provider={provider} onOpenUsage={onOpenUsage} />
      <span className="status-bar__spacer" />
      <UpdateSegment api={api} />
      <HostSegment api={api} />
    </footer>
  );
}

function UsageSegment({
  provider,
  onOpenUsage,
}: {
  readonly provider: string | undefined;
  readonly onOpenUsage: () => void;
}) {
  const limits = useCachedAccountLimits();
  if (!provider) return null;
  const account = limits.find((entry) => entry.id === provider);
  // The window with the least left decides whether a run can start.
  const tightest = account?.windows.reduce<UsageLimitWindow | undefined>(
    (worst, window) => (!worst || window.usedPercent > worst.usedPercent ? window : worst),
    undefined,
  );
  const left = tightest ? Math.max(0, Math.round(100 - tightest.usedPercent)) : undefined;
  const label = !account
    ? "Plan usage not reported"
    : !tightest || left === undefined
      ? `${account.name} · no plan numbers yet`
      : `${account.name} · ${left}% left · ${tightest.label}`;
  const level =
    tightest && tightest.usedPercent >= 100
      ? "spent"
      : tightest && tightest.usedPercent >= LOW_LIMIT_USED_PERCENT
        ? "low"
        : "ok";
  return (
    <button
      className="status-bar__segment status-bar__segment--button"
      data-level={level}
      data-testid="status-bar-usage"
      title="Open usage"
      type="button"
      onClick={onOpenUsage}
    >
      {tightest ? (
        <span aria-hidden="true" className="status-bar__meter">
          <span style={{ width: `${left}%` }} />
        </span>
      ) : null}
      <span className="status-bar__text">{label}</span>
    </button>
  );
}

function UpdateSegment({ api }: { readonly api: PiDesktopApi | undefined }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!api?.getUpdateStatus) return undefined;
    let live = true;
    api
      .getUpdateStatus()
      .then((next) => live && setStatus(next))
      .catch(() => undefined);
    const stop = api.onUpdateStatus?.((next) => setStatus(next));
    return () => {
      live = false;
      stop?.();
    };
  }, [api]);
  if (!status || status.phase === "idle") return null;
  const text =
    status.phase === "available"
      ? `Pegasus ${status.latestVersion ?? "update"} available`
      : status.phase === "downloading"
        ? `Downloading update · ${Math.round((status.progress ?? 0) * 100)}%`
        : status.phase === "installing"
          ? "Installing update"
          : "Update failed";
  return (
    <span
      className="status-bar__segment"
      data-level={status.phase === "error" ? "spent" : "ok"}
      data-testid="status-bar-update"
      role="status"
      title={status.message}
    >
      {text}
    </span>
  );
}

function HostSegment({ api }: { readonly api: PiDesktopApi | undefined }) {
  const [status, setStatus] = useState<HostConnectionStatus | null>(null);
  useEffect(() => {
    if (!api?.getHostStatus) return undefined;
    let live = true;
    // The Mac client has no host of its own; its call rejects and the segment stays hidden.
    const read = () => {
      api.getHostStatus().then(
        (next) => live && setStatus(next),
        () => live && setStatus(null),
      );
    };
    read();
    const timer = window.setInterval(read, HOST_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [api]);
  if (!status) return null;
  const text =
    status.state === "connected"
      ? "Host connected"
      : status.state === "off"
        ? "Host off"
        : "Host unavailable";
  return (
    <span
      className="status-bar__segment"
      data-level={status.state === "connected" ? "ok" : "low"}
      data-testid="status-bar-host"
      role="status"
      title={status.version ? `Pegasus host ${status.version}` : "See the host log"}
    >
      <span aria-hidden="true" className="status-bar__dot" />
      {text}
    </span>
  );
}
