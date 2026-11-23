import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { ActivityIndicator, Linking, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { parsePairingLink } from "../api/pairing";
import { usePegasus } from "../state/PegasusProvider";
import { radius, spacing, text, usePalette } from "../theme";
import { Button, Icon } from "../ui";

/** First run: scan the QR code from Pegasus › Settings › Phone on the PC (or paste its link). */
export function PairScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { pair, linkError } = usePegasus();
  const [permission, requestPermission] = useCameraPermissions();
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);

  const tryPair = async (link: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await pair(parsePairingLink(link));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (reason) {
      handled.current = false;
      setError(reason instanceof Error ? reason.message : String(reason));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const problem = error ?? linkError;

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl },
      ]}
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: palette.background }}
    >
      <View style={styles.hero}>
        <Icon
          name="iphone.and.arrow.forward"
          color={palette.textStrong}
          size={40}
          weight="regular"
        />
        <Text accessibilityRole="header" style={[text.largeTitle, { color: palette.textStrong }]}>
          Pair with your PC
        </Text>
        <Text style={[text.callout, { color: palette.textMuted }]}>
          On your PC, open Pegasus › Settings › Phone and choose Show QR code. Both devices need
          Tailscale turned on.
        </Text>
      </View>

      <View
        style={[
          styles.camera,
          { backgroundColor: palette.surface, borderColor: palette.borderDefault },
        ]}
      >
        {permission?.granted ? (
          <CameraView
            accessibilityLabel="Camera, point it at the QR code on your PC"
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(result) => {
              if (handled.current) return;
              handled.current = true;
              tryPair(result.data).catch(() => undefined);
            }}
          />
        ) : (
          <View style={styles.cameraAsk}>
            <Icon name="qrcode.viewfinder" color={palette.textSoft} size={44} weight="regular" />
            <Button
              label={
                permission && !permission.canAskAgain ? "Open Settings" : "Allow camera to scan"
              }
              onPress={() => {
                if (permission && !permission.canAskAgain) {
                  Linking.openSettings().catch(() => undefined);
                } else {
                  requestPermission().catch(() => undefined);
                }
              }}
              variant="accent"
            />
            {permission && !permission.canAskAgain ? (
              <Text style={[text.footnote, styles.centerText, { color: palette.textMuted }]}>
                Camera access is off for Pegasus. Turn it on in Settings, or paste the link below.
              </Text>
            ) : null}
          </View>
        )}
        {busy ? (
          <View style={[styles.busy, { backgroundColor: palette.scrim }]}>
            <ActivityIndicator color={palette.onAccent} />
          </View>
        ) : null}
      </View>

      <Text style={[text.footnote, styles.caption, { color: palette.textMuted }]}>
        Or paste the pairing link
      </Text>
      <View style={styles.pasteRow}>
        <TextInput
          accessibilityLabel="Pairing link"
          value={pasted}
          onChangeText={setPasted}
          onSubmitEditing={() => {
            if (pasted.trim()) tryPair(pasted).catch(() => undefined);
          }}
          placeholder="pegasus://pair?…"
          placeholderTextColor={palette.textSoft}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          style={[
            text.body,
            styles.input,
            { color: palette.text, backgroundColor: palette.surface },
          ]}
        />
        <Button
          label="Pair"
          busy={busy}
          disabled={busy || pasted.trim() === ""}
          onPress={() => {
            tryPair(pasted).catch(() => undefined);
          }}
          variant="accent"
        />
      </View>
      {problem ? (
        <View
          accessibilityRole="alert"
          style={[
            styles.error,
            { backgroundColor: palette.dangerTint, borderColor: palette.dangerTintBorder },
          ]}
        >
          <Icon name="exclamationmark.triangle.fill" color={palette.dangerText} size={14} />
          <Text style={[text.footnote, styles.flex, { color: palette.dangerText }]}>
            {problem} Check that Pegasus is open on the PC and both devices are on Tailscale.
          </Text>
        </View>
      ) : null}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.xl, gap: spacing.md },
  hero: { gap: spacing.sm, marginBottom: spacing.sm },
  camera: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    marginVertical: spacing.sm,
  },
  cameraAsk: { alignItems: "center", gap: spacing.lg, padding: spacing.xl },
  centerText: { textAlign: "center" },
  busy: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  caption: { fontWeight: "500" },
  pasteRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  input: {
    flex: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 44,
  },
  error: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  flex: { flex: 1 },
});
