import { Pressable, StyleSheet, Text, View } from "react-native";

import type { SupportedLocale } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import { palette, radii, typeRamp } from "../../theme/palette";
import { SurfaceCard } from "./SurfaceCard";

const localeOrder: SupportedLocale[] = ["pt-BR", "en"];

export function LocaleSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <SurfaceCard>
      <View style={styles.content}>
        <View style={styles.copy}>
          <Text style={styles.title}>{t("language.title")}</Text>
          <Text style={styles.helper}>{t("language.helper")}</Text>
          <Text style={styles.current}>
            {t("language.current")}: {locale === "pt-BR" ? t("common.locale.ptBR") : t("common.locale.english")}
          </Text>
        </View>
        <View style={styles.row}>
          {localeOrder.map((candidate) => {
            const active = candidate === locale;
            return (
              <Pressable
                key={candidate}
                onPress={() => void setLocale(candidate)}
                style={({ pressed }) => [
                  styles.option,
                  active && styles.optionActive,
                  pressed && styles.optionPressed,
                ]}
              >
                <Text style={[styles.optionLabel, active && styles.optionLabelActive]}>
                  {candidate === "pt-BR" ? t("common.locale.ptBR") : t("common.locale.english")}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 14,
  },
  copy: {
    gap: 4,
  },
  title: {
    ...typeRamp.label,
    color: palette.cyan,
  },
  helper: {
    ...typeRamp.body,
  },
  current: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  option: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surfaceAlt,
    paddingHorizontal: 12,
  },
  optionActive: {
    backgroundColor: palette.sky,
    borderColor: palette.sky,
  },
  optionPressed: {
    opacity: 0.92,
  },
  optionLabel: {
    ...typeRamp.bodyStrong,
    color: palette.ink,
    textAlign: "center",
  },
  optionLabelActive: {
    color: "#FFFFFF",
  },
});
