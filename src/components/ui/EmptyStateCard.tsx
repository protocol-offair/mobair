import Feather from "@expo/vector-icons/Feather";
import { StyleSheet, Text, View } from "react-native";

import { palette, radii, typeRamp } from "../../theme/palette";

export function EmptyStateCard(props: {
  title: string;
  body: string;
  icon?: keyof typeof Feather.glyphMap;
  testID?: string;
}) {
  return (
    <View testID={props.testID} style={styles.card}>
      <View style={styles.iconWrap}>
        <Feather name={props.icon ?? "inbox"} size={18} color={palette.mutedStrong} />
      </View>
      <Text style={styles.title}>{props.title}</Text>
      <Text style={styles.body}>{props.body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.line,
    padding: 20,
    gap: 10,
    alignItems: "flex-start",
  },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surfaceAlt,
  },
  title: {
    ...typeRamp.titleCompact,
  },
  body: {
    ...typeRamp.body,
  },
});
