import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useIsFocused } from "@react-navigation/native";

import { ChainComposer } from "../components/ChainComposer";
import { GatewayPaymentComposer } from "../components/GatewayPaymentComposer";
import { GatewayPaymentLinkComposer } from "../components/GatewayPaymentLinkComposer";
import { NearbyReceiverRadar } from "../components/NearbyReceiverRadar";
import { TransferComposer } from "../components/TransferComposer";
import { ActionRail } from "../components/ui/ActionRail";
import { AlertBanner } from "../components/ui/AlertBanner";
import { ActionButton } from "../components/ui/ActionButton";
import { AppTopBar } from "../components/ui/AppTopBar";
import { EmptyStateCard } from "../components/ui/EmptyStateCard";
import { ScreenFrame } from "../components/ui/ScreenFrame";
import { SectionHeader } from "../components/ui/SectionHeader";
import { StatusChip } from "../components/ui/StatusChip";
import { SurfaceCard } from "../components/ui/SurfaceCard";
import type { AirPayWalletController } from "../hooks/useAirPayWallet";
import { formatAssetAmount } from "../i18n";
import { useI18n } from "../i18n/I18nProvider";
import { useAppSettings } from "../settings/AppSettingsProvider";
import { formatApproximateAssetAmount } from "../services/valueApproximation";
import { palette, radii, typeRamp } from "../theme/palette";

