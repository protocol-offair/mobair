import Feather from "@expo/vector-icons/Feather";
import { Modal, StyleSheet, Text, View } from "react-native";
import { useMemo, useState } from "react";

import { ReceiverPanel } from "../components/ReceiverPanel";
import { ActionRail } from "../components/ui/ActionRail";
import { AlertBanner } from "../components/ui/AlertBanner";
import { ActionButton } from "../components/ui/ActionButton";
import { AppTopBar } from "../components/ui/AppTopBar";
import { EmptyStateCard } from "../components/ui/EmptyStateCard";
import { QrPlaceholder } from "../components/ui/QrPlaceholder";
import { ScreenFrame } from "../components/ui/ScreenFrame";
import { SectionHeader } from "../components/ui/SectionHeader";
import { StatusChip } from "../components/ui/StatusChip";
import { SurfaceCard } from "../components/ui/SurfaceCard";
import type { AirPayWalletController } from "../hooks/useAirPayWallet";
import { formatAssetAmount } from "../i18n";
import { useI18n } from "../i18n/I18nProvider";
import { airPayTestIds } from "../testing/testIds";
import { palette, radii, typeRamp } from "../theme/palette";
import { getReceiveAddress } from "../view-models/screens";

export function ReceiveScreen(props: { controller: AirPayWalletController }) {
  const { controller } = props;
  const { t } = useI18n();
  const [modalVisible, setModalVisible] = useState(false);
  const trustSummary = controller.trustSummary;
  const latestTrustPeer = trustSummary?.recentPeers[0];
  const receiveAddress = getReceiveAddress(controller.wallet);
  const receiverDisabledReason = !controller.wallet?.manifest
    ? t("receive.disabled.manifest")
    : !controller.wallet.profile
      ? t("receive.disabled.profile")
    : controller.wallet.onboarding.quarantined
      ? t("receive.disabled.quarantined")
      : undefined;

  const latestIncoming = useMemo(
    () =>
      controller.wallet?.journal
        .filter((entry) => entry.receiverPseudoId === controller.wallet?.manifest?.deviceId)
        .slice()
        .reverse()[0],
    [controller.wallet],
  );

  return (
    <>
      <ScreenFrame>
        <AppTopBar
          statusLabel={t(`receiver.status.${controller.receiverState.status}`)}
          statusTone={
            controller.receiverState.status === "ready"
              ? "success"
              : controller.receiverState.status === "connected"
                ? "info"
                : controller.receiverState.status === "error"
                  ? "danger"
                  : "muted"
          }
          rightIcon="radio"
        />

        <View style={styles.hero}>
          <Text style={styles.eyebrow}>{t("receive.hero.eyebrow")}</Text>
          <Text style={styles.headline}>{t("receive.hero.title")}</Text>
        </View>

        {controller.error ? <AlertBanner tone="danger" message={controller.error} /> : null}
        {controller.receiverTrustNotice ? (
          <View style={styles.noticeBlock}>
            {controller.receiverTrustNotice.riskLabel ? (
              <StatusChip
                label={controller.receiverTrustNotice.riskLabel}
                tone={controller.receiverTrustNotice.riskTone ?? controller.receiverTrustNotice.tone}
              />
            ) : null}
            <AlertBanner
              testID={airPayTestIds.receiver.trustNotice}
              tone={controller.receiverTrustNotice.tone}
              message={controller.receiverTrustNotice.message}
            />
            {controller.receiverTrustNotice.helper ? (
              <Text style={styles.noticeHelper}>{controller.receiverTrustNotice.helper}</Text>
            ) : null}
          </View>
        ) : null}

        <View style={styles.centered}>
          <SurfaceCard variant="raised" style={styles.qrShell}>
            <View style={styles.qrPanel}>
              <QrPlaceholder value={receiveAddress} />
              <View style={styles.logoCenter}>
                <Feather name="wifi" size={22} color="#D7E6FF" />
              </View>
            </View>
          </SurfaceCard>
          <View style={styles.addressChip}>
            <Text style={styles.addressText}>{receiveAddress}</Text>
          </View>
          <Text style={styles.scanHelper}>{t("receive.local.scanHelper")}</Text>
        </View>

        <LocalStatusGrid
          nfcReady={Boolean(controller.wallet?.manifest?.transportCapabilities?.nfc)}
          bleListening={controller.receiverState.status === "ready" || controller.receiverState.status === "connected"}
          peerConnected={controller.receiverState.status === "connected"}
        />

        {!controller.wallet?.profile ? (
        <EmptyStateCard
            title={t("receive.addressUnavailable.title")}
            body={t("receive.addressUnavailable.body")}
            icon="user"
          />
        ) : null}

        <View style={styles.section}>
          <SectionHeader title={t("receive.discovery.section")} />
          <SurfaceCard>
            <View style={styles.discoveryHeader}>
              <View style={styles.discoveryBadge}>
                <Feather name="cpu" size={22} color={palette.cyan} />
              </View>
              <View style={styles.discoveryCopy}>
                <Text style={styles.discoveryTitle}>{t("receive.discovery.title")}</Text>
                <Text style={styles.discoveryText}>
                  {t("receive.discovery.body")}
                </Text>
              </View>
            </View>
            <View style={styles.discoveryStatuses}>
              <StatusChip
                label={controller.wallet?.onboarding.onChainProfileReady ? t("receive.discovery.deviceSynced") : t("receive.discovery.syncRequired")}
                tone={controller.wallet?.onboarding.onChainProfileReady ? "success" : "warning"}
              />
              <StatusChip
                label={controller.wallet?.manifest?.transportCapabilities?.nfc ? t("receive.discovery.nfcReady") : t("receive.discovery.bleOnly")}
                tone={controller.wallet?.manifest?.transportCapabilities?.nfc ? "info" : "muted"}
              />
            </View>
          </SurfaceCard>
        </View>

        <View style={styles.section}>
          <SectionHeader title={t("receive.trust.section")} />
          <SurfaceCard>
            <Text style={styles.discoveryText}>{t("receive.trust.body")}</Text>
            <View style={styles.discoveryStatuses}>
              <StatusChip
                label={t("send.trust.encounters", {
                  fresh: trustSummary?.freshPeers ?? 0,
                  recent: trustSummary?.recentPeersCount ?? 0,
                  stale: trustSummary?.stalePeers ?? 0,
                })}
                tone={trustSummary && trustSummary.freshPeers > 0 ? "success" : "muted"}
              />
              <StatusChip
                label={t("send.trust.operations", {
                  pending: trustSummary?.pendingPeers ?? 0,
                  recovering: trustSummary?.recoveringPeers ?? 0,
                  risky: trustSummary?.riskyPeers ?? 0,
                })}
                tone={trustSummary && trustSummary.riskyPeers > 0 ? "warning" : "muted"}
              />
              <StatusChip
                label={t("send.trust.sessions", {
                  verified: trustSummary?.verifiedPeers ?? 0,
                  mixed: trustSummary?.mixedPeers ?? 0,
                  fragile: trustSummary?.fragilePeers ?? 0,
                })}
                tone={trustSummary && trustSummary.fragilePeers > 0 ? "warning" : "muted"}
              />
              <StatusChip
                label={t("send.trust.risks", {
                  low: trustSummary?.lowRiskPeers ?? 0,
                  guarded: trustSummary?.guardedRiskPeers ?? 0,
                  high: trustSummary?.highRiskPeers ?? 0,
                  blocked: trustSummary?.blockedRiskPeers ?? 0,
                })}
                tone={trustSummary && (trustSummary.highRiskPeers > 0 || trustSummary.blockedRiskPeers > 0) ? "warning" : "muted"}
              />
              <StatusChip
                label={t("history.trust.cache.hot")}
                tone={trustSummary && trustSummary.hotPeers > 0 ? "info" : "muted"}
              />
              <StatusChip
                label={t("receive.trust.metrics", {
                  blacklist: trustSummary?.blacklistedPeers ?? 0,
                  checkpoints: trustSummary?.checkpoints ?? 0,
                })}
                tone={trustSummary && trustSummary.blacklistedPeers > 0 ? "warning" : "muted"}
              />
            </View>
            {latestTrustPeer ? (
              <AlertBanner
                tone={
                  latestTrustPeer.riskLevel === "blocked"
                    ? "danger"
                    : latestTrustPeer.riskLevel === "high" || latestTrustPeer.riskLevel === "guarded"
                      ? "warning"
                      : "info"
                }
                message={t("receive.trust.latest", {
                  peer: latestTrustPeer.peerId.slice(0, 10),
                  band: t(`history.trust.band.${latestTrustPeer.trustBand}`),
                  risk: t(`history.trust.risk.${latestTrustPeer.riskLevel}`),
                  encounter: t(`history.trust.encounter.${latestTrustPeer.encounterRecency}`),
                  signal: t(`history.trust.operational.${latestTrustPeer.operationalSignal}`),
                  quality: t(`history.trust.session.${latestTrustPeer.sessionQuality}`),
                })}
              />
            ) : null}
          </SurfaceCard>
        </View>

        <ReceiverPanel
          busy={controller.busy}
          disabled={Boolean(receiverDisabledReason)}
          disabledReason={receiverDisabledReason}
          status={controller.receiverState.status}
          message={controller.receiverState.message}
          sessionId={controller.receiverState.sessionId}
          onPrepare={controller.prepareReceiver}
          onStop={controller.stopReceiver}
        />

        {latestIncoming ? (
          <SurfaceCard variant="raised">
            <View style={styles.incomingHeader}>
              <View style={styles.incomingIcon}>
                <Feather name="download-cloud" size={18} color={palette.cyan} />
              </View>
              <StatusChip
                label={t(`common.risk.${latestIncoming.risk.band}`)}
                tone={latestIncoming.risk.band === "high" ? "danger" : "success"}
              />
            </View>
            <Text style={styles.incomingKicker}>{t("receive.latest.title")}</Text>
            <Text style={styles.incomingAmount} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
              {formatAssetAmount(latestIncoming.amount, latestIncoming.assetId)} {latestIncoming.assetId}
            </Text>
            <Text style={styles.incomingMeta}>{t("receive.latest.from", { sender: latestIncoming.senderPseudoId })}</Text>
            <ActionRail
              items={[
                { id: "review", label: t("receive.latest.cta"), icon: "eye" },
              ]}
              onSelect={(id) => {
                if (id === "review") {
                  setModalVisible(true);
                }
              }}
            />
          </SurfaceCard>
        ) : (
          <EmptyStateCard
            title={t("receive.latest.empty.title")}
            body={t("receive.latest.empty.body")}
            icon="download-cloud"
          />
        )}
      </ScreenFrame>

      <Modal animationType="fade" transparent visible={modalVisible} onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalBackdrop}>
          <SurfaceCard variant="raised" style={styles.modalCard}>
            <View style={styles.incomingHeader}>
              <View style={styles.incomingIcon}>
                <Feather name="credit-card" size={18} color={palette.cyan} />
              </View>
              <StatusChip
                label={latestIncoming ? t(`common.risk.${latestIncoming.risk.band}`) : t("viewModel.status.pending")}
                tone={latestIncoming?.risk.band === "high" ? "danger" : "success"}
              />
            </View>
            <Text style={styles.incomingKicker}>{t("receive.latest.title")}</Text>
            <Text style={styles.modalAmount} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
              {latestIncoming ? `${formatAssetAmount(latestIncoming.amount, latestIncoming.assetId)} ${latestIncoming.assetId}` : "--"}
            </Text>
            <Text style={styles.incomingMeta}>
              {t("receive.latest.from", {
                sender: latestIncoming?.senderPseudoId ?? t("common.state.unknown"),
              })}
            </Text>
            <Text style={styles.modalBody}>
              {t("receive.modal.body")}
            </Text>
            <ActionButton label={t("common.close")} onPress={() => setModalVisible(false)} />
          </SurfaceCard>
        </View>
      </Modal>
    </>
  );
}

