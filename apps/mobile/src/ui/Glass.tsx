import { BlurView } from "expo-blur";
import { useEffect, useState } from "react";
import { AccessibilityInfo, StyleSheet, View } from "react-native";
import { material, usePalette, useScheme } from "../theme";

export function useReduceTransparency(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => {
        if (live) setReduce(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setReduce);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}

/**
 * The one floating material (the desktop's polish.css glass: --surface-float over blur and
 * saturate), as a fill layer: put it first inside a view with a radius and overflow hidden.
 * Reduce Transparency turns it into the solid elevated surface, like the desktop's media query.
 * A top hairline catches the light, as on the desktop's composer.
 */
export function GlassFill({ radius }: { readonly radius: number }) {
  const palette = usePalette();
  const scheme = useScheme();
  const reduce = useReduceTransparency();
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: "hidden" }]}
    >
      {reduce ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.surfaceElevated }]} />
      ) : (
        <>
          <BlurView
            intensity={material.blur}
            style={StyleSheet.absoluteFill}
            tint={scheme === "dark" ? "systemThinMaterialDark" : "systemThinMaterialLight"}
          />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: material[scheme].fill }]} />
        </>
      )}
      <View
        style={[
          styles.highlight,
          {
            backgroundColor:
              scheme === "dark" ? "rgba(255, 255, 255, 0.10)" : "rgba(255, 255, 255, 0.7)",
            left: radius,
            right: radius,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  highlight: { position: "absolute", top: 0, height: StyleSheet.hairlineWidth },
});
