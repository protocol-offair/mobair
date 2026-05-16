import Feather from "@expo/vector-icons/Feather";
import { StyleSheet, Text, View } from "react-native";

import { palette, radii, typeRamp } from "../../theme/palette";

export interface ActivityRowProps {
  title: string;
  subtitle: string;
  amountLabel: string;
  approxLabel?: string;
  statusLabel: string;
  direction: "credit" | "debit" | "neutral";
}

export function ActivityRow(props: ActivityRowProps) {
  const color =
    props.direction === "credit" ? palette.cyan : props.direction === "debit" ? palette.ink : palette.muted;

  return (
    <View style={styles.row}>
      <View style={styles.leading}>
        <View style={styles.iconWrap}>
          <Feather name={props.direction === "credit" ? "arrow-down-left" : props.direction === "debit" ? "arrow-up-right" : "clock"} size={14} color={palette.muted} />
        </View>
        <View style={styles.metaWrap}>
          <Text style={styles.title}>{props.title}</Text>
          <Text style={styles.subtitle}>{props.subtitle}</Text>
        </View>
      </View>
      <View style={styles.trailing}>
        <Text style={[styles.amount, { color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
          {props.amountLabel}
        </Text>
        {props.approxLabel ? (
          <Text style={styles.approximation} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
            {props.approxLabel}
          </Text>
        ) : null}
        <Text style={styles.status}>{props.statusLabel}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.line,
  },
  leading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    flex: 1,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surfaceAlt,
  },
  metaWrap: {
    flex: 1,
    gap: 1,
  },
  title: {
    ...typeRamp.bodyStrong,
    color: palette.ink,
  },
  subtitle: {
    ...typeRamp.caption,
  },
  trailing: {
    alignItems: "flex-end",
    flexShrink: 0,
    maxWidth: "46%",
  },
  amount: {
    ...typeRamp.bodyStrong,
    textAlign: "right",
  },
  approximation: {
    ...typeRamp.caption,
    color: palette.muted,
    textAlign: "right",
  },
  status: {
    ...typeRamp.chip,
    color: palette.cyan,
  },
});
