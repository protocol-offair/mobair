import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";

import { ReadinessPanel } from "../components/ReadinessPanel";
import { WalletSetupPanel } from "../components/WalletSetupPanel";
import { ActivityRow } from "../components/ui/ActivityRow";
import { ActionRail } from "../components/ui/ActionRail";
import { ActionButton } from "../components/ui/ActionButton";
import { AlertBanner } from "../components/ui/AlertBanner";
import { AppTopBar } from "../components/ui/AppTopBar";
import { EmptyStateCard } from "../components/ui/EmptyStateCard";
import { ScreenFrame } from "../components/ui/ScreenFrame";
import { SectionHeader } from "../components/ui/SectionHeader";
import { SurfaceCard } from "../components/ui/SurfaceCard";
import type { AirPayWalletController } from "../hooks/useAirPayWallet";
import { airPayTestIds } from "../testing/testIds";
import { palette, radii, typeRamp } from "../theme/palette";
import { useI18n } from "../i18n/I18nProvider";
import { formatDateTime } from "../i18n";
import { buildActivityItems, buildDashboardViewModel, buildPendingPromiseItems } from "../view-models/screens";
import { useAppSettings } from "../settings/AppSettingsProvider";
import { formatApproximateAssetAmount } from "../services/valueApproximation";

