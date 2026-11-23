import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { ActivityIndicator, Linking, Modal, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, PressableScale } from "../../ui";
import { hitSize, palettes, radius, spacing, text, usePalette } from "../../theme";

// The viewfinder is dark in both schemes, like the system camera.
const chrome = palettes.dark;
import { photoName } from "./photo-name";
import type { ImageAttachment } from "./wire";

/**
 * Takes one photo for the composer with the camera the app already ships for pairing. Library
 * picks go through expo-image-picker in the composer's photo menu.
 */
export function PhotoCapture({
  visible,
  onClose,
  onPhoto,
}: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onPhoto: (photo: ImageAttachment) => void;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shoot = async () => {
    if (!camera.current || busy) return;
    setBusy(true);
    setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    try {
      // 0.6 keeps a phone photo near 1-2 MB, well under the PC's 10 MB per image.
      const picture = await camera.current.takePictureAsync({ base64: true, quality: 0.6 });
      if (!picture?.base64) throw new Error("The camera returned no image.");
      const at = Date.now();
      onPhoto({
        id: `phone-${at}`,
        kind: "image",
        name: photoName(null, at),
        mimeType: "image/jpeg",
        data: picture.base64,
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      visible={visible}
    >
      <View style={[styles.screen, { backgroundColor: chrome.window, paddingTop: insets.top }]}>
        {!permission ? (
          <ActivityIndicator color={chrome.textStrong} style={styles.flex} />
        ) : !permission.granted ? (
          <View style={[styles.flex, styles.center, { backgroundColor: palette.background }]}>
            <Text style={[text.headline, styles.centerText, { color: palette.textStrong }]}>
              Allow the camera to attach a photo
            </Text>
            <Button
              label={permission.canAskAgain ? "Allow camera" : "Open Settings"}
              onPress={() => {
                if (permission.canAskAgain) requestPermission().catch(() => undefined);
                else Linking.openSettings().catch(() => undefined);
              }}
              variant="accent"
            />
            <Button label="Cancel" onPress={onClose} variant="secondary" />
          </View>
        ) : (
          <>
            <CameraView
              facing="back"
              onCameraReady={() => setReady(true)}
              ref={camera}
              style={styles.flex}
            />
            {error ? (
              <Text
                accessibilityRole="alert"
                style={[text.footnote, styles.error, { color: chrome.dangerText }]}
              >
                {error}
              </Text>
            ) : null}
            <View style={[styles.bar, { paddingBottom: insets.bottom + spacing.lg }]}>
              <PressableScale
                accessibilityLabel="Cancel"
                accessibilityRole="button"
                onPress={onClose}
                style={styles.cancel}
              >
                <Text style={[text.body, { color: chrome.textStrong }]}>Cancel</Text>
              </PressableScale>
              <PressableScale
                accessibilityLabel="Take photo"
                accessibilityRole="button"
                accessibilityState={{ disabled: !ready || busy, busy }}
                disabled={!ready || busy}
                onPress={() => {
                  void shoot();
                }}
                style={[
                  styles.shutter,
                  { borderColor: chrome.textStrong, opacity: ready && !busy ? 1 : 0.5 },
                ]}
              >
                <View style={[styles.shutterInner, { backgroundColor: chrome.textStrong }]} />
              </PressableScale>
              <View style={styles.cancel} />
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xl },
  centerText: { textAlign: "center" },
  error: { textAlign: "center", padding: spacing.sm },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
  cancel: { minWidth: 72, minHeight: hitSize.min, justifyContent: "center" },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    borderWidth: 4,

    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: { width: 56, height: 56, borderRadius: radius.pill },
});
