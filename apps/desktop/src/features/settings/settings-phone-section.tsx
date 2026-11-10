import { useCallback, useEffect, useState } from "react";
import type { PhoneAccessState, PhonePairing } from "../../../contracts/phone-access";
import { SettingsGroup, SettingsRow } from "./settings-utils";

/**
 * Settings › Phone: pair a phone with this PC over Tailscale. The QR code holds this PC's
 * Tailscale address and the phone's own token; the Pegasus phone app scans it.
 */
export function SettingsPhoneSection() {
  const [access, setAccess] = useState<PhoneAccessState | null>(null);
  const [pairing, setPairing] = useState<PhonePairing | null>(null);
  const [label, setLabel] = useState("iPhone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = window.piApp;
    if (!api?.getPhoneAccess) return;
    setAccess(await api.getPhoneAccess());
  }, []);

  useEffect(() => {
    refresh().catch((reason: unknown) => setError(messageOf(reason)));
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  const pair = () =>
    run(async () => {
      const result = await window.piApp?.pairPhone?.(label);
      if (result) setPairing(result);
    });

  const revoke = (phoneId: string) =>
    run(async () => {
      await window.piApp?.revokePhone?.(phoneId);
      if (pairing?.phone.id === phoneId) setPairing(null);
    });

  const tailscale = access?.tailscaleAddress ?? null;

  return (
    <>
      <SettingsGroup
        title="Connection"
        description="Your phone reaches this PC over Tailscale, so it works anywhere your tailnet does and never over the open network."
      >
        <SettingsRow
          title="Tailscale"
          description={
            tailscale
              ? `This PC is ${tailscale} on your tailnet. Phones connect to port ${access?.port ?? ""}.`
              : "Tailscale is not running on this PC. Start it, then pair a phone."
          }
        >
          <span className="settings-row__value" data-testid="phone-tailscale-status">
            {access === null ? "Checking…" : tailscale ? "Connected" : "Not running"}
          </span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Paired phones"
        description="Each phone has its own key. Revoking one locks that phone out after a restart."
      >
        {access?.phones.length ? (
          access.phones.map((phone) => (
            <SettingsRow key={phone.id} title={phone.label} description={phone.id}>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() => {
                  revoke(phone.id).catch(reportError);
                }}
              >
                Revoke
              </button>
            </SettingsRow>
          ))
        ) : (
          <SettingsRow title="No phones yet" description="Pair one below.">
            <span />
          </SettingsRow>
        )}
        <SettingsRow title="Pair a phone" description="Name it so you can tell phones apart.">
          <span className="settings-phone__pair">
            <input
              className="settings-text-input"
              aria-label="Phone name"
              value={label}
              maxLength={64}
              onChange={(event) => setLabel(event.target.value)}
            />
            <button
              type="button"
              className="button"
              disabled={busy || !tailscale}
              onClick={() => {
                pair().catch(reportError);
              }}
              data-testid="phone-pair"
            >
              Show QR code
            </button>
          </span>
        </SettingsRow>
        {pairing ? (
          <div className="settings-phone__qr" data-testid="phone-qr">
            <img
              alt={`QR code to pair ${pairing.phone.label}`}
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qrSvg)}`}
            />
            <p>
              Scan this with the Pegasus app on {pairing.phone.label}. It holds that phone&apos;s
              key: close it once the phone is paired.
            </p>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setPairing(null)}
            >
              Hide QR code
            </button>
          </div>
        ) : null}
        {access?.restartNeeded ? (
          <SettingsRow
            title="Restart to apply"
            description="Pegasus picks up paired or revoked phones when it starts."
          >
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                window.piApp?.restartApp?.().catch(reportError);
              }}
            >
              Restart Pegasus
            </button>
          </SettingsRow>
        ) : null}
        {error ? (
          <p className="settings-phone__error" role="alert">
            {error}
          </p>
        ) : null}
      </SettingsGroup>
    </>
  );
}

/** `run` reports its own failures; anything that still escapes is logged, never dropped. */
function reportError(reason: unknown): void {
  console.error("[settings] phone action failed", reason);
}

function messageOf(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  // Electron prefixes IPC errors with the channel; people only need the reason.
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/u, "");
}