function LocalStatusGrid(props: {
  nfcReady: boolean;
  bleListening: boolean;
  peerConnected: boolean;
}) {
  const { t } = useI18n();

  return (
    <View style={styles.localGrid}>
      <LocalStatusCard
        icon="radio"
        label={t("receive.local.nfc")}
        value={props.nfcReady ? t("receive.local.ready") : t("receive.discovery.bleOnly")}
        tone={props.nfcReady ? "success" : "muted"}
      />
      <LocalStatusCard
        icon="bluetooth"
        label={t("receive.local.ble")}
        value={props.bleListening ? t("receive.local.listening") : t("receiver.status.idle")}
        tone={props.bleListening ? "info" : "muted"}
        pulse={props.bleListening}
      />
      <LocalStatusCard
        icon="wifi"
        label={t("receive.local.peer")}
        value={props.peerConnected ? t("receiver.status.connected") : t("receive.local.disconnected")}
        tone={props.peerConnected ? "success" : "muted"}
      />
    </View>
  );
}

function LocalStatusCard(props: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
  tone: "success" | "info" | "muted";
  pulse?: boolean;
}) {
  const color = props.tone === "success" ? palette.sky : props.tone === "info" ? palette.cyan : palette.mutedStrong;

  return (
    <View style={styles.localStatusCard}>
      <View style={styles.localStatusIcon}>
        <Feather name={props.icon} size={17} color={color} />
      </View>
      <View style={styles.localStatusCopy}>
        <Text style={styles.localStatusLabel}>{props.label}</Text>
        <View style={styles.localStatusValueRow}>
          <Text style={[styles.localStatusValue, { color }]}>{props.value}</Text>
          {props.pulse ? <View style={[styles.localPulse, { backgroundColor: color }]} /> : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    alignItems: "center",
    gap: 8,
    paddingTop: 8,
  },
  eyebrow: {
    ...typeRamp.label,
    color: palette.cyan,
    textAlign: "center",
  },
  headline: {
    ...typeRamp.headline,
    textAlign: "center",
  },
  centered: {
    alignItems: "center",
    gap: 12,
  },
  noticeBlock: {
    gap: 8,
  },
  noticeHelper: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  qrShell: {
    padding: 24,
    alignItems: "center",
  },
  qrPanel: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  logoCenter: {
    position: "absolute",
    width: 48,
    height: 48,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.skySoft,
  },
  addressChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    backgroundColor: palette.surface,
  },
  addressText: {
    ...typeRamp.mono,
    color: palette.muted,
  },
  scanHelper: {
    ...typeRamp.caption,
    color: palette.muted,
    textAlign: "center",
    maxWidth: 280,
  },
  localGrid: {
    flexDirection: "row",
    gap: 8,
  },
  localStatusCard: {
    flex: 1,
    minHeight: 84,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
    padding: 12,
    gap: 8,
  },
  localStatusIcon: {
    width: 34,
    height: 34,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surfaceAlt,
  },
  localStatusCopy: {
    gap: 2,
  },
  localStatusLabel: {
    ...typeRamp.chip,
    color: palette.ink,
  },
  localStatusValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  localStatusValue: {
    ...typeRamp.caption,
  },
  localPulse: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
  },
  section: {
    gap: 16,
  },
  discoveryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
  },
  discoveryBadge: {
    width: 64,
    height: 64,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    backgroundColor: palette.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  discoveryCopy: {
    flex: 1,
    gap: 4,
  },
  discoveryTitle: {
    ...typeRamp.titleCompact,
  },
  discoveryText: {
    ...typeRamp.body,
  },
  discoveryStatuses: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  incomingHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  incomingIcon: {
    width: 42,
    height: 42,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.skySoft,
  },
  incomingKicker: {
    ...typeRamp.label,
  },
  incomingAmount: {
    ...typeRamp.display,
    fontSize: 34,
  },
  incomingMeta: {
    ...typeRamp.bodyStrong,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(16,20,26,0.88)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 384,
    gap: 18,
  },
  modalAmount: {
    ...typeRamp.display,
  },
  modalBody: {
    ...typeRamp.body,
    textAlign: "center",
  },
});
