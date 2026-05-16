import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Feather from "@expo/vector-icons/Feather";

import { useI18n } from "../../i18n/I18nProvider";
import { useAppSettings } from "../../settings/AppSettingsProvider";
import { palette, radii, shadows, typeRamp } from "../../theme/palette";
import { StatusChip } from "./StatusChip";
import airpayLogoMark from "../../../assets/brand/airpay-logo-mark.png";

export function AppTopBar(props: {
  statusLabel?: string;
  statusTone?: "info" | "success" | "warning" | "danger" | "muted";
  rightIcon?: keyof typeof Feather.glyphMap;
  onRightPress?: () => void;
  showLanguageButton?: boolean;
  showSettingsButton?: boolean;
}) {
  const { locale, setLocale, t } = useI18n();
  const { openSettings } = useAppSettings();
  const { width } = useWindowDimensions();
  const showLanguageButton = props.showLanguageButton ?? true;
  const showSettingsButton = props.showSettingsButton ?? true;
  const nextLocale = locale === "pt-BR" ? "en" : "pt-BR";
  const compactHeader = width < 430;

  return (
    <View style={[styles.container, compactHeader && styles.containerCompact]}>
      <View style={[styles.brandRow, compactHeader && styles.brandRowCompact]} accessibilityRole="image" accessibilityLabel="MobAir">
        <View style={[styles.logoBadge, compactHeader && styles.logoBadgeCompact]}>
          <Image source={airpayLogoMark} resizeMode="contain" style={styles.logoImage} />
        </View>
        {!compactHeader ? <Text style={styles.brand}>MobAir</Text> : null}
      </View>
      <View style={[styles.rightRow, compactHeader && styles.rightRowCompact]}>
        {props.statusLabel ? <StatusChip label={props.statusLabel} tone={props.statusTone ?? "info"} /> : null}
        {showLanguageButton ? (
          <Pressable
            style={[styles.languageButton, compactHeader && styles.languageButtonCompact]}
            onPress={() => {
              void setLocale(nextLocale);
            }}
          >
            <Feather name="globe" size={14} color={palette.sky} />
            <Text style={styles.languageText}>{locale === "pt-BR" ? "PT" : "EN"}</Text>
          </Pressable>
        ) : null}
        {showSettingsButton ? (
          <Pressable
            accessibilityLabel={t("settings.accessibility.open")}
            style={styles.iconButton}
            onPress={openSettings}
          >
            <Feather name="settings" size={15} color={palette.muted} />
          </Pressable>
        ) : null}
        {props.rightIcon ? (
          <Pressable style={styles.iconButton} onPress={props.onRightPress} disabled={!props.onRightPress}>
            <Feather name={props.rightIcon} size={15} color={palette.muted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    paddingVertical: 8,
  },
  containerCompact: {
    gap: 10,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  brandRowCompact: {
    flexShrink: 0,
    gap: 0,
  },
  logoBadge: {
    width: 34,
    height: 34,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    ...shadows.floating,
  },
  logoBadgeCompact: {
    width: 36,
    height: 36,
  },
  logoImage: {
    width: 28,
    height: 28,
  },
  brand: {
    ...typeRamp.title,
    color: palette.sky,
  },
  rightRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rightRowCompact: {
    gap: 6,
    flexShrink: 1,
  },
  languageButton: {
    minWidth: 52,
    height: 36,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 5,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.line,
    paddingHorizontal: 10,
  },
  languageButtonCompact: {
    minWidth: 48,
    paddingHorizontal: 8,
  },
  languageText: {
    ...typeRamp.chip,
    color: palette.sky,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.line,
  },
});
