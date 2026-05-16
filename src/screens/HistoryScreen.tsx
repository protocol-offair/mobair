import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { validateJournal } from "@protocol-offair/shared";

import { JournalCard } from "../components/JournalCard";
import { PendingChainCard } from "../components/PendingChainCard";
import { ActivityRow } from "../components/ui/ActivityRow";
import { ActionRail } from "../components/ui/ActionRail";
import { AlertBanner } from "../components/ui/AlertBanner";
import { AppTopBar } from "../components/ui/AppTopBar";
import { EmptyStateCard } from "../components/ui/EmptyStateCard";
import { ScreenFrame } from "../components/ui/ScreenFrame";
import { SectionHeader } from "../components/ui/SectionHeader";
import { SurfaceCard } from "../components/ui/SurfaceCard";
import type { AirPayWalletController } from "../hooks/useAirPayWallet";
import { useI18n } from "../i18n/I18nProvider";
import { useAppSettings } from "../settings/AppSettingsProvider";
import { airPayTestIds } from "../testing/testIds";
import { palette, radii, typeRamp } from "../theme/palette";
import { buildActivityItems, buildHistoryViewModel } from "../view-models/screens";

export function HistoryScreen(props: { controller: AirPayWalletController }) {
  const { controller } = props;
  const { t } = useI18n();
  const { approximation } = useAppSettings();
  const [activeFilter, setActiveFilter] = useState<"all" | "promises" | "claims" | "sync" | "risk">("all");
  const history = buildHistoryViewModel(controller.wallet, controller.trustSummary);
  const activity = buildActivityItems(controller.wallet, approximation);
  const journalValidation = validateJournal(history.journalItems);
  const journalRootLabel = `sha256:${journalValidation.root.slice(0, 16)}...${journalValidation.root.slice(-8)}`;
  const filterItems = [
    { id: "all" as const, label: t("history.filters.all"), icon: "list" as const },
    { id: "promises" as const, label: t("history.filters.promises"), icon: "file-text" as const },
    { id: "claims" as const, label: t("history.filters.claims"), icon: "check-circle" as const },
    { id: "sync" as const, label: t("history.filters.sync"), icon: "refresh-cw" as const },
    { id: "risk" as const, label: t("history.filters.risk"), icon: "shield" as const },
  ];
  const legalSections = [
    {
      title: t("history.legal.promises.title"),
      body: t("history.legal.promises.body"),
      tone: "default" as const,
    },
    {
      title: t("history.legal.clearing.title"),
      body: t("history.legal.clearing.body"),
      tone: "default" as const,
    },
    {
      title: t("history.legal.nonGuarantee.title"),
      body: t("history.legal.nonGuarantee.body"),
      tone: "danger" as const,
    },
  ];

  return (
    <ScreenFrame>
      <AppTopBar
        statusLabel={controller.wallet?.onboarding.quarantined ? t("common.status.quarantined") : t("common.status.auditTrail")}
        statusTone={controller.wallet?.onboarding.quarantined ? "danger" : "muted"}
        rightIcon="shield"
      />

      <View style={styles.hero}>
        <Text style={styles.headline}>
          {t("history.hero.title.prefix")}
          <Text style={styles.headlineAccent}>{t("history.hero.title.highlight")}</Text>
        </Text>
        <Text style={styles.copy}>
          {t("history.hero.body")}
        </Text>
      </View>

      {controller.error ? <AlertBanner tone="danger" message={controller.error} /> : null}

      <ActionRail
        activeId={activeFilter}
        items={filterItems}
        onSelect={setActiveFilter}
      />

      <View style={styles.section}>
        <SectionHeader title={t("history.activity.section")} />
        {activity.length === 0 ? (
          <EmptyStateCard title={t("history.activity.empty.title")} body={t("history.activity.empty.body")} />
        ) : (
          <SurfaceCard style={styles.activityCard}>
            {activity.slice(0, 6).map((item) => (
              <ActivityRow key={item.id} {...item} />
            ))}
          </SurfaceCard>
        )}
      </View>

      <View style={styles.section}>
        <SectionHeader title={t("history.trust.section")} />
        {history.trust && (history.trust.hotPeers + history.trust.warmPeers + history.trust.coldPeers > 0 || history.trust.blacklistedPeers > 0) ? (
          <SurfaceCard style={styles.trustCard}>
            <View style={styles.trustMetricsRow}>
              <View style={styles.trustMetric}>
                <Text style={styles.trustMetricLabel}>{t("history.trust.cache.hot")}</Text>
                <Text style={styles.trustMetricValue}>{history.trust.hotPeers}</Text>
              </View>
              <View style={styles.trustMetric}>
                <Text style={styles.trustMetricLabel}>{t("history.trust.cache.warm")}</Text>
                <Text style={styles.trustMetricValue}>{history.trust.warmPeers}</Text>
              </View>
              <View style={styles.trustMetric}>
                <Text style={styles.trustMetricLabel}>{t("history.trust.cache.cold")}</Text>
                <Text style={styles.trustMetricValue}>{history.trust.coldPeers}</Text>
              </View>
            </View>
            <Text style={styles.trustMeta}>
              {t("history.trust.meta", {
                blacklist: history.trust.blacklistedPeers,
                checkpoints: history.trust.checkpoints,
              })}
            </Text>
            {history.trust.recentPeers.length > 0 ? (
              <View style={styles.trustRecentList}>
                {history.trust.recentPeers.map((peer) => (
                  <View key={peer.peerId} style={styles.trustRecentRow}>
                    <View style={styles.trustRecentCopy}>
                      <Text style={styles.trustRecentTitle}>{peer.peerLabel}</Text>
                      <Text style={styles.trustRecentSubtitle}>{peer.seenAtLabel}</Text>
                    </View>
                    <View style={styles.trustRecentBadges}>
                      <Text style={styles.trustBadge}>{peer.cacheTierLabel}</Text>
                      <Text style={styles.trustBadge}>{peer.sessionQualityLabel}</Text>
                      <Text style={styles.trustBadge}>{peer.riskLabel}</Text>
                      <Text style={styles.trustBadgeAccent}>{peer.trustBandLabel}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
          </SurfaceCard>
        ) : (
          <EmptyStateCard title={t("history.trust.empty.title")} body={t("history.trust.empty.body")} icon="shield" />
        )}
      </View>

      <View style={styles.section}>
        <SectionHeader title={t("history.chain.section")} />
        {history.chainItems.length === 0 ? (
          <EmptyStateCard testID={airPayTestIds.app.pendingChainEmpty} title={t("history.chain.empty.title")} body={t("history.chain.empty.body")} icon="link" />
        ) : (
          history.chainItems.map((item) => <PendingChainCard key={item.intent.intentId} transaction={item} />)
        )}
      </View>

      <SurfaceCard style={styles.journalEvidenceCard}>
        <View style={styles.journalEvidenceHeader}>
          <View style={styles.journalEvidenceIcon}>
            <Feather name="shield" size={18} color={palette.sky} />
          </View>
          <Text style={styles.journalEvidenceTitle}>{t("history.journalEvidence.title")}</Text>
        </View>
        <View style={styles.journalEvidenceHash}>
          <Text style={styles.journalEvidenceHashLabel}>{t("history.journalEvidence.hash")}</Text>
          <Text style={styles.journalEvidenceHashValue}>{journalRootLabel}</Text>
        </View>
        <Text style={styles.journalEvidenceBody}>{t("history.journalEvidence.body")}</Text>
      </SurfaceCard>

      <View style={styles.section}>
        <SectionHeader title={t("history.journal.section")} />
        {history.journalItems.length === 0 ? (
          <EmptyStateCard testID={airPayTestIds.app.journalEmpty} title={t("history.journal.empty.title")} body={t("history.journal.empty.body")} icon="book-open" />
        ) : (
          history.journalItems.map((item) => <JournalCard key={item.localTxId} transfer={item} />)
        )}
      </View>

      <View style={styles.section}>
        {legalSections.map((section) => (
          <SurfaceCard key={section.title} variant={section.tone}>
            <Text style={[styles.legalTitle, section.tone === "danger" && styles.legalTitleDanger]}>{section.title}</Text>
            <Text style={styles.legalBody}>{section.body}</Text>
          </SurfaceCard>
        ))}
      </View>

      <SurfaceCard style={styles.footerCard}>
        <Text style={styles.footerKicker}>{t("history.footer.version")}</Text>
        <Text style={styles.footerLinks}>{t("history.footer.links")}</Text>
      </SurfaceCard>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  hero: {
    gap: 12,
    paddingTop: 8,
  },
  headline: {
    ...typeRamp.display,
    lineHeight: 45,
  },
  headlineAccent: {
    color: palette.cyan,
  },
  copy: {
    ...typeRamp.body,
    fontSize: 18,
    lineHeight: 29,
  },
  section: {
    gap: 16,
  },
  activityCard: {
    paddingVertical: 0,
  },
  trustCard: {
    gap: 16,
  },
  trustMetricsRow: {
    flexDirection: "row",
    gap: 12,
  },
  trustMetric: {
    flex: 1,
    gap: 4,
    borderRadius: radii.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: palette.surfaceAlt,
  },
  trustMetricLabel: {
    ...typeRamp.chip,
    color: palette.muted,
  },
  trustMetricValue: {
    ...typeRamp.title,
  },
  trustMeta: {
    ...typeRamp.body,
    fontSize: 14,
    lineHeight: 22,
  },
  trustRecentList: {
    gap: 10,
  },
  trustRecentRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
  },
  trustRecentCopy: {
    flex: 1,
    gap: 2,
  },
  trustRecentTitle: {
    ...typeRamp.bodyStrong,
  },
  trustRecentSubtitle: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  trustRecentBadges: {
    flexDirection: "row",
    gap: 8,
  },
  trustBadge: {
    ...typeRamp.chip,
    color: palette.muted,
  },
  trustBadgeAccent: {
    ...typeRamp.chip,
    color: palette.cyan,
  },
  batchKicker: {
    ...typeRamp.label,
  },
  batchTitle: {
    ...typeRamp.title,
  },
  batchBody: {
    ...typeRamp.body,
  },
  journalEvidenceCard: {
    gap: 14,
  },
  journalEvidenceHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  journalEvidenceIcon: {
    width: 38,
    height: 38,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.skySoft,
  },
  journalEvidenceTitle: {
    ...typeRamp.titleCompact,
  },
  journalEvidenceHash: {
    gap: 6,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surfaceAlt,
    padding: 12,
  },
  journalEvidenceHashLabel: {
    ...typeRamp.label,
    color: palette.muted,
  },
  journalEvidenceHashValue: {
    ...typeRamp.mono,
    color: palette.ink,
  },
  journalEvidenceBody: {
    ...typeRamp.body,
  },
  legalTitle: {
    ...typeRamp.titleCompact,
  },
  legalTitleDanger: {
    color: palette.coral,
  },
  legalBody: {
    ...typeRamp.body,
    fontSize: 16,
    lineHeight: 26,
  },
  footerCard: {
    alignItems: "center",
    gap: 16,
  },
  footerKicker: {
    ...typeRamp.chip,
    color: "rgba(194,198,212,0.5)",
    textAlign: "center",
  },
  footerLinks: {
    ...typeRamp.bodyStrong,
    color: palette.sky,
    fontSize: 12,
  },
});
