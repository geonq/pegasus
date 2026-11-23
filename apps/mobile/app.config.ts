import type { ExpoConfig } from "expo/config";

/**
 * Over-the-air JS updates come from the Pegasus host on the PC (crates/pegasus-host/src/updates.rs),
 * published by scripts/publish-update.mjs and signed with a key that never leaves the PC; the app
 * accepts only updates signed for updates/certificate.pem. The URL is baked into the native build.
 */
const updateUrl =
  process.env.PEGASUS_UPDATE_URL ?? "http://100.88.47.111:47831/v1/updates/manifest";

/**
 * Pegasus for iPhone. It talks to the Pegasus host on your PC over Tailscale (http to a 100.x
 * address): WireGuard encrypts that hop, and App Transport Security has no exception mechanism for
 * an IP range, so arbitrary loads are allowed for this personal build.
 */
const config: ExpoConfig = {
  name: "Pegasus",
  slug: "pegasus",
  scheme: "pegasus",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  // fingerprint: a hash of everything native (Expo config, native modules and their versions), so a
  // JS update only reaches builds with the exact same native code. appVersion would trust us to bump
  // "version" on every native change; forgetting it once loads JS into a binary that lacks a module.
  runtimeVersion: { policy: "fingerprint" },
  updates: {
    url: updateUrl,
    enabled: true,
    // Check on launch without blocking it; a downloaded update starts on the next launch.
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
    codeSigningCertificate: "./updates/certificate.pem",
    codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
  },
  ios: {
    bundleIdentifier: "dev.geonq.pegasus",
    supportsTablet: true,
    infoPlist: {
      NSCameraUsageDescription: "Scan the pairing QR code that Pegasus shows on your PC.",
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  plugins: [
    [
      "expo-camera",
      { cameraPermission: "Scan the pairing QR code that Pegasus shows on your PC." },
    ],
    "expo-secure-store",
    "expo-updates",
  ],
};

export default config;