export function SendScreen(props: { controller: AirPayWalletController; gatewayPayload?: string }) {
  const { controller } = props;
  const { t } = useI18n();
  const { approximation } = useAppSettings();
  const isFocused = useIsFocused();
  const [reserveAmount, setReserveAmount] = useState("");
  const [onlineMode, setOnlineMode] = useState<"paste" | "scan" | "link" | "chain" | "reserve">("paste");
  const [offlineMode, setOfflineMode] = useState<"gateway-pay" | "gateway-link" | "offair">("gateway-pay");
  const solBalanceAmount = controller.wallet?.balances?.SOL
    ? formatAssetAmount(controller.wallet.balances.SOL.amount, "SOL")
    : "--";
  const isNetworkOnline = controller.backgroundRuntime.networkConnected !== false;
  const isGatewayMode = onlineMode === "paste" || onlineMode === "scan";
  const offlineCapacityRequired = controller.wallet ? !controller.wallet.onboarding.rpcReachable : true;
  const offlineCapacityMax = controller.offlinePromiseCapacity?.maxAmount ?? 0;
  const promiseCapacityAmount = controller.offlinePromiseCapacity
    ? formatAssetAmount(offlineCapacityMax, "SOL")
    : controller.wallet?.balances?.OFFAIR
      ? formatAssetAmount(controller.wallet.balances.OFFAIR.amount, "OFFAIR")
      : "--";
  const reserveCapacityAmount =
    controller.wallet?.reserve.remainingAmount !== undefined
      ? formatAssetAmount(controller.wallet.reserve.remainingAmount, "SOL")
      : "--";
  const solBalanceApproximation = controller.wallet?.balances?.SOL
    ? formatApproximateAssetAmount(controller.wallet.balances.SOL.amount, "SOL", approximation)
    : null;
  const promiseCapacityApproximation = controller.offlinePromiseCapacity
    ? formatApproximateAssetAmount(offlineCapacityMax, "SOL", approximation)
    : controller.wallet?.balances?.OFFAIR
      ? formatApproximateAssetAmount(controller.wallet.balances.OFFAIR.amount, "OFFAIR", approximation)
      : null;
  const reserveCapacityApproximation =
    controller.wallet?.reserve.remainingAmount !== undefined
      ? formatApproximateAssetAmount(controller.wallet.reserve.remainingAmount, "SOL", approximation)
      : null;
  const offlineCapacityReady = !offlineCapacityRequired || offlineCapacityMax > 0;
  const sendTrustRiskTone: "info" | "warning" | "danger" =
    controller.sendTrustPrompt?.riskLevel === "blocked"
      ? "danger"
      : controller.sendTrustPrompt?.riskLevel === "high" || controller.sendTrustPrompt?.riskLevel === "guarded"
        ? "warning"
        : "info";
  const trustWarning = controller.sendTrustPrompt
    ? {
        message: t("offline.trustWarning.message", {
          peer: controller.sendTrustPrompt.peerLabel,
          risk: t(`history.trust.risk.${controller.sendTrustPrompt.riskLevel}`),
          riskScore: controller.sendTrustPrompt.riskScore,
        }),
        helper: controller.sendTrustPrompt.reasons.length
          ? t("offline.trustWarning.helper", {
              reasons: controller.sendTrustPrompt.reasons
                .map((reason) => t(`offline.trustWarning.reason.${reason}`))
                .join(", "),
            })
          : undefined,
        riskLabel: t(`history.trust.risk.${controller.sendTrustPrompt.riskLevel}`),
        riskTone: sendTrustRiskTone,
      }
    : null;
  const trustPreview = controller.sendTrustPreview;

  useEffect(() => {
    if (props.gatewayPayload) {
      setOnlineMode("paste");
      setOfflineMode("gateway-pay");
    }
  }, [props.gatewayPayload]);

  useEffect(() => {
    if (isFocused && !isNetworkOnline && offlineMode === "offair" && controller.offlineReady && controller.wallet?.profile) {
      void controller.startSenderDiscovery();
      return () => {
        void controller.stopSenderDiscovery();
      };
    }

    void controller.stopSenderDiscovery();
    return undefined;
  }, [isFocused, isNetworkOnline, offlineMode, controller.offlineReady, controller.wallet?.profile?.walletId]);

  return (
    <ScreenFrame>
      <AppTopBar
        statusLabel={isNetworkOnline ? t("common.status.online") : t("common.status.local")}
        statusTone={isNetworkOnline ? "success" : "warning"}
        rightIcon={isNetworkOnline ? "wifi" : "wifi-off"}
      />

      <View style={styles.hero}>
        <Text style={styles.eyebrow}>{isNetworkOnline ? t("send.hero.onlineEyebrow") : t("send.hero.offlineEyebrow")}</Text>
        <Text style={styles.headline}>{isNetworkOnline ? t("send.hero.onlineTitle") : t("send.hero.offlineTitle")}</Text>
        <Text style={styles.copy}>
          {isNetworkOnline ? t("send.hero.onlineBody") : t("send.hero.offlineBody")}
        </Text>
      </View>

      {controller.error ? <AlertBanner tone="danger" message={controller.error} /> : null}

      <WalletStatusCard
        solBalanceAmount={solBalanceAmount}
        solBalanceApproximation={solBalanceApproximation}
        promiseCapacityAmount={promiseCapacityAmount}
        promiseCapacityApproximation={promiseCapacityApproximation}
        reserveAmount={reserveCapacityAmount}
        reserveApproximation={reserveCapacityApproximation}
        offlineReady={controller.offlineReady}
        offlineCapacityReady={offlineCapacityReady}
        pendingChainCount={controller.pendingChainCount}
      />

      {isNetworkOnline ? (
        <>
          <ActionRail
            activeId={onlineMode}
            items={[
              { id: "paste", label: t("gatewayPay.action.copyPaste"), icon: "clipboard" },
              { id: "scan", label: t("gatewayPay.action.scanQr"), icon: "camera" },
              { id: "link", label: t("gatewayLink.action.short"), icon: "link" },
              { id: "chain", label: t("send.action.directSol"), icon: "send" },
              { id: "reserve", label: t("send.action.reserve"), icon: "database" },
            ]}
            onSelect={setOnlineMode}
          />

          {isGatewayMode ? (
            <View style={styles.section}>
              <GatewayPaymentComposer
                initialPayload={props.gatewayPayload}
                mode={onlineMode === "scan" ? "scan" : "paste"}
                onModeChange={setOnlineMode}
                showModeRail={false}
                networkOnline={isNetworkOnline}
                busy={controller.busy}
                disabled={!controller.wallet?.profile}
                onPay={controller.payOnlineRequest}
              />
            </View>
          ) : null}

          {onlineMode === "link" ? (
            <View style={styles.section}>
              <GatewayPaymentLinkComposer
                merchantWallet={controller.wallet?.profile?.solanaAddress}
                networkOnline={isNetworkOnline}
                disabled={!controller.wallet?.profile}
              />
            </View>
          ) : null}

          {onlineMode === "chain" ? (
            <View style={styles.section}>
              <ChainComposer
                busy={controller.busy}
                disabled={!controller.wallet?.profile}
                onQueue={controller.queueChainTransfer}
                onSubmit={controller.submitChainTransactions}
                onRefresh={controller.refreshChainQueue}
                pendingCount={controller.pendingChainCount}
              />
            </View>
          ) : null}

          {onlineMode === "reserve" && controller.wallet?.profile ? (
            <ReserveCapacityCard
              amount={reserveAmount}
              busy={controller.busy}
              onChangeAmount={setReserveAmount}
              onFund={() => controller.fundReserve(reserveAmount)}
              onWithdraw={() => controller.withdrawReserve(reserveAmount)}
            />
          ) : null}
        </>
      ) : (
        <>
          {!controller.wallet?.profile ? (
            <EmptyStateCard
              title={t("send.walletRequired.title")}
              body={t("send.walletRequired.body")}
              icon="shield"
            />
          ) : null}

          <ActionRail
            activeId={offlineMode}
            items={[
              { id: "gateway-pay", label: t("gatewayPay.action.short"), icon: "clipboard" },
              { id: "gateway-link", label: t("gatewayLink.action.short"), icon: "link" },
              { id: "offair", label: t("send.action.offair"), icon: "radio" },
            ]}
            onSelect={setOfflineMode}
          />

          {offlineMode === "gateway-pay" ? (
            <View style={styles.section}>
              <GatewayPaymentComposer
                initialPayload={props.gatewayPayload}
                mode="paste"
                showModeRail
                networkOnline={isNetworkOnline}
                busy={controller.busy}
                disabled={!controller.wallet?.profile}
                onPay={controller.payOnlineRequest}
              />
            </View>
          ) : offlineMode === "gateway-link" ? (
            <View style={styles.section}>
              <GatewayPaymentLinkComposer
                merchantWallet={controller.wallet?.profile?.solanaAddress}
                networkOnline={isNetworkOnline}
                disabled={!controller.wallet?.profile}
              />
            </View>
          ) : (
            <>
              <View style={styles.section}>
                <SectionHeader title={t("offline.discovery.section")} />
                <NearbyReceiverRadar
                  receivers={controller.senderDiscovery.receivers}
                  selectedReceiverId={controller.senderDiscovery.selectedReceiverId}
                  nfcStatus={controller.senderDiscovery.nfcStatus}
                  bleActive={controller.senderDiscovery.bleActive}
                  busy={controller.busy}
                  resolvingReceiverId={controller.senderDiscovery.resolvingReceiverId}
                  onSelectReceiver={(candidateId) => {
                    void controller.selectNearbyReceiver(candidateId);
                  }}
                  onRetryNfc={() => {
                    void controller.retryNfcDiscovery();
                  }}
                />
              </View>

              <View style={styles.section}>
                <TransferComposer
                  busy={controller.busy}
                  disabled={!controller.offlineReady || !controller.senderDiscovery.selectedReceiverId}
                  disabledReason={
                    !controller.offlineReady
                      ? t("send.offline.disabled")
                      : t("offline.receiver.required")
                  }
                  onSend={(amount) => controller.send(amount, "")}
                  maxOfflineAmount={offlineCapacityRequired && offlineCapacityMax > 0 ? offlineCapacityMax : undefined}
                  selectedReceiver={
                    controller.selectedNearbyReceiver
                      ? {
                          label:
                            controller.selectedNearbyReceiver.displayName ??
                            controller.selectedNearbyReceiver.deviceName ??
                            controller.selectedNearbyReceiver.walletAddress?.slice(0, 10) ??
                            controller.selectedNearbyReceiver.deviceId?.slice(0, 10) ??
                            t("offline.discovery.receiverFallback"),
                          helper:
                            controller.selectedNearbyReceiver.walletAddress ??
                            controller.selectedNearbyReceiver.deviceId ??
                            undefined,
                          mode: controller.selectedNearbyReceiver.mode,
                        }
                      : null
                  }
                  trustPreview={trustPreview}
                  trustWarning={trustWarning}
                  onConfirmTrustWarning={controller.confirmSendTrustWarning}
                  onDismissTrustWarning={controller.dismissSendTrustWarning}
                />
              </View>

              <PolicyPreview reserveAmount={reserveCapacityAmount} />
            </>
          )}
        </>
      )}
    </ScreenFrame>
  );
}

