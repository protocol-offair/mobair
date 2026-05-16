import { ScrollView, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Feather from "@expo/vector-icons/Feather";

import { palette, radii, shadows, typeRamp } from "../../theme/palette";

export interface ActionRailItem<T extends string = string> {
  id: T;
  label: string;
  icon: keyof typeof Feather.glyphMap;
  disabled?: boolean;
}

export function ActionRail<T extends string>(props: {
  items: Array<ActionRailItem<T>>;
  activeId?: T;
  onSelect: (id: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.content, props.style]}
    >
      {props.items.map((item) => {
        const active = item.id === props.activeId;
        return (
          <Pressable
            key={item.id}
            disabled={item.disabled}
            onPress={() => props.onSelect(item.id)}
            style={({ pressed }) => [
              styles.item,
              active ? styles.itemActive : null,
              item.disabled ? styles.itemDisabled : null,
              pressed && !item.disabled ? styles.itemPressed : null,
            ]}
          >
            <View style={[styles.iconWrap, active ? styles.iconWrapActive : null]}>
              <Feather name={item.icon} size={20} color={active ? "#FFFFFF" : palette.sky} />
            </View>
            <Text numberOfLines={2} style={[styles.label, active ? styles.labelActive : null]}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 10,
    paddingRight: 2,
  },
  item: {
    width: 78,
    alignItems: "center",
    gap: 7,
  },
  itemPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.97 }],
  },
  itemDisabled: {
    opacity: 0.45,
  },
  itemActive: {},
  iconWrap: {
    width: 54,
    height: 54,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    ...shadows.floating,
  },
  iconWrapActive: {
    backgroundColor: palette.sky,
    borderColor: palette.sky,
  },
  label: {
    ...typeRamp.caption,
    color: palette.muted,
    textAlign: "center",
    lineHeight: 15,
  },
  labelActive: {
    color: palette.ink,
  },
});
