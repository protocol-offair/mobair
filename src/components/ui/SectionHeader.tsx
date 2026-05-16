import { Pressable, StyleSheet, Text, View } from "react-native";

import { palette, typeRamp } from "../../theme/palette";

export function SectionHeader(props: {
  title: string;
  actionLabel?: string;
  onActionPress?: () => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{props.title}</Text>
      {props.actionLabel ? (
        <Pressable onPress={props.onActionPress}>
          <Text style={styles.action}>{props.actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 12,
  },
  title: {
    ...typeRamp.title,
  },
  action: {
    ...typeRamp.chip,
    color: palette.cyan,
  },
});