function WalletStatusCard(props: {
  solBalanceAmount: string;
  solBalanceApproximation?: string | null;
  promiseCapacityAmount: string;
  promiseCapacityApproximation?: string | null;
  reserveAmount: string;
  reserveApproximation?: string | null;
  offlineReady: boolean;
  offlineCapacityReady: boolean;
  pendingChainCount: number;
}) {
  const { t } = useI18n();

  return (
    <SurfaceCard variant="raised">
      <SectionHeader title={t("send.walletStatus.title")} />
      <View style={styles.summaryRow}>
        <View style={styles.summaryBlock}>
          <Text style={styles.summaryLabel}>{t("send.walletStatus.sol")}</Text>
          <Text style={styles.summaryValue}>{props.solBalanceAmount}</Text>
          {props.solBalanceApproximation ? <Text style={styles.summaryApproximation}>{props.solBalanceApproximation}</Text> : null}
        </View>
        <View style={styles.summaryBlock}>
          <Text style={styles.summaryLabel}>{t("send.walletStatus.offair")}</Text>
          <Text style={styles.summaryValue}>{props.promiseCapacityAmount}</Text>
          {props.promiseCapacityApproximation ? <Text style={styles.summaryApproximation}>{props.promiseCapacityApproximation}</Text> : null}
        </View>
        <View style={styles.summaryBlock}>
          <Text style={styles.summaryLabel}>{t("send.walletStatus.reserve")}</Text>
          <Text style={styles.summaryValue}>{props.reserveAmount}</Text>
          {props.reserveApproximation ? <Text style={styles.summaryApproximation}>{props.reserveApproximation}</Text> : null}
        </View>
      </View>
      <View style={styles.chipRow}>
        <StatusChip
          label={
            !props.offlineReady
              ? t("send.walletStatus.offlineLocked")
              : props.offlineCapacityReady
                ? t("send.walletStatus.offlineUnlocked")
                : t("send.walletStatus.capacityRequired")
          }
          tone={!props.offlineReady || !props.offlineCapacityReady ? "warning" : "success"}
        />
        <StatusChip
          label={t("send.walletStatus.queued", { count: props.pendingChainCount })}
          tone={props.pendingChainCount > 0 ? "info" : "muted"}
        />
      </View>
    </SurfaceCard>
  );
}

