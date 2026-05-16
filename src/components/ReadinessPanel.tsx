import { StyleSheet, Text, View } from "react-native";

import type { OnboardingState } from "../services/wallet";
import { airPayTestIds } from "../testing/testIds";
import { useI18n } from "../i18n/I18nProvider";
import { palette, radii, typeRamp } from "../theme/palette";
import { StatusChip } from "./ui/StatusChip";
import { SurfaceCard } from "./ui/SurfaceCard";

interface StepState {
  label: string;
  done: boolean;
  testID: string;
}

function StepChip(props: StepState) {
  return (
    <View testID={props.testID} style={[styles.step, props.done ? styles.stepDone : styles.stepPending]}>
      <Text style={[styles.stepText, props.done ? styles.stepTextDone : styles.stepTextPending]}>{props.label}</Text>
    </View>
  );
}

export function ReadinessPanel(props: {
  onboarding: OnboardingState | null;
  hasWallet: boolean;
  backupConfirmed: boolean;
  offlineReady: boolean;
  pendingChainCount: number;
  executionMode: string;
}) {
  const { t } = useI18n();
  const steps: StepState[] = [
    { label: t("readiness.wallet"), done: props.hasWallet, testID: airPayTestIds.readiness.walletStep },
    { label: t("readiness.backup"), done: props.backupConfirmed, testID: airPayTestIds.readiness.backupStep },
    { label: t("readiness.device"), done: Boolean(props.onboarding?.deviceKeyReady), testID: airPayTestIds.readiness.deviceStep },
    { label: t("readiness.walletRegistered"), done: Boolean(props.onboarding?.onChainProfileReady), testID: airPayTestIds.readiness.walletRegisteredStep },
    { label: t("readiness.budget"), done: Boolean(props.onboarding?.reserveReady), testID: airPayTestIds.readiness.budgetStep },
    { label: t("readiness.offline"), done: props.offlineReady, testID: airPayTestIds.readiness.offlineStep },
  ];

  return (
    <SurfaceCard>
      <View testID={airPayTestIds.readiness.card} style={styles.content}>
        <View style={styles.header}>
          <View style={styles.copy}>
            <Text style={styles.kicker}>{t("readiness.title")}</Text>
            <Text style={styles.title}>{t("readiness.body")}</Text>
          </View>
          <StatusChip
            label={props.offlineReady ? t("common.status.ready") : t("viewModel.status.pending")}
            tone={props.offlineReady ? "success" : "warning"}
          />
        </View>

        <Text testID={airPayTestIds.readiness.backendMeta} style={styles.meta}>
          {t("readiness.backend", { mode: `${props.executionMode} · ${props.pendingChainCount}` })}
        </Text>

        {props.onboarding?.quarantined ? (
          <View testID={airPayTestIds.readiness.quarantineBanner} style={styles.banner}>
            <Text style={styles.bannerText}>{t("readiness.quarantine")}</Text>
          </View>
        ) : null}

        <View style={styles.grid}>
          {steps.map((step) => (
            <StepChip key={step.label} {...step} />
          ))}
        </View>
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
  },
  header: {
    gap: 12,
  },
  copy: {
    gap: 6,
  },
  kicker: {
    ...typeRamp.label,
    color: palette.cyan,
  },
  title: {
    ...typeRamp.title,
  },
  meta: {
    ...typeRamp.body,
  },
  banner: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: "rgba(255,124,112,0.24)",
    backgroundColor: "rgba(255,124,112,0.12)",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  bannerText: {
    ...typeRamp.body,
    color: palette.ink,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  step: {
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  stepDone: {
    backgroundColor: "rgba(34,197,94,0.12)",
    borderColor: "rgba(34,197,94,0.24)",
  },
  stepPending: {
    backgroundColor: "rgba(69,216,237,0.1)",
    borderColor: "rgba(69,216,237,0.24)",
  },
  stepText: {
    ...typeRamp.chip,
  },
  stepTextDone: {
    color: palette.mint,
  },
  stepTextPending: {
    color: palette.cyan,
  },
});
