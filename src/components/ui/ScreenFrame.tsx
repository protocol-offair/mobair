import type { ReactNode } from "react";
import { LinearGradient } from "expo-linear-gradient";
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { gradients, palette, spacing } from "../../theme/palette";

export function ScreenFrame(props: {
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <LinearGradient colors={gradients.appBackground} style={styles.screen}>
      <View pointerEvents="none" style={styles.leftGlow} />
      <View pointerEvents="none" style={styles.rightGlow} />
      <SafeAreaView edges={["top"]} style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={[styles.content, props.contentStyle]}
          showsVerticalScrollIndicator={false}
        >
          {props.children}
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.background,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing.screenPadding,
    paddingBottom: 132,
    gap: spacing.sectionGap,
    paddingTop: 8,
  },
  leftGlow: {
    position: "absolute",
    left: -90,
    top: -220,
    width: 260,
    height: 620,
    borderRadius: 160,
    backgroundColor: gradients.glowLeft,
    opacity: 0.55,
  },
  rightGlow: {
    position: "absolute",
    right: -110,
    bottom: -180,
    width: 260,
    height: 620,
    borderRadius: 160,
    backgroundColor: gradients.glowRight,
    opacity: 0.55,
  },
});
