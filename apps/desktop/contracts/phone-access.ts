/** A phone paired with this PC's remote desktop API. */
export interface PairedPhone {
  readonly id: string;
  readonly label: string;
}

export interface PhoneAccessState {
  /** This PC's Tailscale IPv4 address; null when Tailscale is not running here. */
  readonly tailscaleAddress: string | null;
  readonly port: number;
  readonly phones: readonly PairedPhone[];
  /** The paired phones differ from what the running app serves: restart to apply. */
  readonly restartNeeded: boolean;
}

export interface PhonePairing {
  readonly phone: PairedPhone;
  /** `pegasus://pair?v=1&url=…&token=…&name=…`, what the QR code holds. */
  readonly pairingUrl: string;
  /** The QR code as SVG markup, rendered as an image. */
  readonly qrSvg: string;
}