function ReserveCapacityCard(props: {
  amount: string;
  busy: boolean;
  onChangeAmount: (amount: string) => void;
  onFund: () => Promise<void>;
  onWithdraw: () => Promise<void>;
}) {
  const { t } = useI18n();
  const disabled = props.busy || !props.amount.trim();

  return (
    <SurfaceCard>
      <SectionHeader title={t("send.reserve.section")} />
      <Text style={styles.reserveBody}>{t("send.reserve.body")}</Text>
      <TextInput
        value={props.amount}
        onChangeText={props.onChangeAmount}
        style={styles.reserveInput}
        keyboardType="decimal-pad"
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={t("send.reserve.placeholder")}
        placeholderTextColor={palette.mutedStrong}
      />
      <ActionButton
        label={t("send.reserve.fund")}
        disabled={disabled}
        onPress={props.onFund}
      />
      <ActionRail
        items={[
          { id: "withdraw", label: t("send.reserve.withdraw"), icon: "corner-up-left", disabled },
        ]}
        onSelect={(id) => {
          if (id !== "withdraw") {
            return;
          }
          void props.onWithdraw();
        }}
      />
    </SurfaceCard>
  );
}

function PolicyPreview(props: { reserveAmount: string }) {
  const { t } = useI18n();

  return (
    <SurfaceCard style={styles.policyCard}>
      <SectionHeader title={t("send.policy.section")} />
      <View style={styles.policyGrid}>
        <PolicyItem icon="check-circle" label={t("send.policy.risk")} value={t("send.policy.riskApproved")} tone="success" />
        <PolicyItem icon="activity" label={t("send.policy.reserveImpact")} value={props.reserveAmount === "--" ? t("send.policy.reserveAcceptable") : `${props.reserveAmount} SOL`} />
        <PolicyItem icon="sliders" label={t("send.policy.exposure")} value={t("send.policy.exposureOk")} />
        <PolicyItem icon="clock" label={t("send.policy.expiration")} value={t("send.policy.expirationValue")} tone="warning" />
      </View>
      <View style={styles.lifecycleBlock}>
        <Text style={styles.lifecycleTitle}>{t("send.policy.lifecycle")}</Text>
        <View style={styles.lifecycleRow}>
          <LifecycleStep active label={t("send.policy.lifecycleSigned")} />
          <Feather name="arrow-right" size={14} color={palette.mutedStrong} />
          <LifecycleStep label={t("send.policy.lifecycleSync")} />
          <Feather name="arrow-right" size={14} color={palette.mutedStrong} />
          <LifecycleStep label={t("send.policy.lifecycleSettlement")} />
        </View>
      </View>
    </SurfaceCard>
  );
}

