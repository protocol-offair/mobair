import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

import { gradients, palette, radii, shadows } from "../../theme/palette";

export function SurfaceCard(props: {
  children: ReactNode;
  variant?: "default" | "raised" | "hero" | "danger";
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const variant = props.variant ?? "default";

  if (variant === "hero") {
    return (
      <LinearGradient
        testID={props.testID}
        colors={gradients.heroDark}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.base, styles.hero, props.style]}
      >
        {props.children}
      </LinearGradient>
    );
  }

  return (
    <View
      testID={props.testID}
      style={[
        styles.base,
        variant === "raised" ? styles.raised : variant === "danger" ? styles.danger : styles.default,
        props.style,
      ]}
    >
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.lg,
    padding: 18,
    gap: 14,
  },
  default: {
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.line,
    ...shadows.floating,
  },
  raised: {
    backgroundColor: palette.surfaceRaised,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    ...shadows.floating,
  },
  danger: {
    backgroundColor: palette.dangerSurface,
    borderWidth: 1,
    borderColor: "rgba(255,180,171,0.24)",
  },
  hero: {
    overflow: "hidden",
    ...shadows.hero,
  },
});
