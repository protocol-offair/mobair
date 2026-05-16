import type { PendingChainTransaction } from "@airpay/shared";

import type { LocalRiskLevel, SessionQuality, TrustCacheSummary, TrustBand, TrustCacheTier } from "../services/trust";
import type { WalletState } from "../services/wallet";
import { formatAssetAmount, formatDateTime, translate } from "../i18n";
import {
  formatApproximateAssetAmount,
  type ValueApproximationDisplayState,
} from "../services/valueApproximation";

export interface DashboardViewModel {
  clearedBalance: string;
  pendingBalance: string;
  pendingCount: number;
  chainQueueCount: number;
  offlineReady: boolean;
  readinessLabel: string;
}

export interface PendingPromiseViewModel {
  id: string;
  amountLabel: string;
  approxLabel?: string;
  expiryLabel: string;
  statusLabel: string;
}

export interface ActivityItemViewModel {
  id: string;
  title: string;
  subtitle: string;
  amountLabel: string;
  approxLabel?: string;
  statusLabel: string;
  direction: "credit" | "debit" | "neutral";
}

type SortableActivityItemViewModel = ActivityItemViewModel & {
  sortAt: string;
};

export interface HistoryViewModel {
  latestBatchLabel?: string;
  latestBatchStatus?: string;
  chainItems: PendingChainTransaction[];
  journalItems: WalletState["journal"];
  trust?: {
    hotPeers: number;
    warmPeers: number;
    coldPeers: number;
    blacklistedPeers: number;
    checkpoints: number;
    recentPeers: Array<{
      peerId: string;
      peerLabel: string;
      trustBand: TrustBand;
      trustBandLabel: string;
      cacheTier: TrustCacheTier;
      cacheTierLabel: string;
      sessionQuality: SessionQuality;
      sessionQualityLabel: string;
      riskLevel: LocalRiskLevel;
      riskLabel: string;
      riskScore: number;
      seenAtLabel: string;
    }>;
  };
}

function shorten(identifier: string, left = 6, right = 4) {
  if (identifier.length <= left + right + 3) {
    return identifier;
  }
  return `${identifier.slice(0, left)}...${identifier.slice(-right)}`;
}

function relativeStatusLabel(status: string) {
  switch (status) {
    case "reconciled":
    case "settled":
    case "confirmed":
      return translate("viewModel.status.cleared");
    case "rejected":
    case "failed":
      return translate("viewModel.status.needsReview");
    case "submitted":
    case "signed":
    case "queued":
      return translate("viewModel.status.syncing");
    default:
      return translate("viewModel.status.pending");
  }
}

function formatSolAmount(value: number): string {
  return `${formatAssetAmount(value, "SOL")} SOL`;
}

export function buildDashboardViewModel(
  wallet: WalletState | null,
  pendingAmount: number,
  pendingChainCount: number,
  offlineReady: boolean,
): DashboardViewModel {
  return {
    clearedBalance: wallet ? `${wallet.balances?.SOL?.amount ?? "0"} SOL` : "--",
    pendingBalance: formatSolAmount(pendingAmount),
    pendingCount: wallet?.journal.filter((entry) => entry.settlementStatus === "pending").length ?? 0,
    chainQueueCount: pendingChainCount,
    offlineReady,
    readinessLabel: wallet?.onboarding.quarantined
      ? translate("viewModel.readiness.quarantined")
      : offlineReady
        ? translate("viewModel.readiness.availableNow")
        : translate("viewModel.readiness.setupRequired"),
  };
}

export function buildPendingPromiseItems(
  wallet: WalletState | null,
  approximation?: ValueApproximationDisplayState,
): PendingPromiseViewModel[] {
  if (!wallet) {
    return [];
  }

  return wallet.journal
    .filter((entry) => entry.settlementStatus === "pending")
    .slice()
    .reverse()
    .slice(0, 3)
    .map((entry) => {
      const approxLabel = approximation ? formatApproximateAssetAmount(entry.amount, entry.assetId, approximation) : null;
      return {
        id: entry.localTxId,
        amountLabel: `+${formatAssetAmount(entry.amount, entry.assetId)} ${entry.assetId}`,
        approxLabel: approxLabel ?? undefined,
        expiryLabel: entry.receipt
          ? translate("viewModel.pending.receipt", { id: shorten(entry.receipt.receiptId, 8, 6) })
          : translate("viewModel.pending.awaitingSettlement"),
        statusLabel: relativeStatusLabel(entry.settlementStatus),
      };
    });
}