function PolicyItem(props: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
  tone?: "success" | "warning";
}) {
  const color = props.tone === "warning" ? palette.amber : props.tone === "success" ? palette.sky : palette.ink;

  return (
    <View style={styles.policyItem}>
      <View style={styles.policyLabelRow}>
        <Feather name={props.icon} size={14} color={color} />
        <Text style={styles.policyLabel}>{props.label}</Text>
      </View>
      <Text style={[styles.policyValue, { color }]}>{props.value}</Text>
    </View>
  );
}

function LifecycleStep(props: { label: string; active?: boolean }) {
  return (
    <View style={styles.lifecycleStep}>
      <View style={[styles.lifecycleLine, props.active ? styles.lifecycleLineActive : null]} />
      <Text style={[styles.lifecycleLabel, props.active ? styles.lifecycleLabelActive : null]}>{props.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    gap: 10,
    paddingTop: 8,
  },
  eyebrow: {
    ...typeRamp.label,
    color: palette.cyan,
  },
  headline: {
    ...typeRamp.headline,
  },
  copy: {
    ...typeRamp.body,
  },
  section: {
    gap: 16,
  },
  summaryRow: {
    flexDirection: "row",
    gap: 16,
  },
  summaryBlock: {
    flex: 1,
    gap: 4,
  },
  summaryLabel: {
    ...typeRamp.label,
  },
  summaryValue: {
    ...typeRamp.title,
    color: palette.sky,
  },
  summaryApproximation: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  reserveBody: {
    ...typeRamp.body,
  },
  reserveInput: {
    minHeight: 54,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    backgroundColor: palette.surface,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: palette.ink,
    ...typeRamp.bodyStrong,
  },
  reserveActions: {
    flexDirection: "row",
    gap: 12,
  },
  reserveButton: {
    flex: 1,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  helperText: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  policyCard: {
    gap: 16,
  },
  policyGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  policyItem: {
    width: "48%",
    minHeight: 76,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surfaceAlt,
    padding: 12,
    gap: 8,
  },
  policyLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  policyLabel: {
    ...typeRamp.caption,
    color: palette.muted,
    flex: 1,
  },
  policyValue: {
    ...typeRamp.bodyStrong,
  },
  lifecycleBlock: {
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: palette.line,
    paddingTop: 14,
  },
  lifecycleTitle: {
    ...typeRamp.label,
    color: palette.muted,
  },
  lifecycleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  lifecycleStep: {
    flex: 1,
    gap: 6,
  },
  lifecycleLine: {
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: palette.lineStrong,
  },
  lifecycleLineActive: {
    backgroundColor: palette.sky,
  },
  lifecycleLabel: {
    ...typeRamp.caption,
    color: palette.muted,
    textAlign: "center",
  },
  lifecycleLabelActive: {
    color: palette.ink,
  },
});