export function HomeScreen(props: {
  controller: AirPayWalletController;
  onLogout: () => void;
  onOpenSend: () => void;
  onOpenReceive: () => void;
  onOpenHistory: () => void;
}) {
  const { controller } = props;
  const { t } = useI18n();
  const { approximation } = useAppSettings();
  const dashboard = buildDashboardViewModel(
    controller.wallet,
    controller.pendingAmount,
    controller.pendingChainCount,
    controller.offlineReady,
  );
  const pendingPromises = buildPendingPromiseItems(controller.wallet, approximation);
  const activity = buildActivityItems(controller.wallet, approximation).slice(0, 4);
  const clearedApproximation = controller.wallet?.balances?.SOL
    ? formatApproximateAssetAmount(controller.wallet.balances.SOL.amount, "SOL", approximation)
    : null;
  const backgroundRuntime = controller.backgroundRuntime;
  const lastAutoSync = backgroundRuntime.lastAutoSyncAt
    ? t("home.background.lastSync", { time: formatDateTime(backgroundRuntime.lastAutoSyncAt) })
    : t("home.background.noSync");
  const readinessRows = [
    {
      icon: "database" as const,
      label: t("home.readiness.localReserve"),
      value: controller.wallet?.onboarding.reserveReady ? t("home.readiness.allocated") : t("viewModel.status.pending"),
      done: Boolean(controller.wallet?.onboarding.reserveReady),
      tone: "success" as const,
    },
    {
      icon: "shield" as const,
      label: t("home.readiness.policy"),
      value: controller.wallet?.policy ? t("home.readiness.updated") : t("viewModel.status.pending"),
      done: Boolean(controller.wallet?.policy),
      tone: "success" as const,
    },
    {
      icon: "bluetooth" as const,
      label: t("home.readiness.transport"),
      value: t("home.readiness.waitingPeer"),
      done: Boolean(controller.wallet?.manifest),
      tone: "warning" as const,
    },
    {
      icon: "cloud" as const,
      label: t("home.readiness.backup"),
      value: controller.wallet?.profile?.backupConfirmedAt ? t("home.readiness.secure") : t("viewModel.status.pending"),
      done: Boolean(controller.wallet?.profile?.backupConfirmedAt),
      tone: "success" as const,
    },
  ];
  const readinessDone = readinessRows.filter((row) => row.done).length;
  const readinessProgress = readinessRows.length ? readinessDone / readinessRows.length : 0;

  return (
    <ScreenFrame>
      <AppTopBar
        statusLabel={controller.offlineReady ? t("common.status.ready") : t("common.status.setup")}
        statusTone={controller.offlineReady ? "info" : "warning"}
        rightIcon="log-out"
        onRightPress={props.onLogout}
      />

      {controller.error ? <AlertBanner testID={airPayTestIds.app.errorCard} tone="danger" message={controller.error} /> : null}

      <SurfaceCard variant="hero" style={styles.heroCard}>
        <View style={styles.heroHeader}>
          <Text testID={airPayTestIds.app.heroHeadline} style={styles.heroTitle}>
            {t("home.hero.title")}
          </Text>
          <View style={styles.heroIcon}>
            <Feather name="zap" size={22} color="rgba(184,243,90,0.68)" />
          </View>
        </View>
        <View style={styles.balanceLine}>
          <Text testID={airPayTestIds.app.heroEyebrow} style={styles.heroAmount}>
            {dashboard.clearedBalance}
          </Text>
          <Text testID={airPayTestIds.app.heroSubtitle} style={styles.heroSubtitle}>
            {t("home.hero.subtitle")}
          </Text>
          {clearedApproximation ? <Text style={styles.heroApproximation}>{clearedApproximation}</Text> : null}
        </View>
        <View style={styles.capacityBlock}>
          <View style={styles.capacityHeader}>
            <Text style={styles.capacityLabel}>{t("home.capacity.label")}</Text>
            <Text style={styles.capacityValue}>
              {controller.offlineReady
                ? t("home.capacity.ready")
                : t("home.capacity.progress", { done: readinessDone, total: readinessRows.length })}
            </Text>
          </View>
          <CapacityMeter progress={readinessProgress} />
        </View>
      </SurfaceCard>

      <View style={styles.primaryActionBlock}>
        <ActionButton
          label={t("home.primary.pay")}
          icon="send"
          disabled={!controller.wallet?.profile}
          onPress={props.onOpenSend}
        />
        <ActionRail
          items={[
            { id: "receive", label: t("home.action.receive"), icon: "download" },
            { id: "sync", label: t("home.action.sync"), icon: "refresh-cw", disabled: controller.busy || !controller.wallet?.profile },
            { id: "history", label: t("home.action.history"), icon: "clock" },
          ]}
          onSelect={(id) => {
            if (id === "receive") {
              props.onOpenReceive();
            } else if (id === "sync") {
              void controller.refreshProtocolState();
            } else {
              props.onOpenHistory();
            }
          }}
        />
      </View>

      <SurfaceCard>
        <SectionHeader title={t("readiness.title")} />
        <View style={styles.readinessList}>
          {readinessRows.map((row) => (
            <ProtocolReadinessRow key={row.label} {...row} />
          ))}
        </View>
      </SurfaceCard>

      <SurfaceCard>
        <SectionHeader title={t("home.background.section")} />
        <Text style={styles.backgroundBody}>{t("home.background.body")}</Text>
        <View style={styles.backgroundGrid}>
          <RuntimeStatusRow
            icon="activity"
            label={t("home.background.service")}
            value={backgroundRuntime.backgroundServiceRunning ? t("home.background.on") : t("home.background.off")}
            done={backgroundRuntime.backgroundServiceRunning}
          />
          <RuntimeStatusRow
            icon="layers"
            label={t("home.background.overlay")}
            value={backgroundRuntime.overlayPermissionGranted ? t("home.background.granted") : t("home.background.missing")}
            done={backgroundRuntime.overlayPermissionGranted}
          />
          <RuntimeStatusRow
            icon="bluetooth"
            label={t("home.background.bluetooth")}
            value={backgroundRuntime.bluetoothEnabled ? t("home.background.on") : t("home.background.off")}
            done={backgroundRuntime.bluetoothEnabled}
          />
          <RuntimeStatusRow
            icon="radio"
            label={t("home.background.nfc")}
            value={backgroundRuntime.nfcEnabled ? t("home.background.on") : t("home.background.off")}
            done={backgroundRuntime.nfcEnabled}
          />
          <RuntimeStatusRow
            icon="wifi"
            label={t("home.background.network")}
            value={backgroundRuntime.networkConnected === false ? t("home.background.disconnected") : t("home.background.connected")}
            done={backgroundRuntime.networkConnected !== false}
          />
        </View>
        <Text style={styles.backgroundMeta}>
          {backgroundRuntime.autoSyncInFlight ? t("home.background.syncing") : lastAutoSync}
        </Text>
        <ActionButton
          label={
            backgroundRuntime.backgroundServiceRunning
              ? t("home.background.disable")
              : t("home.background.enable")
          }
          icon={backgroundRuntime.backgroundServiceRunning ? "pause-circle" : "play-circle"}
          variant={backgroundRuntime.backgroundServiceRunning ? "secondary" : "primary"}
          disabled={controller.busy || !controller.wallet?.profile}
          onPress={() =>
            backgroundRuntime.backgroundServiceRunning
              ? controller.disableBackgroundRuntime()
              : controller.enableBackgroundRuntime()
          }
        />
        <ActionRail
          items={[
            { id: "sync", label: t("home.background.syncNow"), icon: "refresh-cw", disabled: controller.busy || !controller.wallet?.profile },
            {
              id: "overlay",
              label: backgroundRuntime.overlayVisible ? t("home.background.overlayOff") : t("home.background.overlayOn"),
              icon: "move",
              disabled: controller.busy || !backgroundRuntime.overlayPermissionGranted,
            },
            {
              id: "bluetooth",
              label: backgroundRuntime.bluetoothEnabled ? t("home.background.bluetoothSettings") : t("home.background.bluetoothEnable"),
              icon: "bluetooth",
              disabled: controller.busy,
            },
            { id: "nfc", label: t("home.background.nfcSettings"), icon: "radio", disabled: controller.busy },
          ]}
          onSelect={(id) => {
            if (id === "sync") {
              void controller.runAutomaticSync();
            } else if (id === "overlay") {
              void (backgroundRuntime.overlayVisible ? controller.hideBackgroundOverlay() : controller.showBackgroundOverlay());
            } else if (id === "bluetooth") {
              void (backgroundRuntime.bluetoothEnabled ? controller.openBluetoothSettings() : controller.requestBluetoothActivation());
            } else {
              void controller.openNfcSettings();
            }
          }}
        />
      </SurfaceCard>

      <SurfaceCard style={styles.pendingCard}>
        <View style={styles.pendingHeader}>
          <View>
            <Text style={styles.kickerMuted}>{t("home.pending.title")}</Text>
            <Text style={styles.pendingAmount}>{dashboard.pendingBalance}</Text>
          </View>
          <View style={styles.pendingIcon}>
            <Feather name="rotate-ccw" size={18} color={palette.cyan} />
          </View>
        </View>
        <View style={styles.pendingFooter}>
          <View style={styles.promiseDots}>
            <View style={styles.promiseDotPrimary} />
            <View style={styles.promiseDotSecondary} />
          </View>
          <Text style={styles.promiseLabel}>{t("home.pending.promises", { count: dashboard.pendingCount })}</Text>
        </View>
      </SurfaceCard>

      <WalletSetupPanel
        busy={controller.busy}
        profile={controller.wallet?.profile ?? null}
        security={controller.wallet?.security ?? null}
        walletRegistry={controller.wallet?.walletRegistry ?? []}
        balances={controller.wallet?.balances}
        onboarding={controller.wallet?.onboarding ?? null}
        offlineReady={controller.offlineReady}
        mnemonicPreview={controller.mnemonicPreview}
        onCreate={controller.createWallet}
        onImport={controller.importWallet}
        onSelectWallet={controller.selectWallet}
        onReveal={controller.revealMnemonic}
        onConfirmBackup={controller.confirmBackup}
        onRefresh={controller.refreshBalances}
        onRefreshProtocolState={controller.refreshProtocolState}
        onDismissMnemonic={controller.dismissMnemonicPreview}
      />

      <ReadinessPanel
        onboarding={controller.wallet?.onboarding ?? null}
        hasWallet={Boolean(controller.wallet?.profile)}
        backupConfirmed={Boolean(controller.wallet?.profile?.backupConfirmedAt)}
        offlineReady={controller.offlineReady}
        pendingChainCount={controller.pendingChainCount}
        executionMode={
          controller.wallet?.onboarding.onChainProfileReady
            ? t("readiness.mode.rpc")
            : t("readiness.mode.localOnly")
        }
      />

      <ActionRail
        items={[
          { id: "balances", label: t("wallet.refreshBalances"), icon: "refresh-cw", disabled: controller.busy || !controller.wallet?.profile },
          { id: "protocol", label: t("wallet.syncProtocol"), icon: "cloud", disabled: controller.busy || !controller.wallet?.profile },
          { id: "reset", label: t("home.reset"), icon: "trash-2" },
        ]}
        onSelect={(id) => {
          if (id === "balances") {
            void controller.refreshBalances();
          } else if (id === "protocol") {
            void controller.refreshProtocolState();
          } else {
            void controller.reset();
          }
        }}
      />

      <View style={styles.section}>
        <SectionHeader title={t("home.pending.section")} actionLabel={t("home.action.history")} onActionPress={props.onOpenHistory} />
        {pendingPromises.length === 0 ? (
          <EmptyStateCard title={t("home.pending.empty.title")} body={t("home.pending.empty.body")} />
        ) : (
          pendingPromises.map((item) => (
            <SurfaceCard key={item.id} style={styles.promiseCard}>
              <View style={styles.promiseRow}>
                <View style={styles.promiseMeta}>
                  <View style={styles.promiseBadge}>
                    <Feather name="clock" size={16} color={palette.amberSoft} />
                  </View>
                  <View style={styles.promiseTextWrap}>
                    <Text style={styles.promiseTitle}>{t("home.pending.promiseId", { id: item.id.slice(-6) })}</Text>
                    <Text style={styles.promiseMetaText}>{item.expiryLabel}</Text>
                  </View>
                </View>
                <View style={styles.promiseAmountWrap}>
                  <Text style={styles.promiseAmount}>{item.amountLabel}</Text>
                  {item.approxLabel ? <Text style={styles.promiseApproximation}>{item.approxLabel}</Text> : null}
                  <Text style={styles.promiseStatus}>{item.statusLabel}</Text>
                </View>
              </View>
            </SurfaceCard>
          ))
        )}
      </View>

      <View style={styles.section}>
        <SectionHeader title={t("home.activity.section")} />
        {activity.length === 0 ? (
          <EmptyStateCard
            testID={airPayTestIds.app.journalEmpty}
            title={t("home.activity.empty.title")}
            body={t("home.activity.empty.body")}
          />
        ) : (
          <SurfaceCard style={styles.activityCard}>
            {activity.map((item) => (
              <ActivityRow key={item.id} {...item} />
            ))}
          </SurfaceCard>
        )}
      </View>
    </ScreenFrame>
  );
}

