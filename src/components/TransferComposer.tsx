import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { airPayTestIds } from "../testing/testIds";
import { useI18n } from "../i18n/I18nProvider";
import { useAppSettings } from "../settings/AppSettingsProvider";
import { formatApproximateAssetAmount } from "../services/valueApproximation";
import { normalizeDecimalInput } from "../services/inputFormatters";
import { palette, radii, typeRamp } from "../theme/palette";
import { ActionButton } from "./ui/ActionButton";
import { AlertBanner } from "./ui/AlertBanner";
import { StatusChip } from "./ui/StatusChip";
import { SurfaceCard } from "./ui/SurfaceCard";

function getDefaultTransferAmount(maxOfflineAmount?: number): string {
  if (typeof maxOfflineAmount === "number" && Number.isFinite(maxOfflineAmount)) {
    if (maxOfflineAmount <= 0) {
      return "";
    }

    return Math.min(0.01, maxOfflineAmount).toString();
  }

  return "0.01";
}

export function TransferComposer(props: {
  busy: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSend: (amount: number) => Promise<void>;
  selectedReceiver?: {
    label: string;
    helper?: string;
    mode: "nfc" | "ble";
  } | null;
  trustPreview?: {
    tone: "info" | "warning" | "danger";
    message: string;
    helper?: string;
    riskLabel?: string;
    riskTone?: "info" | "warning" | "danger";
  } | null;
  trustWarning?: {
    message: string;
    helper?: string;
    riskLabel?: string;
    riskTone?: "info" | "warning" | "danger";
  } | null;
  onConfirmTrustWarning?: () => Promise<void>;
  onDismissTrustWarning?: () => void;
  maxOfflineAmount?: number;
}) {
  const { t } = useI18n();
  const { approximation } = useAppSettings();
  const [amount, setAmount] = useState(() => getDefaultTransferAmount(props.maxOfflineAmount));
  const amountApproximation = formatApproximateAssetAmount(amount, "SOL", approximation);
  const parsedAmount = Number(amount);
  const hasPositiveAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const hasCapacityLimit = typeof props.maxOfflineAmount === "number";
  const capacityUnavailable = hasCapacityLimit && props.maxOfflineAmount! <= 0;
  const amountExceedsCapacity =
    hasCapacityLimit && hasPositiveAmount && parsedAmount > props.maxOfflineAmount!;
  const capacityHelper = capacityUnavailable
    ? t("offline.capacity.empty")
    : amountExceedsCapacity
      ? t("offline.capacity.exceeded", { max: props.maxOfflineAmount })
      : null;
  const disabledByAmount = !hasPositiveAmount || capacityUnavailable || amountExceedsCapacity;

  useEffect(() => {
    setAmount((currentAmount) => {
      const current = Number(currentAmount);
      const currentIsUsable =
        currentAmount.trim().length > 0 &&
        Number.isFinite(current) &&
        current > 0 &&
        (typeof props.maxOfflineAmount !== "number" || current <= props.maxOfflineAmount);

      return currentIsUsable ? currentAmount : getDefaultTransferAmount(props.maxOfflineAmount);
    });
  }, [props.maxOfflineAmount]);

  return (
    <SurfaceCard variant="raised">
      <View testID={airPayTestIds.offline.card} style={styles.content}>
        <Text style={styles.kicker}>{t("offline.kicker")}</Text>
        <Text style={styles.title}>{t("offline.title")}</Text>

        <View style={styles.amountBox}>
          <TextInput
            testID={airPayTestIds.offline.amountInput}
            value={amount}
            onChangeText={(value) => setAmount(normalizeDecimalInput(value))}
            style={styles.amountInput}
            keyboardType="decimal-pad"
            returnKeyType="done"
            placeholder="0.00"
            placeholderTextColor={palette.mutedStrong}
          />
          <View style={styles.assetPill}>
            <Text style={styles.assetText}>SOL</Text>
          </View>
        </View>
        {amountApproximation ? <Text style={styles.amountApproximation}>{amountApproximation}</Text> : null}

        <View testID={airPayTestIds.offline.selectedReceiverCard} style={[styles.selectedReceiver, !props.selectedReceiver ? styles.selectedReceiverEmpty : null]}>
          <Text style={styles.selectedReceiverLabel}>{t("offline.receiver.label")}</Text>
          <Text style={styles.selectedReceiverValue}>
            {props.selectedReceiver?.label ?? t("offline.receiver.none")}
          </Text>
          <Text style={styles.selectedReceiverHelper}>
            {props.selectedReceiver?.helper ??
              (props.selectedReceiver
              ? t(`offline.discovery.mode.${props.selectedReceiver.mode}`)
              : t("offline.receiver.helper"))}
          </Text>
        </View>

        <AlertBanner tone="info" message={t("offline.feePolicy.sender")} />

        {props.disabled && props.disabledReason ? (
          <Text testID={airPayTestIds.offline.helperText} style={styles.helper}>
            {t("offline.helper", { reason: props.disabledReason })}
          </Text>
        ) : capacityHelper ? (
          <Text testID={airPayTestIds.offline.helperText} style={styles.helper}>
            {capacityHelper}
          </Text>
        ) : null}

        {props.trustPreview ? (
          <View style={styles.warningBlock}>
            {props.trustPreview.riskLabel ? (
              <StatusChip label={props.trustPreview.riskLabel} tone={props.trustPreview.riskTone ?? props.trustPreview.tone} />
            ) : null}
            <AlertBanner tone={props.trustPreview.tone} message={props.trustPreview.message} />
            {props.trustPreview.helper ? <Text style={styles.helper}>{props.trustPreview.helper}</Text> : null}
          </View>
        ) : null}

        {props.trustWarning ? (
          <View style={styles.warningBlock}>
            {props.trustWarning.riskLabel ? (
              <StatusChip label={props.trustWarning.riskLabel} tone={props.trustWarning.riskTone ?? "warning"} />
            ) : null}
            <AlertBanner testID={airPayTestIds.offline.trustWarningBanner} tone="warning" message={props.trustWarning.message} />
            {props.trustWarning.helper ? <Text style={styles.helper}>{props.trustWarning.helper}</Text> : null}
            <View style={styles.warningActions}>
              <ActionButton
                testID={airPayTestIds.offline.trustContinueButton}
                label={t("offline.trustWarning.continue")}
                variant="secondary"
                disabled={props.busy}
                onPress={() => {
                  void props.onConfirmTrustWarning?.();
                }}
                style={styles.warningButton}
              />
              <ActionButton
                testID={airPayTestIds.offline.trustDismissButton}
                label={t("offline.trustWarning.dismiss")}
                variant="ghost"
                disabled={props.busy}
                onPress={props.onDismissTrustWarning}
                style={styles.warningButton}
              />
            </View>
          </View>
        ) : null}

        <ActionButton
          testID={airPayTestIds.offline.sendButton}
          label={props.busy ? t("offline.action.sealing") : props.disabled ? t("offline.action.provisionRequired") : t("offline.action.send")}
          disabled={props.busy || props.disabled || Boolean(props.trustWarning) || disabledByAmount}
          onPress={() => props.onSend(Number(amount))}
        />
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
  },
  kicker: {
    ...typeRamp.label,
    color: palette.amber,
  },
  title: {
    ...typeRamp.title,
  },
  amountBox: {
    minHeight: 92,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  amountInput: {
    flex: 1,
    color: palette.ink,
    fontFamily: typeRamp.display.fontFamily,
    fontSize: 34,
    lineHeight: 40,
    letterSpacing: 0,
    paddingVertical: 0,
  },
  assetPill: {
    minWidth: 70,
    minHeight: 46,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    backgroundColor: palette.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  assetText: {
    ...typeRamp.titleCompact,
    color: palette.ink,
  },
  amountApproximation: {
    ...typeRamp.caption,
    color: palette.muted,
    marginTop: -8,
    textAlign: "right",
  },
  selectedReceiver: {
    minHeight: 84,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 4,
  },
  selectedReceiverEmpty: {
    borderColor: "rgba(255,179,0,0.24)",
    backgroundColor: "rgba(255,179,0,0.08)",
  },
  selectedReceiverLabel: {
    ...typeRamp.label,
    color: palette.mutedStrong,
  },
  selectedReceiverValue: {
    ...typeRamp.bodyStrong,
    color: palette.ink,
  },
  selectedReceiverHelper: {
    ...typeRamp.caption,
    color: palette.sky,
  },
  helper: {
    ...typeRamp.caption,
    color: palette.cyan,
  },
  warningBlock: {
    gap: 10,
  },
  warningActions: {
    flexDirection: "row",
    gap: 10,
  },
  warningButton: {
    flex: 1,
  },
});
