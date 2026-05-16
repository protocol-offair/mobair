import { StyleSheet, Text, View } from "react-native";

import { palette, radii, typeRamp } from "../theme/palette";

export function MetricTile(props: { label: string; value: string; accent?: "amber" | "mint" | "sky" }) {
  const accentColor = props.accent ? palette[props.accent] : palette.ink;
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{props.label}</Text>
      <Text style={[styles.value, { color: accentColor }]}>{props.value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.line,
    padding: 16,
    gap: 10,
    minWidth: "48%",
  },
  label: {
    ...typeRamp.label,
    color: palette.muted,
  },
  value: {
    ...typeRamp.title,
    color: palette.ink,
  },
});
