import { LinearGradient } from "expo-linear-gradient";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Feather from "@expo/vector-icons/Feather";

import { gradients, palette, radii, shadows, spacing, typeRamp } from "../../theme/palette";

export function ActionButton(props: {
  label: string;
  icon?: keyof typeof Feather.glyphMap;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  compact?: boolean;
  testID?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const variant = props.variant ?? "primary";
  const isDisabled = Boolean(props.disabled);

  return (
    <Pressable
      testID={props.testID}
      disabled={isDisabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.pressable,
        props.style,
        pressed && !isDisabled ? styles.pressed : null,
        isDisabled ? styles.disabled : null,
      ]}
    >
      {variant === "primary" ? (
        <LinearGradient colors={gradients.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.base, styles.primary, props.compact && styles.compact, shadows.button]}>
          {props.icon ? <Feather name={props.icon} size={16} color="#FFFFFF" /> : null}
          <Text style={styles.primaryLabel}>{props.label}</Text>
        </LinearGradient>
      ) : (
        <View
          style={[
            styles.base,
            variant === "secondary" ? styles.secondary : styles.ghost,
            props.compact && styles.compact,
          ]}
        >
          {props.icon ? (
            <Feather name={props.icon} size={16} color={variant === "ghost" ? palette.muted : palette.ink} />
          ) : null}
          <Text style={variant === "ghost" ? styles.ghostLabel : styles.secondaryLabel}>{props.label}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: {
    borderRadius: radii.md,
  },
  base: {
    minHeight: spacing.buttonHeight,
    borderRadius: radii.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  primary: {
    overflow: "hidden",
  },
  secondary: {
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.lineStrong,
  },
  ghost: {
    backgroundColor: "transparent",
  },
  compact: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  primaryLabel: {
    ...typeRamp.bodyStrong,
    color: "#FFFFFF",
    fontFamily: typeRamp.bodyStrong.fontFamily,
  },
  secondaryLabel: {
    ...typeRamp.bodyStrong,
    color: palette.ink,
  },
  ghostLabel: {
    ...typeRamp.bodyStrong,
    color: palette.muted,
  },
  pressed: {
    opacity: 0.92,
    transform: [{ scale: 0.98 }],
  },
  disabled: {
    opacity: 0.45,
  },
});
