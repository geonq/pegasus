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
  // Explicit: otherwise Expo adds "web" only where react-dom resolves (the PC workspace, not the Mac),
  // the config differs, and the fingerprint runtime version the PC publishes for never matches the app.
  platforms: ["ios", "android"],
  orientation: "portrait",
  // The Mac app's tile, full-bleed (scripts/make-ios-icon.py); iOS masks the corners itself.
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  // A fixed string, bumped by hand on every native change (new native module, icon, plugin, Expo SDK).
  // The fingerprint policy hashed differently on the PC (10968cd…, publish) and the Mac (4998995…,
  // the built app), so no update ever matched. Bump this and rebuild on the Mac whenever native changes.
  runtimeVersion: "native-2",
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