export function buildActivityItems(
  wallet: WalletState | null,
  approximation?: ValueApproximationDisplayState,
): ActivityItemViewModel[] {
  if (!wallet?.manifest) {
    return [];
  }

  const journalItems: SortableActivityItemViewModel[] = wallet.journal.map((entry) => {
    const incoming = entry.receiverPseudoId === wallet.manifest?.deviceId;
    return {
      id: entry.localTxId,
      title: incoming
        ? translate("viewModel.activity.from", { identifier: shorten(entry.senderPseudoId) })
        : translate("viewModel.activity.to", { identifier: shorten(entry.receiverPseudoId) }),
      subtitle: formatDateTime(entry.createdAt),
      amountLabel: `${incoming ? "+" : "-"}${formatAssetAmount(entry.amount, entry.assetId)} ${entry.assetId}`,
      approxLabel: approximation ? (formatApproximateAssetAmount(entry.amount, entry.assetId, approximation) ?? undefined) : undefined,
      statusLabel: relativeStatusLabel(entry.settlementStatus),
      direction: incoming ? "credit" : "debit",
      sortAt: entry.receipt?.receivedAt ?? entry.createdAt,
    };
  });

  const chainItems: SortableActivityItemViewModel[] = wallet.pendingChainTransactions.map((entry) => ({
    id: entry.intent.intentId,
    title: translate("viewModel.activity.solanaTransfer"),
    subtitle: shorten(entry.intent.toAddress, 10, 8),
    amountLabel: `-${formatAssetAmount(entry.intent.amount, entry.intent.assetId)} ${entry.intent.assetId}`,
    approxLabel: approximation
      ? (formatApproximateAssetAmount(entry.intent.amount, entry.intent.assetId, approximation) ?? undefined)
      : undefined,
    statusLabel: relativeStatusLabel(entry.status),
    direction: entry.status === "confirmed" ? "credit" : "neutral",
    sortAt: entry.confirmedAt ?? entry.submittedAt ?? entry.envelope.signedAt ?? entry.intent.createdAt,
  }));

  return [...journalItems, ...chainItems]
    .sort((left, right) => right.sortAt.localeCompare(left.sortAt))
    .slice(0, 8)
    .map(({ sortAt: _sortAt, ...item }) => item);
}

function trustBandLabel(trustBand: TrustBand) {
  switch (trustBand) {
    case "trusted":
      return translate("history.trust.band.trusted");
    case "watch":
      return translate("history.trust.band.watch");
    case "blocked":
      return translate("history.trust.band.blocked");
    default:
      return translate("history.trust.band.neutral");
  }
}

function trustCacheTierLabel(cacheTier: TrustCacheTier) {
  switch (cacheTier) {
    case "hot":
      return translate("history.trust.cache.hot");
    case "warm":
      return translate("history.trust.cache.warm");
    default:
      return translate("history.trust.cache.cold");
  }
}

function sessionQualityLabel(sessionQuality: SessionQuality) {
  switch (sessionQuality) {
    case "verified":
      return translate("history.trust.session.verified");
    case "mixed":
      return translate("history.trust.session.mixed");
    case "fragile":
      return translate("history.trust.session.fragile");
    default:
      return translate("history.trust.session.unknown");
  }
}

function localRiskLabel(riskLevel: LocalRiskLevel) {
  switch (riskLevel) {
    case "low":
      return translate("history.trust.risk.low");
    case "guarded":
      return translate("history.trust.risk.guarded");
    case "high":
      return translate("history.trust.risk.high");
    default:
      return translate("history.trust.risk.blocked");
  }
}

export function buildHistoryViewModel(wallet: WalletState | null, trustSummary?: TrustCacheSummary | null): HistoryViewModel {
  return {
    chainItems: wallet?.pendingChainTransactions ?? [],
    journalItems: wallet?.journal ?? [],
    trust: trustSummary
      ? {
          hotPeers: trustSummary.hotPeers,
          warmPeers: trustSummary.warmPeers,
          coldPeers: trustSummary.coldPeers,
          blacklistedPeers: trustSummary.blacklistedPeers,
          checkpoints: trustSummary.checkpoints,
          recentPeers: trustSummary.recentPeers.map((peer) => ({
            peerId: peer.peerId,
            peerLabel: shorten(peer.peerId, 10, 6),
            trustBand: peer.trustBand,
            trustBandLabel: trustBandLabel(peer.trustBand),
            cacheTier: peer.cacheTier,
            cacheTierLabel: trustCacheTierLabel(peer.cacheTier),
            sessionQuality: peer.sessionQuality,
            sessionQualityLabel: sessionQualityLabel(peer.sessionQuality),
            riskLevel: peer.riskLevel,
            riskLabel: localRiskLabel(peer.riskLevel),
            riskScore: peer.riskScore,
            seenAtLabel: formatDateTime(peer.lastSeenAt),
          })),
        }
      : undefined,
  };
}

export function getReceiveAddress(wallet: WalletState | null) {
  return wallet?.profile?.solanaAddress ?? translate("viewModel.receiveAddress.unavailable");
}
