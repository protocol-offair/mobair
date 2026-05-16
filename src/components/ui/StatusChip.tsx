import { StyleSheet, Text, View } from "react-native";

import { palette, radii, statusToneBackground, statusToneColor, typeRamp } from "../../theme/palette";

export function StatusChip(props: {
  label: string;
  tone?: "info" | "success" | "warning" | "danger" | "muted";
}) {
  const tone = props.tone ?? "info";
  const color = statusToneColor(tone);

  return (
    <View style={[styles.container, { backgroundColor: statusToneBackground(tone), borderColor: `${color}33` }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{props.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
  },
  label: {
    ...typeRamp.chip,
  },
});