function CapacityMeter(props: { progress: number }) {
  const progress = Math.max(0.08, Math.min(props.progress, 1));
  const animated = useRef(new Animated.Value(progress)).current;

  useEffect(() => {
    Animated.timing(animated, {
      toValue: progress,
      duration: 420,
      useNativeDriver: false,
    }).start();
  }, [animated, progress]);

  const width = animated.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  return (
    <View style={styles.capacityTrack}>
      <Animated.View style={[styles.capacityFill, { width }]} />
    </View>
  );
}

function ProtocolReadinessRow(props: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
  done: boolean;
  tone: "success" | "warning";
}) {
  const color = props.done ? palette.sky : props.tone === "warning" ? palette.amber : palette.muted;

  return (
    <View style={styles.readinessRow}>
      <View style={styles.readinessMeta}>
        <Feather name={props.done ? "check-circle" : props.icon} size={18} color={color} />
        <Text style={styles.readinessLabel}>{props.label}</Text>
      </View>
      <Text style={[styles.readinessValue, { color }]}>{props.value}</Text>
    </View>
  );
}

function RuntimeStatusRow(props: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
  done: boolean;
}) {
  const color = props.done ? palette.sky : palette.amber;

  return (
    <View style={styles.runtimeRow}>
      <View style={[styles.runtimeIcon, { borderColor: `${color}55` }]}>
        <Feather name={props.done ? "check" : props.icon} size={16} color={color} />
      </View>
      <View style={styles.runtimeCopy}>
        <Text style={styles.runtimeLabel}>{props.label}</Text>
        <Text style={[styles.runtimeValue, { color }]}>{props.value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  heroCard: {
    minHeight: 188,
    overflow: "hidden",
  },
  heroHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
  },
  heroTitle: {
    ...typeRamp.headline,
    color: "#FFFFFF",
  },
  kicker: {
    ...typeRamp.label,
    color: "rgba(247,255,232,0.82)",
  },
  kickerMuted: {
    ...typeRamp.label,
  },
  heroAmount: {
    ...typeRamp.display,
    color: "#B8F35A",
  },
  heroSubtitle: {
    ...typeRamp.caption,
    color: "rgba(247,255,232,0.84)",
    maxWidth: 260,
  },
  heroApproximation: {
    ...typeRamp.caption,
    color: "rgba(55,214,202,0.92)",
  },
  balanceLine: {
    gap: 2,
  },
  heroIcon: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  capacityBlock: {
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.16)",
    paddingTop: 14,
  },
  capacityHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  capacityLabel: {
    ...typeRamp.chip,
    color: "rgba(255,255,255,0.64)",
  },
  capacityValue: {
    ...typeRamp.chip,
    color: "#B8F35A",
  },
  capacityTrack: {
    height: 7,
    borderRadius: radii.pill,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  capacityFill: {
    height: "100%",
    borderRadius: radii.pill,
    backgroundColor: "#B8F35A",
  },
  pendingCard: {
    paddingTop: 18,
    paddingBottom: 18,
  },
  pendingHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  pendingAmount: {
    ...typeRamp.headline,
    fontSize: 24,
    lineHeight: 32,
    letterSpacing: 0,
  },
  pendingIcon: {
    width: 42,
    height: 42,
    borderRadius: radii.md,
    backgroundColor: palette.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  pendingFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  primaryActionBlock: {
    gap: 14,
  },
  promiseDots: {
    flexDirection: "row",
    alignItems: "center",
  },
  promiseDotPrimary: {
    width: 24,
    height: 24,
    borderRadius: radii.pill,
    backgroundColor: palette.sky,
    borderWidth: 1,
    borderColor: palette.background,
  },
  promiseDotSecondary: {
    width: 24,
    height: 24,
    borderRadius: radii.pill,
    backgroundColor: palette.cyan,
    borderWidth: 1,
    borderColor: palette.background,
    marginLeft: -8,
  },
  promiseLabel: {
    ...typeRamp.caption,
    color: palette.ink,
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
  },
  actionButton: {
    flex: 1,
  },
  utilityRow: {
    flexDirection: "row",
  },
  utilityButton: {
    flex: 1,
  },
  section: {
    gap: 16,
  },
  reconcileRow: {
    flexDirection: "row",
    gap: 12,
  },
  reconcileButton: {
    flex: 1,
  },
  resetButton: {
    minWidth: 104,
  },
  actionGrid: {
    flexDirection: "row",
    gap: 8,
  },
  quickTile: {
    flex: 1,
    minHeight: 86,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
    paddingHorizontal: 6,
    paddingVertical: 10,
  },
  quickTileActive: {
    borderColor: "rgba(14,111,59,0.22)",
    backgroundColor: "#F0FAE8",
  },
  quickTilePressed: {
    opacity: 0.9,
    transform: [{ scale: 0.97 }],
  },
  quickTileDisabled: {
    opacity: 0.45,
  },
  quickIcon: {
    width: 42,
    height: 42,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surfaceAlt,
  },
  quickIconActive: {
    backgroundColor: palette.sky,
  },
  quickLabel: {
    ...typeRamp.chip,
    color: palette.ink,
    textAlign: "center",
  },
  readinessList: {
    gap: 0,
  },
  readinessRow: {
    minHeight: 48,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.line,
  },
  readinessMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  readinessLabel: {
    ...typeRamp.bodyStrong,
    color: palette.ink,
  },
  readinessValue: {
    ...typeRamp.chip,
    textAlign: "right",
  },
  backgroundBody: {
    ...typeRamp.body,
    color: palette.muted,
  },
  backgroundGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  runtimeRow: {
    minWidth: "47%",
    flex: 1,
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  runtimeIcon: {
    width: 30,
    height: 30,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  runtimeCopy: {
    flex: 1,
    gap: 2,
  },
  runtimeLabel: {
    ...typeRamp.chip,
    color: palette.ink,
  },
  runtimeValue: {
    ...typeRamp.caption,
  },
  backgroundMeta: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  backgroundActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  backgroundPrimaryAction: {
    flexGrow: 1,
    minWidth: 132,
  },
  backgroundSecondaryAction: {
    flexGrow: 1,
    minWidth: 132,
  },
  backgroundTertiaryAction: {
    flexGrow: 1,
    minWidth: 112,
  },
  promiseCard: {
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  promiseRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
  },
  promiseMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    flex: 1,
  },
  promiseBadge: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surfaceAlt,
  },
  promiseTextWrap: {
    gap: 2,
    flex: 1,
  },
  promiseTitle: {
    ...typeRamp.bodyStrong,
  },
  promiseMetaText: {
    ...typeRamp.caption,
    fontFamily: "monospace",
  },
  promiseAmountWrap: {
    alignItems: "flex-end",
    maxWidth: "42%",
  },
  promiseAmount: {
    ...typeRamp.bodyStrong,
    color: palette.amber,
    textAlign: "right",
  },
  promiseApproximation: {
    ...typeRamp.caption,
    color: palette.muted,
    textAlign: "right",
  },
  promiseStatus: {
    ...typeRamp.chip,
    color: palette.amber,
  },
  activityCard: {
    paddingVertical: 0,
  },
  batchCard: {
    gap: 8,
  },
  batchTitle: {
    ...typeRamp.titleCompact,
  },
  batchMeta: {
    ...typeRamp.body,
  },
});
