import Feather from "@expo/vector-icons/Feather";
import { StyleSheet, Text, View } from "react-native";

import { palette, radii, typeRamp } from "../../theme/palette";

export function AlertBanner(props: { message: string; tone?: "info" | "danger" | "success" | "warning"; testID?: string }) {
  const tone = props.tone ?? "info";
  const backgroundColor =
    tone === "danger"
      ? "rgba(255,124,112,0.12)"
      : tone === "success"
        ? "rgba(34,197,94,0.12)"
        : tone === "warning"
          ? "rgba(255,179,0,0.12)"
          : "rgba(69,216,237,0.12)";
  const borderColor =
    tone === "danger"
      ? "rgba(255,124,112,0.24)"
      : tone === "success"
        ? "rgba(34,197,94,0.24)"
        : tone === "warning"
          ? "rgba(255,179,0,0.24)"
          : "rgba(69,216,237,0.24)";
  const iconName =
    tone === "danger" ? "alert-triangle" : tone === "success" ? "check-circle" : tone === "warning" ? "alert-circle" : "info";

  return (
    <View testID={props.testID} style={[styles.banner, { backgroundColor, borderColor }]}>
      <Feather name={iconName} size={16} color={palette.ink} />
      <Text style={styles.message}>{props.message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  message: {
    ...typeRamp.body,
    color: palette.ink,
    flex: 1,
  },
});
