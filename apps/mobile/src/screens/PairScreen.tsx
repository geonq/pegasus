import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { parsePairingLink } from "../api/pairing";
import { usePegasus } from "../state/PegasusProvider";
import { radius, spacing, type, usePalette } from "../theme";

/** First run: scan the QR code from Pegasus › Settings › Phone on the PC (or paste its link). */
export function PairScreen() {
  const palette = usePalette();
  const { pair, linkError } = usePegasus();
  const [permission, requestPermission] = useCameraPermissions();
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);

  const tryPair = async (text: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await pair(parsePairingLink(text));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (reason) {
      handled.current = false;
      setError(reason instanceof Error ? reason.message : String(reason));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: palette.background }]}>
      <Text style={[styles.title, { color: palette.text }]}>Pair with your PC</Text>
      <Text style={[styles.body, { color: palette.textMuted }]}>
        On your PC open Pegasus › Settings › Phone and choose Show QR code. Both devices need
        Tailscale on.
      </Text>

      <View
        style={[
          styles.camera,
          { backgroundColor: palette.surfaceRaised, borderColor: palette.line },
        ]}
      >
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(result) => {
              if (handled.current) return;
              handled.current = true;
              tryPair(result.data).catch(() => undefined);
            }}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            style={[styles.button, { backgroundColor: palette.accent }]}
            onPress={() => {
              requestPermission().catch(() => undefined);
            }}
          >
            <Text style={[styles.buttonText, { color: palette.onAccent }]}>
              Allow camera to scan
            </Text>
          </Pressable>
        )}
        {busy ? <ActivityIndicator style={styles.spinner} color={palette.accent} /> : null}
      </View>

      <Text style={[styles.caption, { color: palette.textMuted }]}>Or paste the pairing link</Text>
      <View style={styles.pasteRow}>
        <TextInput
          value={pasted}
          onChangeText={setPasted}
          placeholder="pegasus://pair?…"
          placeholderTextColor={palette.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            styles.input,
            { color: palette.text, backgroundColor: palette.surface, borderColor: palette.line },
          ]}
        />
        <Pressable
          accessibilityRole="button"
          disabled={busy || pasted.trim() === ""}
          style={[
            styles.button,
            { backgroundColor: palette.accent, opacity: pasted.trim() ? 1 : 0.5 },
          ]}
          onPress={() => {
            tryPair(pasted).catch(() => undefined);
          }}
        >
          <Text style={[styles.buttonText, { color: palette.onAccent }]}>Pair</Text>
        </Pressable>
      </View>
      {error || linkError ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>
          {error ?? linkError}
        </Text>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.xl, paddingTop: spacing.xl, gap: spacing.md },
  title: { fontSize: type.large, fontWeight: "700" },
  body: { fontSize: type.body, lineHeight: 22 },
  camera: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    marginVertical: spacing.md,
  },
  spinner: { position: "absolute" },
  caption: { fontSize: type.caption, textTransform: "uppercase", letterSpacing: 0.6 },
  pasteRow: { flexDirection: "row", gap: spacing.sm },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: type.body,
    minHeight: 44,
  },
  button: {
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: "center",
  },
  buttonText: { fontSize: type.body, fontWeight: "600" },
  error: { fontSize: type.body },
});
