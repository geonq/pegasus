import type { ExpoConfig } from "expo/config";

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
  ],
};

export default config;
