import Feather from "@expo/vector-icons/Feather";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { airPayTestIds } from "../../testing/testIds";
import { palette, radii, spacing, typeRamp } from "../../theme/palette";
import { useI18n } from "../../i18n/I18nProvider";

function iconForRoute(name: string, focused: boolean) {
  const color = focused ? palette.ink : palette.mutedStrong;
  switch (name) {
    case "Home":
      return <Feather name="home" size={18} color={color} />;
    case "Send":
      return <Feather name="send" size={18} color={color} />;
    case "Receive":
      return <Feather name="maximize" size={18} color={color} />;
    case "History":
      return <Feather name="rotate-ccw" size={18} color={color} />;
    default:
      return <Feather name="circle" size={18} color={color} />;
  }
}

export function CustomTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  return (
    <View style={[styles.outer, { paddingBottom: Math.max(insets.bottom, spacing.tabBarInset) }]}>
      <View style={styles.inner}>
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const { options } = descriptors[route.key];
          const label =
            typeof options.tabBarLabel === "string"
              ? options.tabBarLabel
                : typeof options.title === "string"
                  ? options.title
                : route.name === "Home"
                  ? t("tabs.home")
                  : route.name === "Send"
                    ? t("tabs.send")
                    : route.name === "Receive"
                      ? t("tabs.receive")
                      : t("tabs.history");

          return (
            <Pressable
              key={route.key}
              testID={
                route.name === "Home"
                  ? airPayTestIds.tabs.home
                  : route.name === "Send"
                    ? airPayTestIds.tabs.send
                    : route.name === "Receive"
                      ? airPayTestIds.tabs.receive
                      : airPayTestIds.tabs.history
              }
              onPress={() => navigation.navigate(route.name)}
              style={({ pressed }) => [styles.item, focused && styles.itemActive, pressed && styles.itemPressed]}
            >
              {iconForRoute(route.name, focused)}
              <Text style={[styles.label, focused && styles.labelActive]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    backgroundColor: "transparent",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "transparent",
    paddingHorizontal: 18,
    paddingTop: 12,
  },
  inner: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 4,
    padding: 8,
    borderRadius: radii.lg,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.lineStrong,
  },
  item: {
    minWidth: 70,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    borderRadius: radii.md,
    opacity: 0.72,
  },
  itemActive: {
    backgroundColor: palette.skySoft,
    opacity: 1,
  },
  itemPressed: {
    opacity: 0.88,
  },
  label: {
    ...typeRamp.chip,
    color: palette.mutedStrong,
  },
  labelActive: {
    color: palette.ink,
  },
});
