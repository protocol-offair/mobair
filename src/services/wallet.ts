import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { PublicKey } from "@solana/web3.js";

import {
  appendReceipt,
  buildBaseRoot,
  buildOffAirClaimSigningPayload,
  buildReputationEnvelope,
  canApproveOfflineTransfer,
  computeReputationExposureMultiplier,
  createNonce,
  createOfflineTransfer,
  DEFAULT_FAST_OFFLINE_HIGH_TRUST_LIMIT_LAMPORTS,
  DEFAULT_FAST_OFFLINE_NEW_USER_LIMIT_LAMPORTS,
  DEFAULT_FAST_OFFLINE_TRUSTED_LIMIT_LAMPORTS,
  DEFAULT_VERIFIED_OFFLINE_MIN_LAMPORTS,
  OFFLINE_SETTLEMENT_MODE_FAST,
  OFFLINE_SETTLEMENT_MODE_VERIFIED,
  evaluateDeviceIntegrity,
  getDeviceAdjustedOfflineAmountLimit,
  lineageRequiresVerifiedOnly,
  scoreRisk,
  sha256Hex,
} from "@protocol-offair/shared";
import type {
  AllowlistPolicy,
  AssetBalance,
  DeviceManifest,
  OfflineBudget,
  OfflineSettlementTier,
  OfflineTransfer,
  PendingChainTransaction,
  SessionSettlementMode,
  TransferReceipt,
  PromiseSignatureBundle,
  PromiseSignatureRole,
  RiskSnapshot,
  ReputationEnvelope,
  WalletProfile,
  WalletRegistryEntry,
  WalletSecurityState,
} from "@protocol-offair/shared";

import {
  fetchLatestBlockhash,
  fetchSignatureStatuses,
  fetchWalletBalances,
  getWalletRuntimeConfig,
  probeRpcReachability,
  submitPendingChainTransaction,
} from "./chain";
import {
  fetchCurrentPolicyFromBackend,
  fetchPendingChainTransactionsFromBackend,
  provisionOfflineBudgetWithBackend,
  registerDeviceWithBackend,
  registerWalletWithBackend,
} from "./backend";
import {
  clearWalletVault,
  createMnemonicWallet,
  createWalletPromiseSignatures,
  getWalletSecuritySnapshot,
  importMnemonicWallet,
  importWalletCertificateFromBase64,
  loadWalletMetadata,
  loadWalletRegistry,
  prepareSignedSolanaTransfer,
  revealMnemonic,
  setActiveWallet,
  updateBackupConfirmation,
} from "./custody";
import { buildDeviceManifest, getDefaultTransportIds } from "./integrity";
import {
  claimPromiseOnChain,
  ensureWalletProtocolState,
  fetchReserveBalance,
  fundReserve as fundReserveOnChain,
  parseUiAmountToLamports,
  processIncomingPromises,
  settlePromiseOnChain,
  withdrawReserve as withdrawReserveOnChain,
} from "./offair";
import { bootstrapOfflineSession, closeTransportSession, transmitOfflineTransfer, type ActiveTransportSession } from "./transport";
import {
  evaluatePeerTrustDecision,
  findPeerTrustPreview,
  loadLocalTrustState,
  mutateLocalTrustState,
  recordPeerInteraction,
  type LocalRiskLevel,
  type PeerTrustPreview,
  type TrustBand,
} from "./trust";
import { signPayload } from "./native/AirPayNative";
import { translate, formatDateTime } from "../i18n";

const WALLET_STORAGE_KEY = "airpay.wallet.state";
const SECRET_STORAGE_KEY = "airpay.wallet.secret";
const WALLET_STORAGE_RESET_VERSION = 3;
const WALLET_STORAGE_RESET_VERSION_KEY = "airpay.wallet.storage.resetVersion";
const REMOTE_DEVICE_RESET_PENDING_KEY = "airpay.wallet.remoteReset.pending";
const MVP_LOCAL_PROMISE_MAX_SOL = 0.05;

type DeferredWalletStatusKey =
  | "service.wallet.status.walletCreatedDeferred"
  | "service.wallet.status.walletImportedDeferred";

export interface OnboardingState {
  rpcReachable: boolean;
  deviceKeyReady: boolean;
  onChainProfileReady: boolean;
  reserveReady: boolean;
  quarantined: boolean;
  executionSource: "local" | "rpc";
  lastProtocolSyncAt?: string;
  lastReserveCheckAt?: string;
}

export interface WalletSnapshot {
  profile: WalletProfile;
  security: WalletSecurityState;
  balances: Record<"OFFAIR" | "SOL", AssetBalance>;
  pendingChainTransactions: PendingChainTransaction[];
  onboarding: OnboardingState;
  reserve: OfflineBudget;
  journal: OfflineTransfer[];
}

export interface WalletState {
  manifest: DeviceManifest | null;
  policy: AllowlistPolicy;
  statusLog: string[];
  walletRegistry: WalletRegistryEntry[];
  walletSnapshots: Record<string, WalletSnapshot>;
  activeWalletId: string | null;
  profile: WalletProfile | null;
  security: WalletSecurityState;
  balances: Record<"OFFAIR" | "SOL", AssetBalance>;
  pendingChainTransactions: PendingChainTransaction[];
  onboarding: OnboardingState;
  reserve: OfflineBudget;
  journal: OfflineTransfer[];
}

export interface SendTrustWarningPrompt {
  amount: number;
  peerAlias: string;
  peerLabel: string;
  peerId?: string;
  selectedReceiverHint?: {
    candidateId?: string;
    walletAddress?: string;
    deviceId?: string;
    displayName?: string;
    deviceName?: string;
  };
  trustBand: TrustBand;
  trustScore: number;
  riskLevel: LocalRiskLevel;
  riskScore: number;
  reasons: string[];
}

export class SendTrustWarningError extends Error {
  readonly prompt: SendTrustWarningPrompt;

  constructor(prompt: SendTrustWarningPrompt) {
    super(
      translate("service.wallet.error.peerWarnRequiresConfirmation", {
        peer: prompt.peerLabel,
      }),
    );
    this.name = "SendTrustWarningError";
    this.prompt = prompt;
  }
}

interface LegacyOnboardingState {
  backendReachable?: boolean;
  deviceRegistered?: boolean;
  walletRegistered?: boolean;
  budgetProvisioned?: boolean;
  policySource?: "local" | "backend";
  lastDeviceSyncAt?: string;
  lastProvisionedAt?: string;
}

interface PersistedWalletSnapshot {
  profile?: WalletProfile;
  security?: WalletSecurityState;
  balances?: Record<"OFFAIR" | "SOL", AssetBalance>;
  pendingChainTransactions?: PendingChainTransaction[];
  onboarding?: Partial<OnboardingState> & LegacyOnboardingState;
  reserve?: OfflineBudget;
  budget?: OfflineBudget;
  journal?: OfflineTransfer[];
}

interface PersistedWalletState {
  manifest?: DeviceManifest | null;
  policy?: AllowlistPolicy;
  statusLog?: string[];
  walletRegistry?: WalletRegistryEntry[];
  budget?: OfflineBudget;
  reserve?: OfflineBudget;
  onboarding?: Partial<OnboardingState> & LegacyOnboardingState;
  walletSnapshots?: Record<string, PersistedWalletSnapshot>;
  activeWalletId?: string | null;
  profile?: WalletProfile | null;
  security?: WalletSecurityState;
  balances?: Record<"OFFAIR" | "SOL", AssetBalance>;
  pendingChainTransactions?: PendingChainTransaction[];
  journal?: OfflineTransfer[];
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function createEmptyBalances(): Record<"OFFAIR" | "SOL", AssetBalance> {
  const timestamp = new Date().toISOString();
  return {
    OFFAIR: {
      assetId: "OFFAIR",
      amount: "0.00",
      decimals: 6,
      lastUpdatedAt: timestamp,
      source: "cached",
    },
    SOL: {
      assetId: "SOL",
      amount: "0.000",
      decimals: 9,
      lastUpdatedAt: timestamp,
      source: "cached",
    },
  };
}

function normalizeBalances(
  balances?: Partial<Record<"OFFAIR" | "SOL", AssetBalance>> | null,
): Record<"OFFAIR" | "SOL", AssetBalance> {
  const fallback = createEmptyBalances();
  return {
    SOL: balances?.SOL ?? fallback.SOL,
    OFFAIR: balances?.OFFAIR ?? fallback.OFFAIR,
  };
}

function createOnboardingState(partial?: Partial<OnboardingState> & LegacyOnboardingState): OnboardingState {
  return {
    rpcReachable: partial?.rpcReachable ?? partial?.backendReachable ?? false,
    deviceKeyReady: partial?.deviceKeyReady ?? partial?.deviceRegistered ?? false,
    onChainProfileReady: partial?.onChainProfileReady ?? partial?.walletRegistered ?? false,
    reserveReady: partial?.reserveReady ?? partial?.budgetProvisioned ?? false,
    quarantined: false,
    executionSource:
      partial?.executionSource ?? (partial?.policySource === "backend" ? "rpc" : partial?.policySource) ?? "local",
    lastProtocolSyncAt: partial?.lastProtocolSyncAt ?? partial?.lastDeviceSyncAt,
    lastReserveCheckAt: partial?.lastReserveCheckAt ?? partial?.lastProvisionedAt,
    ...partial,
  };
}

function createEmptyReserve(deviceId: string): OfflineBudget {
  return {
    budgetId: `reserve-${deviceId}-empty`,
    deviceId,
    assetId: "SOL",
    totalAmount: 0,
    remainingAmount: 0,
    remainingTransfers: 0,
    expiresAt: addDays(1),
  };
}

function emptyOnboardingForRuntime(): OnboardingState {
  return createOnboardingState({
    rpcReachable: false,
    executionSource: "local",
  });
}

function prependStatus(state: WalletState, message: string, extra: string[] = []): WalletState {
  return {
    ...state,
    statusLog: [message, ...extra, ...state.statusLog].slice(0, 20),
  };
}

function assertOfflineTransferInput(input: { amount: number; peerAlias?: string }) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error(translate("service.wallet.error.offlineAmount"));
  }
}

function buildPeerAliasFallback(deviceId: string): string {
  return `peer-${deviceId.slice(-6)}`;
}

function resolvePeerIdForOutgoingTransfer(transfer: OfflineTransfer): string {
  return transfer.receiverAddress ?? transfer.receiverPseudoId;
}

function resolvePeerIdForIncomingTransfer(transfer: OfflineTransfer): string {
  return transfer.senderAddress ?? transfer.senderPseudoId;
}

function countsTowardOfflineExposure(transfer: OfflineTransfer): boolean {
  return (
    transfer.assetId === "OFFAIR" &&
    transfer.settlementStatus === "pending" &&
    (transfer.sessionSettlementMode ?? "offline_promise") === "offline_promise"
  );
}

function calculatePendingOfflineExposure(journal: OfflineTransfer[]): number {
  return journal
    .filter((entry) => countsTowardOfflineExposure(entry))
    .reduce((total, entry) => total + entry.amount, 0);
}

function resolveLatestReputationEnvelope(snapshots: Record<string, WalletSnapshot>): ReputationEnvelope | null {
  return (
    Object.values(snapshots)
      .map((snapshot) => snapshot.profile.reputationEnvelope)
      .filter((item): item is ReputationEnvelope => Boolean(item))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  );
}

function attachReputationLineageToProfile(
  profile: WalletProfile,
  context: {
    manifest: DeviceManifest | null;
    snapshots: Record<string, WalletSnapshot>;
    currentJournal?: OfflineTransfer[];
    now?: string;
  },
): WalletProfile {
  const anchorHash = context.manifest?.deviceReputationAnchorHash;
  if (!anchorHash) {
    return profile;
  }
  if (profile.reputationAnchorHash === anchorHash && profile.reputationEnvelope) {
    return profile;
  }

  const existingWallets = Object.values(context.snapshots).filter((snapshot) => snapshot.profile.walletId !== profile.walletId);
  const existingWalletCount = existingWallets.length;
  const previousEnvelope =
    profile.reputationEnvelope ?? resolveLatestReputationEnvelope(context.snapshots);
  const unresolvedExposure =
    existingWallets.reduce((total, snapshot) => total + calculatePendingOfflineExposure(snapshot.journal), 0) +
    calculatePendingOfflineExposure(context.currentJournal ?? []);
  const reputationEnvelope = buildReputationEnvelope({
    previousEnvelope,
    existingWalletCount,
    unresolvedExposure,
    integrityState: context.manifest?.deviceIntegrityState,
    now: context.now ?? profile.createdAt,
  });

  return {
    ...profile,
    reputationAnchorHash: anchorHash,
    reputationEnvelope,
    lineageGeneration: reputationEnvelope.lineageGeneration,
    lineageTrustCeiling: reputationEnvelope.trustCeiling,
    lineageRiskFloor: reputationEnvelope.riskFloor,
    lineageCooldownUntil: reputationEnvelope.cooldownUntil ?? null,
  };
}

function parseFiniteAmount(value: string): number {
  const amount = Number.parseFloat(value);
  return Number.isFinite(amount) ? amount : 0;
}

function calculatePendingSolQueueExposure(transactions: PendingChainTransaction[]): number {
  return transactions
    .filter(
      (transaction) =>
        transaction.intent.assetId === "SOL" &&
        transaction.status !== "failed" &&
        transaction.status !== "confirmed",
    )
    .reduce((total, transaction) => total + parseFiniteAmount(transaction.intent.amount), 0);
}

export interface OfflinePromiseCapacity {
  maxAmount: number;
  offairAmount: number;
  reserveAmount: number;
  localPromiseAmount: number;
  remainingTransfers: number;
  source: "reserve" | "local" | "none";
  reasons: string[];
}

function countPendingOfflineTransfers(state: WalletState): number {
  return state.journal.filter((entry) => countsTowardOfflineExposure(entry)).length;
}

function getLocalPromiseAllowanceAmount(state: WalletState): number {
  const cachedSolAmount = parseFiniteAmount(state.balances.SOL.amount);
  const pendingExposure = calculatePendingOfflineExposure(state.journal);
  const requiresVerifiedOnly = requiresVerifiedOfflineSettlement(state);
  const riskAdjustedFastLimit = state.manifest
    ? getDeviceAdjustedOfflineAmountLimit(state.policy, state.manifest)
    : state.policy.maxOfflineAmount;
  const localLimit = requiresVerifiedOnly ? state.policy.maxOfflineAmount : riskAdjustedFastLimit;
  return Math.max(0, Math.min(localLimit, MVP_LOCAL_PROMISE_MAX_SOL, cachedSolAmount) - pendingExposure);
}

function getEffectiveOfflineAllowance(state: WalletState): OfflineBudget | null {
  const offairAmount = parseFiniteAmount(state.balances.OFFAIR.amount);
  const reserveBackedAmount = Math.min(state.reserve.remainingAmount, offairAmount);

  if (reserveBackedAmount > 0 && state.reserve.remainingTransfers > 0) {
    return {
      ...state.reserve,
      remainingAmount: reserveBackedAmount,
    };
  }

  const localPromiseAmount = getLocalPromiseAllowanceAmount(state);
  const remainingTransfers = Math.max(0, state.policy.maxOfflineTransfers - countPendingOfflineTransfers(state));
  if (localPromiseAmount <= 0 || remainingTransfers <= 0) {
    return null;
  }

  return {
    budgetId: "mvp-local-promise-allowance",
    deviceId: state.manifest?.deviceId ?? state.reserve.deviceId,
    assetId: "SOL",
    totalAmount: localPromiseAmount,
    remainingAmount: localPromiseAmount,
    remainingTransfers,
    expiresAt: state.policy.expiresAt,
  };
}

export function getOfflinePromiseCapacity(state: WalletState): OfflinePromiseCapacity {
  const offairAmount = parseFiniteAmount(state.balances.OFFAIR.amount);
  const reserveAmount = state.reserve.remainingAmount;
  const reserveBackedAmount = Math.min(reserveAmount, offairAmount);
  const reserveBackedReady = reserveBackedAmount > 0 && state.reserve.remainingTransfers > 0;
  const localPromiseAmount = reserveBackedReady ? 0 : getLocalPromiseAllowanceAmount(state);
  const localRemainingTransfers = Math.max(0, state.policy.maxOfflineTransfers - countPendingOfflineTransfers(state));
  const source = reserveBackedReady ? "reserve" : localPromiseAmount > 0 && localRemainingTransfers > 0 ? "local" : "none";
  const remainingTransfers = source === "reserve" ? state.reserve.remainingTransfers : localRemainingTransfers;
  const maxAmount = Math.max(
    0,
    Math.min(state.policy.maxOfflineAmount, source === "reserve" ? reserveBackedAmount : localPromiseAmount),
  );
  const reasons: string[] = [];

  if (source === "none" && offairAmount <= 0 && localPromiseAmount <= 0) {
    reasons.push("available OffAir capacity exhausted");
  }
  if (source === "none" && reserveAmount <= 0 && localPromiseAmount <= 0) {
    reasons.push("sender reserve is empty");
  }
  if (remainingTransfers <= 0) {
    reasons.push("no remaining offline promise slots");
  }
  if (state.manifest) {
    const integrity = evaluateDeviceIntegrity(state.manifest);
    if (integrity.verifiedOnly) {
      reasons.push("device integrity requires verified-only settlement");
    } else if (integrity.exposureMultiplier < 1) {
      reasons.push(`device integrity multiplier ${integrity.exposureMultiplier.toFixed(2)}x applied`);
    }
    if (state.manifest.reputationEnvelope) {
      const reputationMultiplier = computeReputationExposureMultiplier(state.manifest.reputationEnvelope);
      if (lineageRequiresVerifiedOnly(state.manifest.reputationEnvelope)) {
        reasons.push("reputation lineage requires verified-only settlement");
      } else if (reputationMultiplier < 1) {
        reasons.push(`reputation lineage multiplier ${reputationMultiplier.toFixed(2)}x applied`);
      }
    }
  }

  return {
    maxAmount,
    offairAmount,
    reserveAmount,
    localPromiseAmount,
    remainingTransfers,
    source,
    reasons,
  };
}

function requiresVerifiedOfflineSettlement(state: WalletState): boolean {
  if (!state.manifest) {
    return false;
  }

  const integrity = evaluateDeviceIntegrity(state.manifest);
  return integrity.verifiedOnly || Boolean(state.manifest.reputationEnvelope && lineageRequiresVerifiedOnly(state.manifest.reputationEnvelope));
}

function assertOfflinePromiseWithinLimits(
  state: WalletState,
  amount: number,
  risk: RiskSnapshot,
  offlineSettlementTier?: OfflineSettlementTier,
) {
  if (!state.manifest) {
    throw new Error(translate("service.wallet.error.manifestUnavailable"));
  }

  const pendingTransfers = countPendingOfflineTransfers(state);
  const allowance = getEffectiveOfflineAllowance(state);
  const capacity = getOfflinePromiseCapacity(state);
  const approval = canApproveOfflineTransfer({
    allowance: allowance ?? undefined,
    policy: state.policy,
    manifest: state.manifest,
    amount,
    offlineSettlementTier,
    pendingTransfers,
    risk,
  });
  const reasons = [...approval.reasons];
  if (capacity.source === "reserve" && amount > capacity.offairAmount) {
    reasons.push("available OffAir capacity exhausted");
  }

  if (reasons.length > 0) {
    throw new Error(
      `${translate("service.wallet.error.offairCapExceeded", {
        max: Number.isFinite(capacity.maxAmount) ? capacity.maxAmount.toString() : state.policy.maxOfflineAmount,
      })} ${reasons.join("; ")}`,
    );
  }
}

function rewriteTransfer(transfer: OfflineTransfer, updates: Partial<OfflineTransfer>): OfflineTransfer {
  const { txHash: _ignored, ...rest } = transfer;
  const nextTransfer: OfflineTransfer = {
    ...rest,
    ...updates,
  };

  return {
    ...nextTransfer,
    txHash: sha256Hex(nextTransfer),
  };
}

function applyReceiptResolutionToTransfer(transfer: OfflineTransfer, receipt: TransferReceipt): OfflineTransfer {
  const sessionSettlementMode = receipt.sessionSettlementMode ?? transfer.sessionSettlementMode;
  const claimStatus = receipt.claimStatus ?? transfer.claimStatus;
  const settlementStatus =
    sessionSettlementMode === "direct_sol" || claimStatus === "settled"
      ? "reconciled"
      : transfer.settlementStatus;

  return rewriteTransfer(transfer, {
    sessionSettlementMode,
    claimStatus,
    settlementStatus,
    directSettlementSignature: receipt.directSettlementSignature ?? transfer.directSettlementSignature,
    instantClaimSignature: receipt.claimTxSignature ?? transfer.instantClaimSignature,
    instantSettleSignature: receipt.settleTxSignature ?? transfer.instantSettleSignature,
  });
}

async function persistTrustInteraction(
  peerId: string,
  kind: "sent" | "received" | "claimed" | "settled" | "rejected" | "encountered" | "closed",
  amount?: number,
) {
  if (!peerId.trim()) {
    return;
  }

  await mutateLocalTrustState((current) =>
    recordPeerInteraction(current, {
      peerId,
      kind,
      amount,
      occurredAt: new Date().toISOString(),
    }),
  );
}

export async function previewOfflinePeerTrust(input: {
  peerHint: string;
}): Promise<PeerTrustPreview | null> {
  const peerHint = input.peerHint.trim();
  if (!peerHint) {
    return null;
  }

  const trustState = await loadLocalTrustState();
  return findPeerTrustPreview(trustState, {
    peerHint,
  });
}

function assertChainTransferInput(input: { toAddress: string; amount: string }) {
  try {
    new PublicKey(input.toAddress);
  } catch {
    throw new Error(translate("service.wallet.error.invalidRecipient"));
  }

  if (!/^\d+(\.\d+)?$/.test(input.amount.trim())) {
    throw new Error(translate("service.wallet.error.invalidTransferAmount"));
  }
  if (Number(input.amount) <= 0) {
    throw new Error(translate("service.wallet.error.transferAmountPositive"));
  }
}

function mergePendingTransactions(
  local: PendingChainTransaction[],
  remote: PendingChainTransaction[],
): PendingChainTransaction[] {
  const merged = new Map<string, PendingChainTransaction>();
  local.forEach((transaction) => merged.set(transaction.intent.intentId, transaction));

  remote.forEach((transaction) => {
    const existing = merged.get(transaction.intent.intentId);
    merged.set(transaction.intent.intentId, {
      ...(existing ?? transaction),
      ...transaction,
      intent: {
        ...(existing?.intent ?? transaction.intent),
        ...transaction.intent,
      },
      envelope: {
        ...(existing?.envelope ?? transaction.envelope),
        ...transaction.envelope,
      },
    });
  });

  return Array.from(merged.values()).sort((left, right) =>
    right.intent.createdAt.localeCompare(left.intent.createdAt),
  );
}

function withWalletManifest(manifest: DeviceManifest | null, profile: WalletProfile | null): DeviceManifest | null {
  if (!manifest || !profile) {
    return manifest;
  }

  return {
    ...manifest,
    walletPublicKey: profile.publicKey,
    solanaAddress: profile.solanaAddress,
    activeWalletId: profile.walletId,
    walletType: profile.walletType,
    walletDisplayName: profile.displayName,
    reputationEnvelope: profile.reputationEnvelope,
  };
}

function snapshotFromMetadata(deviceId: string, metadata: {
  profile: WalletProfile;
  security: WalletSecurityState;
  balances?: AssetBalance[] | null;
}): WalletSnapshot {
  const balanceRecord = createEmptyBalances();
  for (const balance of metadata.balances ?? []) {
    if (balance.assetId === "OFFAIR" || balance.assetId === "SOL") {
      balanceRecord[balance.assetId] = balance;
    }
  }

  return {
    profile: metadata.profile,
    security: normalizeWalletSecurity(metadata.security),
    balances: balanceRecord,
    pendingChainTransactions: [],
    onboarding: emptyOnboardingForRuntime(),
    reserve: createEmptyReserve(deviceId),
    journal: [],
  };
}

function normalizeWalletSecurity(security?: WalletSecurityState | null): WalletSecurityState {
  const runtimeSecurity = getWalletSecuritySnapshot();
  return {
    ...runtimeSecurity,
    ...(security ?? {}),
    biometryAvailable: runtimeSecurity.biometryAvailable,
    biometricProtected: runtimeSecurity.biometricProtected,
  };
}

function normalizeWalletSnapshot(snapshot: PersistedWalletSnapshot, deviceId: string): WalletSnapshot {
  return {
    profile: snapshot.profile as WalletProfile,
    security: normalizeWalletSecurity(snapshot.security),
    balances: normalizeBalances(snapshot.balances),
    pendingChainTransactions: snapshot.pendingChainTransactions ?? [],
    onboarding: createOnboardingState(snapshot.onboarding ?? {}),
    reserve: snapshot.reserve ?? snapshot.budget ?? createEmptyReserve(deviceId),
    journal: snapshot.journal ?? [],
  };
}

function toRegistryEntry(profile: WalletProfile, activeWalletId: string | null): WalletRegistryEntry {
  return {
    walletId: profile.walletId,
    walletType: profile.walletType,
    displayName: profile.displayName,
    solanaAddress: profile.solanaAddress,
    publicKey: profile.publicKey,
    postQuantumPublicKey: profile.postQuantumPublicKey,
    devicePublicKey: profile.devicePublicKey,
    identityDerivationVersion: profile.identityDerivationVersion,
    identityContextHash: profile.identityContextHash,
    identityPublicKey: profile.identityPublicKey,
    publicKeyAnchored: profile.publicKeyAnchored,
    publicKeyAnchorTx: profile.publicKeyAnchorTx ?? null,
    publicKeyAnchoredAt: profile.publicKeyAnchoredAt ?? null,
    createdAt: profile.createdAt,
    backupConfirmedAt: profile.backupConfirmedAt,
    isActiveOnDevice: profile.walletId === activeWalletId,
    certificateProfile: profile.certificateProfile ?? null,
    reputationAnchorHash: profile.reputationAnchorHash,
    reputationEnvelope: profile.reputationEnvelope,
    lineageGeneration: profile.lineageGeneration,
    lineageTrustCeiling: profile.lineageTrustCeiling,
    lineageRiskFloor: profile.lineageRiskFloor,
    lineageCooldownUntil: profile.lineageCooldownUntil ?? null,
  };
}

function replaceRegistryEntry(
  registry: WalletRegistryEntry[],
  profile: WalletProfile,
  activeWalletId: string | null,
): WalletRegistryEntry[] {
  return [
    ...registry.filter((entry) => entry.walletId !== profile.walletId),
    toRegistryEntry(profile, activeWalletId),
  ]
    .map((entry) => ({
      ...entry,
      isActiveOnDevice: entry.walletId === activeWalletId,
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function projectActiveWalletState(state: WalletState): WalletState {
  const activeSnapshot = state.activeWalletId ? state.walletSnapshots[state.activeWalletId] : undefined;

  return {
    ...state,
    manifest: withWalletManifest(state.manifest, activeSnapshot?.profile ?? null),
    profile: activeSnapshot?.profile ?? null,
    security: activeSnapshot?.security ?? getWalletSecuritySnapshot(),
    balances: normalizeBalances(activeSnapshot?.balances),
    pendingChainTransactions: activeSnapshot?.pendingChainTransactions ?? [],
    onboarding: activeSnapshot?.onboarding ?? emptyOnboardingForRuntime(),
    reserve: activeSnapshot?.reserve ?? createEmptyReserve(state.manifest?.deviceId ?? "airpay-demo"),
    journal: activeSnapshot?.journal ?? [],
    walletRegistry: state.walletRegistry.map((entry) => ({
      ...entry,
      isActiveOnDevice: entry.walletId === state.activeWalletId,
    })),
  };
}

function updateActiveSnapshot(state: WalletState, updater: (snapshot: WalletSnapshot) => WalletSnapshot): WalletState {
  if (!state.activeWalletId) {
    return state;
  }

  const activeSnapshot = state.walletSnapshots[state.activeWalletId];
  if (!activeSnapshot) {
    return state;
  }

  const nextSnapshot = updater(activeSnapshot);
  return projectActiveWalletState({
    ...state,
    walletSnapshots: {
      ...state.walletSnapshots,
      [nextSnapshot.profile.walletId]: nextSnapshot,
    },
    walletRegistry: replaceRegistryEntry(state.walletRegistry, nextSnapshot.profile, state.activeWalletId),
  });
}

function upsertWalletSnapshot(
  state: WalletState,
  snapshot: WalletSnapshot,
  options?: { makeActive?: boolean },
): WalletState {
  const activeWalletId = options?.makeActive === false ? state.activeWalletId : snapshot.profile.walletId;
  return projectActiveWalletState({
    ...state,
    activeWalletId,
    walletSnapshots: {
      ...state.walletSnapshots,
      [snapshot.profile.walletId]: snapshot,
    },
    walletRegistry: replaceRegistryEntry(state.walletRegistry, snapshot.profile, activeWalletId),
  });
}

function normalizeWalletState(raw: PersistedWalletState, manifest: DeviceManifest | null, policy: AllowlistPolicy): WalletState {
  const runtime = getWalletRuntimeConfig();
  const deviceId = manifest?.deviceId ?? "airpay-demo";
  const snapshots = Object.fromEntries(
    Object.entries(raw.walletSnapshots ?? {}).map(([walletId, snapshot]) => [
      walletId,
      normalizeWalletSnapshot(snapshot, deviceId),
    ]),
  ) as Record<string, WalletSnapshot>;
  let walletRegistry = raw.walletRegistry ?? [];
  let activeWalletId = raw.activeWalletId ?? null;

  if (!raw.walletSnapshots && raw.profile) {
    const migratedSnapshot = normalizeWalletSnapshot(
      {
        profile: raw.profile,
        security: raw.security,
        balances: raw.balances,
        pendingChainTransactions: raw.pendingChainTransactions,
        onboarding: raw.onboarding,
        reserve: raw.reserve,
        budget: raw.budget,
        journal: raw.journal,
      },
      deviceId,
    );
    snapshots[migratedSnapshot.profile.walletId] = migratedSnapshot;
    activeWalletId = migratedSnapshot.profile.walletId;
    walletRegistry = [toRegistryEntry(migratedSnapshot.profile, activeWalletId)];
  }

  const lineageSnapshots: Record<string, WalletSnapshot> = {};
  for (const snapshot of Object.values(snapshots).sort((left, right) =>
    left.profile.createdAt.localeCompare(right.profile.createdAt),
  )) {
    const profile = attachReputationLineageToProfile(snapshot.profile, {
      manifest,
      snapshots: lineageSnapshots,
      currentJournal: snapshot.journal,
      now: snapshot.profile.createdAt,
    });
    lineageSnapshots[profile.walletId] = {
      ...snapshot,
      profile,
    };
  }
  Object.assign(snapshots, lineageSnapshots);
  walletRegistry = walletRegistry.map((entry) =>
    snapshots[entry.walletId]?.profile
      ? toRegistryEntry(snapshots[entry.walletId].profile, activeWalletId)
      : {
          ...entry,
          isActiveOnDevice: entry.walletId === activeWalletId,
        },
  );

  const baseState: WalletState = {
    manifest,
    policy: raw.policy ?? policy,
    statusLog: raw.statusLog ?? [],
    walletRegistry: walletRegistry.map((entry) => ({
      ...entry,
      isActiveOnDevice: entry.walletId === activeWalletId,
    })),
    walletSnapshots: snapshots,
    activeWalletId,
    profile: null,
    security: getWalletSecuritySnapshot(),
    balances: createEmptyBalances(),
    pendingChainTransactions: [],
    onboarding: createOnboardingState({
      rpcReachable: Boolean(runtime.backendUrl),
      executionSource: runtime.backendUrl ? "rpc" : "local",
    }),
    reserve: raw.reserve ?? raw.budget ?? createEmptyReserve(manifest?.deviceId ?? "airpay-demo"),
    journal: [],
  };

  return projectActiveWalletState(baseState);
}

function createBaseState(policy: AllowlistPolicy, manifest: DeviceManifest): WalletState {
  const runtime = getWalletRuntimeConfig();
  return projectActiveWalletState({
    manifest,
    policy,
    statusLog: [
      translate("service.wallet.status.transportProvisioned", {
        serviceId: manifest.bleServiceId ?? getDefaultTransportIds().serviceUuid,
      }),
      runtime.backendUrl
        ? translate("service.wallet.status.syncInstruction")
        : translate("service.wallet.status.backendUnavailable"),
      translate("service.wallet.status.walletInstruction"),
    ],
    walletRegistry: [],
    walletSnapshots: {},
    activeWalletId: null,
    profile: null,
    security: getWalletSecuritySnapshot(),
    balances: createEmptyBalances(),
    pendingChainTransactions: [],
    onboarding: emptyOnboardingForRuntime(),
    reserve: createEmptyReserve(manifest.deviceId),
    journal: [],
  });
}

export function createDemoPolicy(): AllowlistPolicy {
  return {
    policyId: "policy-3",
    policyHash: "policy-hash-demo-3",
    minEpoch: 3,
    allowedStateRoots: ["state-demo-v1"],
    revokedStateRoots: [],
    maxOfflineTransfers: 5,
    maxOfflineAmount: 100,
    fastOfflineNewUserLimitLamports: String(DEFAULT_FAST_OFFLINE_NEW_USER_LIMIT_LAMPORTS),
    fastOfflineTrustedLimitLamports: String(DEFAULT_FAST_OFFLINE_TRUSTED_LIMIT_LAMPORTS),
    fastOfflineHighTrustLimitLamports: String(DEFAULT_FAST_OFFLINE_HIGH_TRUST_LIMIT_LAMPORTS),
    verifiedOfflineMinLamports: String(DEFAULT_VERIFIED_OFFLINE_MIN_LAMPORTS),
    allowBleFallback: true,
    expiresAt: addDays(14),
  };
}

async function resolvePolicy(): Promise<AllowlistPolicy> {
  try {
    return (await fetchCurrentPolicyFromBackend()) ?? createDemoPolicy();
  } catch {
    return createDemoPolicy();
  }
}

async function rebuildManifest(policy: AllowlistPolicy, profile: WalletProfile | null): Promise<DeviceManifest> {
  const manifest = await buildDeviceManifest(policy);
  return withWalletManifest(manifest, profile) ?? manifest;
}

async function hydrateStateFromCustody(policy: AllowlistPolicy, manifest: DeviceManifest): Promise<WalletState> {
  const registry = await loadWalletRegistry();
  const snapshots: Record<string, WalletSnapshot> = {};

  for (const entry of registry) {
    const metadata = await loadWalletMetadata(entry.walletId);
    if (!metadata) {
      continue;
    }
    snapshots[entry.walletId] = snapshotFromMetadata(manifest.deviceId, metadata);
  }

  const activeWalletId = registry.find((entry) => entry.isActiveOnDevice)?.walletId ?? registry[0]?.walletId ?? null;
  return projectActiveWalletState({
    ...createBaseState(policy, manifest),
    walletRegistry: registry,
    walletSnapshots: snapshots,
    activeWalletId,
  });
}

export async function getOrCreateWalletSecret(): Promise<string> {
  const existing = await SecureStore.getItemAsync(SECRET_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const secret = createNonce("secret");
  await SecureStore.setItemAsync(SECRET_STORAGE_KEY, secret);
  return secret;
}

async function ensureWalletStorageCompatibility(): Promise<boolean> {
  const currentVersion = await AsyncStorage.getItem(WALLET_STORAGE_RESET_VERSION_KEY);
  if (currentVersion === String(WALLET_STORAGE_RESET_VERSION)) {
    return false;
  }

  await clearWalletVault().catch(() => undefined);
  await Promise.all([
    AsyncStorage.removeItem(WALLET_STORAGE_KEY),
    SecureStore.deleteItemAsync(SECRET_STORAGE_KEY).catch(() => undefined),
    AsyncStorage.setItem(WALLET_STORAGE_RESET_VERSION_KEY, String(WALLET_STORAGE_RESET_VERSION)),
    AsyncStorage.setItem(REMOTE_DEVICE_RESET_PENDING_KEY, "1"),
  ]);

  return true;
}

async function performPendingRemoteDeviceReset(deviceId: string): Promise<boolean> {
  void deviceId;
  const pending = await AsyncStorage.getItem(REMOTE_DEVICE_RESET_PENDING_KEY);
  if (pending !== "1") {
    return false;
  }
  await AsyncStorage.removeItem(REMOTE_DEVICE_RESET_PENDING_KEY);
  return true;
}

export async function createInitialWalletState(): Promise<WalletState> {
  const policy = await resolvePolicy();
  const manifest = await rebuildManifest(policy, null);
  const hydrated = await hydrateStateFromCustody(policy, manifest);
  if (hydrated.walletRegistry.length > 0) {
    return prependStatus(hydrated, translate("service.wallet.status.syncInstruction"));
  }
  return createBaseState(policy, manifest);
}

export async function loadWalletState(): Promise<WalletState> {
  const storageResetApplied = await ensureWalletStorageCompatibility();
  await getOrCreateWalletSecret();
  const policy = await resolvePolicy();
  const raw = await AsyncStorage.getItem(WALLET_STORAGE_KEY);

  if (!raw) {
    const initial = await createInitialWalletState();
    if (storageResetApplied) {
      initial.statusLog = [translate("service.wallet.status.storageReset"), ...initial.statusLog].slice(0, 20);
    }
    await saveWalletState(initial);
    return initial;
  }

  let parsed: PersistedWalletState;
  try {
    parsed = JSON.parse(raw) as PersistedWalletState;
  } catch {
    await AsyncStorage.removeItem(WALLET_STORAGE_KEY);
    const initial = await createInitialWalletState();
    initial.statusLog = [translate("service.wallet.status.storageReset"), ...initial.statusLog].slice(0, 20);
    await saveWalletState(initial);
    return initial;
  }
  const manifest = await rebuildManifest(policy, parsed.profile ?? null);
  let normalized = normalizeWalletState(parsed, manifest, policy);
  if (!normalized.walletRegistry.length) {
    normalized = await hydrateStateFromCustody(policy, manifest);
  }
  return normalized;
}

export async function saveWalletState(state: WalletState): Promise<void> {
  await AsyncStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(state));
}

export async function resetWalletState(): Promise<WalletState> {
  await clearWalletVault().catch(() => undefined);
  const initial = await createInitialWalletState();
  await saveWalletState(initial);
  return initial;
}

export function isOfflineReady(state: WalletState): boolean {
  return Boolean(
    state.manifest &&
      state.profile &&
      Boolean(state.profile.backupConfirmedAt) &&
      !state.onboarding.quarantined,
  );
}

function buildWalletSnapshot(state: WalletState, profile: WalletProfile, security: WalletSecurityState, balances: Record<"OFFAIR" | "SOL", AssetBalance>): WalletSnapshot {
  return {
    profile,
    security,
    balances,
    pendingChainTransactions: [],
    onboarding: createOnboardingState({
      rpcReachable: false,
      executionSource: "local",
      onChainProfileReady: false,
      deviceKeyReady: false,
      reserveReady: false,
    }),
    reserve: createEmptyReserve(state.manifest?.deviceId ?? "airpay-demo"),
    journal: [],
  };
}

function applyProtocolCapacityToBalances(
  balances: Record<"OFFAIR" | "SOL", AssetBalance>,
  capacityAmount: string,
  pendingExposureAmount = 0,
): Record<"OFFAIR" | "SOL", AssetBalance> {
  const normalizedCapacity = Number.parseFloat(capacityAmount);
  const effectiveCapacity = Number.isFinite(normalizedCapacity)
    ? Math.max(0, normalizedCapacity - pendingExposureAmount)
    : 0;
  return {
    ...balances,
    OFFAIR: {
      ...balances.OFFAIR,
      amount: effectiveCapacity.toString(),
      source: "cached",
      lastUpdatedAt: new Date().toISOString(),
    },
  };
}

async function refreshProtocolStateInternal(
  state: WalletState,
  options: {
    registerWallet?: boolean;
    provisionBudget?: boolean;
    allowOnChainMutation?: boolean;
    requestedAmount?: number;
    requestedTransfers?: number;
    deferredStatusKey?: DeferredWalletStatusKey;
  } = {},
): Promise<WalletState> {
  if (!state.manifest) {
    throw new Error(translate("service.wallet.error.manifestUnavailable"));
  }
  if (!state.profile) {
    throw new Error(translate("service.wallet.error.createBeforeSigning"));
  }

  const now = new Date().toISOString();
  const deviceKeyReady = Boolean(state.manifest.publicKey);
  let onChainProfileReady = false;
  let reserveBalanceSol = 0;
  let capacityAmount = state.balances.OFFAIR.amount;
  let resolvedPolicy = state.policy;
  let backendReachable = false;
  let backendQuarantined: boolean | null = null;
  let provisionedBudget: OfflineBudget | null = null;
  let backendWalletEntry: WalletRegistryEntry | null = null;
  const syncNotes: string[] = [];
  const deferredStatusKey = options.deferredStatusKey ?? "service.wallet.status.walletCreatedDeferred";
  const pendingExposureAmount = calculatePendingOfflineExposure(state.journal);

  if (options.registerWallet) {
    try {
      const backendManifest = withWalletManifest(state.manifest, state.profile) ?? state.manifest;
      const deviceRegistration = await registerDeviceWithBackend(backendManifest);
      if (deviceRegistration) {
        backendReachable = true;
        resolvedPolicy = deviceRegistration.policy;
        backendQuarantined = deviceRegistration.quarantined;
      }

      backendWalletEntry = await registerWalletWithBackend({
        manifest: backendManifest,
        profile: state.profile,
      });

      if (options.provisionBudget) {
        const budgetResponse = await provisionOfflineBudgetWithBackend({
          deviceId: backendManifest.deviceId,
          walletId: state.profile.walletId,
          requestedAmount: Math.min(
            options.requestedAmount ?? resolvedPolicy.maxOfflineAmount,
            resolvedPolicy.maxOfflineAmount,
          ),
          requestedTransfers: Math.min(
            options.requestedTransfers ?? resolvedPolicy.maxOfflineTransfers,
            resolvedPolicy.maxOfflineTransfers,
          ),
        });

        if (budgetResponse) {
          provisionedBudget = budgetResponse.budget;
          resolvedPolicy = budgetResponse.policy;
          capacityAmount = String(budgetResponse.budget.remainingAmount);
        }
      }
    } catch (error) {
      syncNotes.push(
        translate(deferredStatusKey, {
          reason: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }

  try {
    const protocolState = await ensureWalletProtocolState({
      profile: state.profile,
      devicePublicKey: options.registerWallet ? state.manifest.publicKey ?? state.manifest.deviceId : undefined,
      allowOnChainMutation: options.allowOnChainMutation,
    });
    onChainProfileReady = Boolean(protocolState.registry);
    reserveBalanceSol = Number.parseFloat(protocolState.reserve.sol);
    if (!provisionedBudget) {
      capacityAmount = protocolState.reserve.capacityAvailableSol ?? protocolState.reserve.capacityIssuedSol ?? "0";
    }
  } catch (error) {
    if (options.registerWallet) {
      syncNotes.push(
        translate(deferredStatusKey, {
          reason: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
    onChainProfileReady = false;
    reserveBalanceSol = 0;
  }

  const stateWithPolicy = {
    ...state,
    policy: resolvedPolicy,
  };

  const nextState = updateActiveSnapshot(stateWithPolicy, (snapshot) => {
    const nextReserve =
      provisionedBudget ??
      (reserveBalanceSol > 0
        ? {
            ...snapshot.reserve,
            totalAmount: reserveBalanceSol,
            remainingAmount: reserveBalanceSol,
            remainingTransfers: Number.MAX_SAFE_INTEGER,
            expiresAt: snapshot.reserve.expiresAt,
          }
        : snapshot.reserve);
    const reserveReady = nextReserve.remainingAmount > 0 && nextReserve.remainingTransfers > 0;

    return {
      ...snapshot,
      profile: backendWalletEntry
        ? {
            ...snapshot.profile,
            publicKeyAnchored: backendWalletEntry.publicKeyAnchored || snapshot.profile.publicKeyAnchored,
            publicKeyAnchorTx: backendWalletEntry.publicKeyAnchorTx ?? snapshot.profile.publicKeyAnchorTx,
            publicKeyAnchoredAt: backendWalletEntry.publicKeyAnchoredAt ?? snapshot.profile.publicKeyAnchoredAt,
          }
        : snapshot.profile,
      balances: applyProtocolCapacityToBalances(snapshot.balances, capacityAmount, pendingExposureAmount),
      onboarding: {
        ...snapshot.onboarding,
        rpcReachable: backendReachable || onChainProfileReady,
        deviceKeyReady,
        onChainProfileReady,
        reserveReady,
        quarantined: backendQuarantined ?? snapshot.onboarding.quarantined,
        executionSource: backendReachable || onChainProfileReady ? "rpc" : "local",
        lastProtocolSyncAt: now,
        lastReserveCheckAt: reserveReady ? now : snapshot.onboarding.lastReserveCheckAt,
      },
      reserve: nextReserve,
    };
  });

  return prependStatus(nextState, translate("service.wallet.status.syncLocalProtocol"), syncNotes);
}

async function requireProtocolStateForReserve(state: WalletState): Promise<WalletState> {
  if (!state.manifest) {
    throw new Error(translate("service.wallet.error.manifestUnavailable"));
  }
  if (!state.profile) {
    throw new Error(translate("service.wallet.error.createBeforeSigning"));
  }

  const protocolState = await ensureWalletProtocolState({
    profile: state.profile,
    devicePublicKey: state.manifest.publicKey ?? state.manifest.deviceId,
    allowOnChainMutation: true,
  });
  const now = new Date().toISOString();
  const reserveBalanceSol = Number.parseFloat(protocolState.reserve.sol);
  const capacityAmount =
    protocolState.reserve.capacityAvailableSol ?? protocolState.reserve.capacityIssuedSol ?? "0";
  const pendingExposureAmount = calculatePendingOfflineExposure(state.journal);

  return prependStatus(
    updateActiveSnapshot(state, (snapshot) => ({
      ...snapshot,
      balances: applyProtocolCapacityToBalances(snapshot.balances, capacityAmount, pendingExposureAmount),
      onboarding: {
        ...snapshot.onboarding,
        rpcReachable: false,
        deviceKeyReady: Boolean(state.manifest?.publicKey),
        onChainProfileReady: true,
        reserveReady: reserveBalanceSol > 0,
        quarantined: false,
        executionSource: "local",
        lastProtocolSyncAt: now,
        lastReserveCheckAt: now,
      },
      reserve: {
        ...snapshot.reserve,
        totalAmount: reserveBalanceSol,
        remainingAmount: reserveBalanceSol,
        remainingTransfers: reserveBalanceSol > 0 ? Number.MAX_SAFE_INTEGER : 0,
        expiresAt: snapshot.reserve.expiresAt,
      },
    })),
    translate("service.wallet.status.syncLocalProtocol"),
  );
}

export async function createCustodyWalletState(
  state: WalletState,
  input: {
    passphrase: string;
    displayName?: string;
  },
): Promise<{ state: WalletState; mnemonic: string }> {
  const provisioning = await createMnemonicWallet({
    passphrase: input.passphrase,
    displayName: input.displayName,
  });
  const profile = attachReputationLineageToProfile(provisioning.profile, {
    manifest: state.manifest,
    snapshots: state.walletSnapshots,
    currentJournal: state.journal,
  });
  const balances = await fetchWalletBalances(profile.solanaAddress);
  const snapshot = buildWalletSnapshot(state, profile, provisioning.security, balances);
  let nextState = upsertWalletSnapshot(
    {
      ...state,
      manifest: withWalletManifest(state.manifest, profile),
    },
    snapshot,
  );
  nextState = prependStatus(
    nextState,
    translate("service.wallet.status.walletCreated", {
      address: `${profile.solanaAddress.slice(0, 8)}...`,
      path: profile.derivationPath,
    }),
  );

  try {
    nextState = await refreshProtocolStateInternal(nextState, {
      registerWallet: true,
      provisionBudget: false,
      allowOnChainMutation: true,
    });
  } catch (error) {
    nextState = prependStatus(
      nextState,
      translate("service.wallet.status.walletCreatedDeferred", {
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
  }

  return {
    state: nextState,
    mnemonic: provisioning.mnemonic,
  };
}

export async function importCustodyWalletState(
  state: WalletState,
  input: {
    mnemonic: string;
    passphrase: string;
    displayName?: string;
  },
): Promise<{ state: WalletState; mnemonic: string }> {
  const provisioning = await importMnemonicWallet({
    mnemonic: input.mnemonic,
    passphrase: input.passphrase,
    displayName: input.displayName,
  });
  const profile = attachReputationLineageToProfile(provisioning.profile, {
    manifest: state.manifest,
    snapshots: state.walletSnapshots,
    currentJournal: state.journal,
  });
  const balances = await fetchWalletBalances(profile.solanaAddress);
  const snapshot = buildWalletSnapshot(state, profile, provisioning.security, balances);
  let nextState = upsertWalletSnapshot(
    {
      ...state,
      manifest: withWalletManifest(state.manifest, profile),
    },
    snapshot,
  );
  nextState = updateActiveSnapshot(nextState, (active) => ({
    ...active,
    profile: {
      ...active.profile,
      backupConfirmedAt: profile.backupConfirmedAt,
    },
  }));
  nextState = prependStatus(
    nextState,
    translate("service.wallet.status.walletImported", {
      address: `${profile.solanaAddress.slice(0, 8)}...`,
    }),
  );

  try {
    nextState = await refreshProtocolStateInternal(nextState, {
      registerWallet: true,
      provisionBudget: true,
      allowOnChainMutation: true,
      deferredStatusKey: "service.wallet.status.walletImportedDeferred",
    });
  } catch (error) {
    nextState = prependStatus(
      nextState,
      translate("service.wallet.status.walletImportedDeferred", {
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
  }

  return {
    state: nextState,
    mnemonic: provisioning.mnemonic,
  };
}

export async function selectActiveWalletState(state: WalletState, walletId: string): Promise<WalletState> {
  const metadata = await setActiveWallet(walletId);
  if (!metadata) {
    return state;
  }

  const snapshot = state.walletSnapshots[walletId] ?? snapshotFromMetadata(state.manifest?.deviceId ?? "airpay-demo", metadata);
  const nextState = projectActiveWalletState({
    ...state,
    activeWalletId: walletId,
    walletSnapshots: {
      ...state.walletSnapshots,
      [walletId]: snapshot,
    },
    walletRegistry: replaceRegistryEntry(state.walletRegistry, snapshot.profile, walletId),
  });

  return prependStatus(
    nextState,
    `${snapshot.profile.displayName} ${translate("wallet.registry.active").toLowerCase()}.`,
  );
}

export async function importWalletCertificateState(
  state: WalletState,
  input: {
    pfxBase64: string;
    password: string;
    fileName?: string;
  },
): Promise<WalletState> {
  if (!state.profile) {
    throw new Error(translate("service.wallet.error.createBeforeSigning"));
  }

  const certificateProfile = await importWalletCertificateFromBase64({
    walletId: state.profile.walletId,
    pfxBase64: input.pfxBase64,
    password: input.password,
    fileName: input.fileName,
  });

  return prependStatus(
    updateActiveSnapshot(state, (snapshot) => ({
      ...snapshot,
      profile: {
        ...snapshot.profile,
        certificateProfile,
      },
      security: {
        ...snapshot.security,
        certificateImportedAt: certificateProfile.importedAt,
        certificateBacked: Boolean(certificateProfile.algorithm),
      },
    })),
    translate("wallet.certificate.ready"),
  );
}

export async function revealCustodyMnemonicState(
  state: WalletState,
): Promise<{ state: WalletState; mnemonic: string }> {
  if (!state.profile) {
    throw new Error(translate("service.wallet.error.createBeforeBackup"));
  }

  const revelation = await revealMnemonic(state.profile.walletId);
  return {
    state: prependStatus(
      updateActiveSnapshot(state, (snapshot) => ({
        ...snapshot,
        security: {
          ...snapshot.security,
          ...revelation.security,
        },
      })),
      translate("service.wallet.status.mnemonicRevealed"),
    ),
    mnemonic: revelation.mnemonic,
  };
}

export function confirmWalletBackup(state: WalletState): WalletState {
  if (!state.profile) {
    throw new Error(translate("service.wallet.error.createBeforeBackup"));
  }

  return prependStatus(
    updateActiveSnapshot(state, (snapshot) => ({
      ...snapshot,
      profile: updateBackupConfirmation(snapshot.profile),
    })),
    translate("service.wallet.status.backupConfirmed"),
  );
}

export async function confirmWalletBackupAndRefreshProtocolState(state: WalletState): Promise<WalletState> {
  const confirmed = confirmWalletBackup(state);
  try {
    return await refreshProtocolStateInternal(confirmed, {
      registerWallet: true,
      provisionBudget: true,
    });
  } catch (error) {
    return prependStatus(
      confirmed,
      translate("service.wallet.status.backupPendingProvisioning", {
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

export async function refreshProtocolState(
  state: WalletState,
  input?: {
    requestedAmount?: number;
    requestedTransfers?: number;
    allowOnChainMutation?: boolean;
  },
): Promise<WalletState> {
  return refreshProtocolStateInternal(state, {
    registerWallet: true,
    provisionBudget: true,
    allowOnChainMutation: input?.allowOnChainMutation,
    requestedAmount: input?.requestedAmount,
    requestedTransfers: input?.requestedTransfers,
  });
}

export async function syncPromiseStates(state: WalletState): Promise<WalletState> {
  if (!state.profile) {
    throw new Error(translate("service.wallet.error.createBeforeSigning"));
  }

  const processed = await processIncomingPromises({
    profile: state.profile,
    journal: state.journal,
  });
  const trustEvents: Array<{ peerId: string; kind: "claimed" | "settled" | "rejected"; amount?: number }> = [];

  const hasUpdates = processed.states.size > 0;
  const nextState = updateActiveSnapshot(state, (snapshot) => ({
    ...snapshot,
    journal: snapshot.journal.map((entry) => {
      if (!entry.promiseId) {
        return entry;
      }

      const chainState = processed.states.get(entry.promiseId);
      if (!chainState) {
        return entry;
      }

       const peerId =
        entry.senderAddress === state.profile?.solanaAddress
          ? resolvePeerIdForOutgoingTransfer(entry)
          : resolvePeerIdForIncomingTransfer(entry);
      if (chainState.status === "claimed" && entry.claimStatus !== "claimed") {
        trustEvents.push({ peerId, kind: "claimed", amount: entry.amount });
      }
      if (chainState.status === "settled" && entry.settlementStatus !== "reconciled") {
        trustEvents.push({ peerId, kind: "settled", amount: entry.amount });
      }
      if (chainState.status === "rejected_structural" && entry.claimStatus !== "rejected_structural") {
        trustEvents.push({ peerId, kind: "rejected", amount: entry.amount });
      }

      return {
        ...entry,
        claimStatus: chainState.status,
        settlementStatus: chainState.status === "settled" ? "reconciled" : entry.settlementStatus,
      };
    }),
  }));

  if (!hasUpdates) {
    return prependStatus(nextState, translate("service.wallet.status.syncLocalProtocol"));
  }

  await Promise.all(trustEvents.map((event) => persistTrustInteraction(event.peerId, event.kind, event.amount)));

  return prependStatus(
    nextState,
    translate("service.wallet.status.syncLocalProtocol"),
    processed.logs,
  );
}

export async function fundReserveState(
  state: WalletState,
  input: {
    amount: string;
  },
): Promise<WalletState> {
  if (!state.profile) {
    throw new Error(translate("service.wallet.error.createBeforeSigning"));
  }

  const prepared = await requireProtocolStateForReserve(state);
  const signature = await fundReserveOnChain({
    profile: prepared.profile ?? state.profile,
    amount: input.amount,
  });
  const synced = await refreshProtocolStateInternal(prepared, {
    registerWallet: true,
    provisionBudget: true,
  });
  const refreshed = await refreshWalletBalancesState(synced);
  return prependStatus(
    refreshed,
    translate("service.wallet.status.reserveFunded", {
      amount: input.amount,
      signature: signature.slice(0, 12),
    }),
  );
}

export async function withdrawReserveState(
  state: WalletState,
  input: {
    amount: string;
  },
): Promise<WalletState> {
  if (!state.profile) {
    throw new Error(translate("service.wallet.error.createBeforeSigning"));
  }

  const prepared = await requireProtocolStateForReserve(state);
  const signature = await withdrawReserveOnChain({
    profile: prepared.profile ?? state.profile,
    amount: input.amount,
  });
  const synced = await refreshProtocolStateInternal(prepared, {
    registerWallet: true,
    provisionBudget: true,
  });
  const refreshed = await refreshWalletBalancesState(synced);
  return prependStatus(
    refreshed,
    translate("service.wallet.status.reserveWithdrawn", {
      amount: input.amount,
      signature: signature.slice(0, 12),
    }),
  );
}

export async function refreshWalletBalancesState(state: WalletState): Promise<WalletState> {
  if (!state.profile) {
    throw new Error(translate("service.wallet.error.createBeforeRefresh"));
  }

  const [balances, reserveBalance] = await Promise.all([
    fetchWalletBalances(state.profile.solanaAddress, {
      fallbackBalances: state.balances,
    }),
    fetchReserveBalance(state.profile),
  ]);
  const balancesWithCapacity = applyProtocolCapacityToBalances(
    balances,
    reserveBalance.capacityAvailableSol ?? reserveBalance.capacityIssuedSol ?? "0",
    calculatePendingOfflineExposure(state.journal),
  );
  return prependStatus(
    updateActiveSnapshot(state, (snapshot) => ({
      ...snapshot,
      balances: balancesWithCapacity,
      reserve: {
        ...snapshot.reserve,
        totalAmount: Number.parseFloat(reserveBalance.sol),
        remainingAmount: Number.parseFloat(reserveBalance.sol),
        remainingTransfers: Number.parseFloat(reserveBalance.sol) > 0 ? Number.MAX_SAFE_INTEGER : 0,
        expiresAt: snapshot.reserve.expiresAt,
      },
    })),
    translate("service.wallet.status.balancesRefreshed"),
  );
}

export async function queueChainTransferState(
  state: WalletState,
  input: {
    assetId: "SOL";
    toAddress: string;
    amount: string;
    memo?: string;
    reference?: string;
  },
): Promise<WalletState> {
  if (!state.profile) {
    throw new Error(translate("service.wallet.error.createBeforeSigning"));
  }
  if (state.onboarding.quarantined) {
    throw new Error(translate("service.wallet.error.quarantinedChain"));
  }
  assertChainTransferInput({
    toAddress: input.toAddress,
    amount: input.amount,
  });
  if (input.assetId !== "SOL") {
    throw new Error(translate("service.wallet.error.assetUnsupported"));
  }
  const requestedAmount = parseFiniteAmount(input.amount);
  const queuedExposure = calculatePendingSolQueueExposure(state.pendingChainTransactions);
  const availableSol = parseFiniteAmount(state.balances.SOL.amount);
  if (requestedAmount + queuedExposure > availableSol + Number.EPSILON) {
    throw new Error(
      translate("service.wallet.error.insufficientSolForQueue", {
        available: state.balances.SOL.amount,
        queued: queuedExposure.toFixed(9).replace(/\.?0+$/, ""),
      }),
    );
  }

  const { intent, envelope } = await prepareSignedSolanaTransfer({
    walletId: state.profile.walletId,
    assetId: input.assetId,
    toAddress: input.toAddress,
    amount: input.amount,
    memo: input.memo,
    reference: input.reference,
  });
  const pending: PendingChainTransaction = {
    walletId: state.profile.walletId,
    walletType: state.profile.walletType,
    intent,
    envelope,
    status: intent.requiresOnlineAssembly ? "queued" : "signed",
  };

  return prependStatus(
    updateActiveSnapshot(state, (snapshot) => ({
      ...snapshot,
      pendingChainTransactions: [pending, ...snapshot.pendingChainTransactions].slice(0, 20),
    })),
    translate("service.wallet.status.intentSigned", {
      assetId: input.assetId,
      intentId: intent.intentId,
      toAddress: `${input.toAddress.slice(0, 8)}...`,
    }),
    intent.requiresOnlineAssembly
      ? [translate("service.wallet.status.intentQueued")]
      : [translate("service.wallet.status.intentSerialized")],
  );
}

export async function submitPendingChainTransactionsState(state: WalletState): Promise<WalletState> {
  if (!state.profile || !state.manifest) {
    throw new Error(translate("service.wallet.error.walletManifestRequired"));
  }

  const blockhash = await fetchLatestBlockhash();
  const nextTransactions: PendingChainTransaction[] = [];

  for (const pending of state.pendingChainTransactions) {
    if (pending.status === "submitted" || pending.status === "confirmed") {
      nextTransactions.push(pending);
      continue;
    }

    let candidate = pending;
    if (!candidate.envelope.serializedTransaction && blockhash) {
      const refreshed = await prepareSignedSolanaTransfer({
        walletId: state.profile.walletId,
        assetId: candidate.intent.assetId,
        toAddress: candidate.intent.toAddress,
        amount: candidate.intent.amount,
        memo: candidate.intent.memo,
        reference: candidate.intent.reference,
        recentBlockhash: blockhash,
      });
      candidate = {
        walletId: state.profile.walletId,
        walletType: state.profile.walletType,
        intent: {
          ...candidate.intent,
          walletId: refreshed.intent.walletId,
          walletType: refreshed.intent.walletType,
          recentBlockhash: refreshed.intent.recentBlockhash,
          requiresOnlineAssembly: refreshed.intent.requiresOnlineAssembly,
          tokenMint: refreshed.intent.tokenMint,
        },
        envelope: refreshed.envelope,
        status: "signed",
      };
    }

    if (!candidate.envelope.serializedTransaction && !blockhash) {
      nextTransactions.push({
        ...candidate,
        status: "queued",
        lastError: translate("service.chain.status.waitingOnlineAssembly"),
      });
      continue;
    }

    const submission = await submitPendingChainTransaction({
      deviceId: state.manifest.deviceId,
      walletId: state.profile.walletId,
      transaction: candidate,
    });

    nextTransactions.push({
      ...candidate,
      status: submission.status,
      txSignature: submission.txSignature,
      metadataAnchorTx: submission.metadataAnchorTx ?? candidate.metadataAnchorTx,
      metadataPayloadHash: submission.metadataPayloadHash ?? candidate.metadataPayloadHash,
      submittedAt: submission.submittedAt,
      confirmedAt: submission.confirmedAt ?? candidate.confirmedAt,
      lastError: submission.lastError,
    });
  }

  return prependStatus(
    updateActiveSnapshot(state, (snapshot) => ({
      ...snapshot,
      pendingChainTransactions: nextTransactions,
    })),
    translate("service.wallet.status.chainProcessed"),
  );
}

export async function refreshPendingChainTransactionsState(
  state: WalletState,
  options: { log?: boolean } = {},
): Promise<WalletState> {
  if (!state.profile) {
    return state;
  }

  const signatures = state.pendingChainTransactions
    .map((transaction) => transaction.txSignature)
    .filter((signature): signature is string => Boolean(signature));
  const statuses = await fetchSignatureStatuses(signatures);
  const mergedTransactions = state.pendingChainTransactions.map((transaction) => {
    if (!transaction.txSignature) {
      return transaction;
    }

    const nextStatus = statuses[transaction.txSignature];
    if (!nextStatus) {
      return transaction;
    }

    if (nextStatus === "confirmed") {
      return {
        ...transaction,
        status: "confirmed" as const,
        confirmedAt: transaction.confirmedAt ?? new Date().toISOString(),
      };
    }

    if (nextStatus === "failed") {
      return {
        ...transaction,
        status: "failed" as const,
        lastError: transaction.lastError ?? translate("service.chain.error.submitSigned"),
      };
    }

    return {
      ...transaction,
      status: "submitted" as const,
    };
  });
  let remoteTransactions: PendingChainTransaction[] = [];
  if (state.manifest) {
    try {
      remoteTransactions = await fetchPendingChainTransactionsFromBackend({
        deviceId: state.manifest.deviceId,
        walletId: state.profile.walletId,
      });
    } catch {
      remoteTransactions = [];
    }
  }
  const nextState = updateActiveSnapshot(state, (snapshot) => ({
    ...snapshot,
    pendingChainTransactions: mergePendingTransactions(mergedTransactions, remoteTransactions),
  }));

  if (options.log === false) {
    return nextState;
  }

  return prependStatus(nextState, translate("service.wallet.status.chainRefreshed"));
}

function attachTransferSignatureBundle(
  transfer: OfflineTransfer,
  signatureBundle: PromiseSignatureBundle,
): OfflineTransfer {
  const { txHash: _ignored, ...rest } = transfer;
  const nextTransfer: OfflineTransfer = {
    ...rest,
    signingAlgorithms: signatureBundle.signatures.map((signature) => signature.algorithm),
    signatureBundle,
  };

  return {
    ...nextTransfer,
    txHash: sha256Hex(nextTransfer),
  };
}

function buildTransferSigningMessage(
  transfer: OfflineTransfer,
): { canonicalPayload: string; digest: string; payloadHash: string; payloadVersion: 1 | 2 | 3 } {
  if (!transfer.promiseId || !transfer.senderAddress || !transfer.receiverAddress) {
    throw new Error(translate("service.offair.error.promiseIncomplete"));
  }
  const amountLamports = parseUiAmountToLamports(String(transfer.amount));
  const payloadHash = transfer.txHash ?? sha256Hex(transfer);
  const settlementMode =
    transfer.offlineSettlementTier === "verified_offline"
      ? OFFLINE_SETTLEMENT_MODE_VERIFIED
      : OFFLINE_SETTLEMENT_MODE_FAST;
  return {
    ...buildOffAirClaimSigningPayload({
      promiseId: transfer.promiseId,
      senderAddress: transfer.senderAddress,
      receiverAddress: transfer.receiverAddress,
      amountLamports: amountLamports.toString(),
      offairAmount: amountLamports.toString(),
      payloadHash,
      settlementMode,
      receiptMaterializationRequired: transfer.receiptMaterializationRequired ?? false,
      version: 3,
    }),
    payloadHash,
  };
}

async function createHybridPromiseBundle(input: {
  state: WalletState;
  transfer: OfflineTransfer;
}): Promise<PromiseSignatureBundle> {
  const signingPayload = buildTransferSigningMessage(input.transfer);
  const walletSignatures = await createWalletPromiseSignatures({
    walletId: input.state.profile?.walletId,
    message: signingPayload.canonicalPayload,
  });
  const deviceSignature = await signPayload(signingPayload.canonicalPayload);

  return {
    payloadVersion: signingPayload.payloadVersion,
    payloadHash: signingPayload.payloadHash,
    digest: signingPayload.digest,
    createdAt: new Date().toISOString(),
    certificateProfile: walletSignatures.certificateProfile ?? undefined,
    signatures: [
      {
        role: "device" satisfies PromiseSignatureRole,
        algorithm: "ecdsa-p256",
        signature: deviceSignature,
        publicKey: input.state.manifest?.publicKey,
        keyId: input.state.manifest?.keyAlias ?? `device:${input.state.manifest?.deviceId ?? "unknown"}`,
      },
      ...walletSignatures.signatures,
    ],
  };
}

async function submitDirectSolTransfer(input: {
  state: WalletState;
  toAddress: string;
  amount: number;
}): Promise<{
  pendingTransaction: PendingChainTransaction;
  txSignature: string;
}> {
  if (!input.state.profile || !input.state.manifest) {
    throw new Error(translate("service.wallet.error.walletManifestRequired"));
  }

  const recentBlockhash = await fetchLatestBlockhash();
  if (!recentBlockhash) {
    throw new Error(translate("service.wallet.error.directSolUnavailable"));
  }

  const prepared = await prepareSignedSolanaTransfer({
    walletId: input.state.profile.walletId,
    assetId: "SOL",
    toAddress: input.toAddress,
    amount: String(input.amount),
    recentBlockhash,
  });
  const pending: PendingChainTransaction = {
    walletId: input.state.profile.walletId,
    walletType: input.state.profile.walletType,
    intent: prepared.intent,
    envelope: prepared.envelope,
    status: "signed",
  };
  const submission = await submitPendingChainTransaction({
    deviceId: input.state.manifest.deviceId,
    walletId: input.state.profile.walletId,
    transaction: pending,
  });
  if (submission.status === "failed" || !submission.txSignature) {
    throw new Error(submission.lastError ?? translate("service.chain.error.submitSigned"));
  }

  return {
    pendingTransaction: {
      ...pending,
      status: submission.status,
      txSignature: submission.txSignature,
      metadataAnchorTx: submission.metadataAnchorTx,
      metadataPayloadHash: submission.metadataPayloadHash,
      submittedAt: submission.submittedAt,
      confirmedAt: submission.confirmedAt,
    },
    txSignature: submission.txSignature,
  };
}

export async function sendOfflineTransfer(
  state: WalletState,
  input: {
    amount: number;
    peerAlias?: string;
    allowTrustWarning?: boolean;
    session?: ActiveTransportSession;
    sessionSettlementMode?: SessionSettlementMode;
  },
): Promise<WalletState> {
  if (!state.manifest) {
    throw new Error(translate("service.wallet.error.manifestUnavailable"));
  }
  if (!state.profile) {
    throw new Error(translate("service.wallet.error.createBeforeSigning"));
  }
  assertOfflineTransferInput(input);
  if (state.onboarding.quarantined) {
    throw new Error(translate("service.wallet.error.quarantinedOffline"));
  }
  if (!isOfflineReady(state)) {
    throw new Error(translate("service.wallet.error.offlineWalletNotReady"));
  }

  const risk: RiskSnapshot = scoreRisk({
    daysOffline: 0,
    pendingTransfers: state.journal.length,
    aggregatePendingAmount: state.journal.reduce((total, entry) => total + entry.amount, 0),
    journalGapCount: 0,
    inconsistentHistoryCount: 0,
    attestationValid: state.manifest.attestationValid,
  });
  const baseRoot = buildBaseRoot({
    journal: state.journal,
  });
  const session =
    input.session ??
    (await bootstrapOfflineSession({
      manifest: state.manifest,
      baseRoot,
      counter: state.journal.length + 1,
    }));
  const senderRpcReachable = await probeRpcReachability().catch(() => false);
  const sessionSettlementMode =
    input.sessionSettlementMode ??
    (senderRpcReachable
      ? "direct_sol"
      : session.peerRpcReachable && session.peerInstantClaimCapable
        ? "instant_claim"
        : "offline_promise");
  const offlineSettlementTier =
    sessionSettlementMode === "offline_promise" && requiresVerifiedOfflineSettlement(state)
      ? "verified_offline"
      : undefined;
  if (sessionSettlementMode === "offline_promise") {
    assertOfflinePromiseWithinLimits(state, input.amount, risk, offlineSettlementTier);
  }
  let transportHandedOff = false;

  try {
    const resolvedPeerAlias =
      session.peerDisplayName?.trim() ||
      input.peerAlias?.trim() ||
      buildPeerAliasFallback(session.peerProofDigest.deviceId);
    await persistTrustInteraction(session.peerWalletAddress ?? session.peerProofDigest.deviceId, "encountered");
    const trustState = await loadLocalTrustState();
    const trustDecision = evaluatePeerTrustDecision(trustState, {
      peerIds: [session.peerWalletAddress ?? "", session.peerProofDigest.deviceId],
    });

    if (trustDecision.decision === "block") {
      throw new Error(
        translate("service.wallet.error.peerBlockedLocal", {
          peer: resolvedPeerAlias,
        }),
      );
    }

    if (input.allowTrustWarning && trustDecision.decision === "warn" && trustDecision.riskLevel !== "guarded") {
      throw new Error(
        translate("service.wallet.error.peerOverrideNotAllowed", {
          peer: resolvedPeerAlias,
        }),
      );
    }

    if (trustDecision.decision === "warn" && !input.allowTrustWarning) {
      throw new SendTrustWarningError({
        amount: input.amount,
        peerAlias: input.peerAlias ?? resolvedPeerAlias,
        peerLabel: resolvedPeerAlias,
        peerId: trustDecision.peerId,
        trustBand: trustDecision.trustBand,
        trustScore: trustDecision.trustScore,
        riskLevel: trustDecision.riskLevel,
        riskScore: trustDecision.riskScore,
        reasons: trustDecision.reasons,
      });
    }

    const transferDraft = createOfflineTransfer({
      sessionId: session.sessionId,
      senderPseudoId: state.manifest.deviceId,
      receiverPseudoId: session.peerProofDigest.deviceId,
      senderAddress: state.profile.solanaAddress,
      receiverAddress: session.peerWalletAddress,
      walletId: state.profile.walletId,
      walletType: state.profile.walletType,
      amount: input.amount,
      assetId: sessionSettlementMode === "direct_sol" ? "SOL" : "OFFAIR",
      existingJournal: state.journal,
      epoch: state.manifest.epoch,
      policyHash: state.policy.policyHash,
      risk,
      peerProof: session.peerProofDigest,
      sessionSettlementMode,
      offlineSettlementTier,
      receiptMaterializationRequired: offlineSettlementTier === "verified_offline" ? true : undefined,
    });

    let preparedTransfer = transferDraft;
    let pendingTransactions = state.pendingChainTransactions;

    if (sessionSettlementMode === "direct_sol") {
      if (!session.peerWalletAddress) {
        throw new Error(translate("service.wallet.error.directSolReceiverUnavailable"));
      }
      const directSettlement = await submitDirectSolTransfer({
        state,
        toAddress: session.peerWalletAddress,
        amount: input.amount,
      });
      preparedTransfer = rewriteTransfer(transferDraft, {
        claimStatus: "settled",
        settlementStatus: "reconciled",
        directSettlementSignature: directSettlement.txSignature,
      });
      pendingTransactions = [directSettlement.pendingTransaction, ...state.pendingChainTransactions].slice(0, 20);
    } else {
      const signatureBundle = await createHybridPromiseBundle({
        state,
        transfer: transferDraft,
      });
      preparedTransfer = attachTransferSignatureBundle(transferDraft, signatureBundle);
    }

    transportHandedOff = true;
    const { receipt } = await transmitOfflineTransfer({
      session,
      manifest: state.manifest,
      baseRoot,
      counter: state.journal.length + 1,
      transfer: preparedTransfer,
    });
    transportHandedOff = false;
    const resolvedTransfer = applyReceiptResolutionToTransfer(preparedTransfer, receipt);
    const transfer = appendReceipt(resolvedTransfer, receipt);
    await persistTrustInteraction(resolvePeerIdForOutgoingTransfer(transfer), "sent", transfer.amount);

    return prependStatus(
      updateActiveSnapshot(state, (snapshot) => ({
        ...snapshot,
        pendingChainTransactions: pendingTransactions,
        journal: [...snapshot.journal, transfer],
        reserve:
          sessionSettlementMode === "offline_promise"
            ? {
                ...snapshot.reserve,
                remainingAmount: Math.max(0, snapshot.reserve.remainingAmount - input.amount),
                remainingTransfers: Math.max(0, snapshot.reserve.remainingTransfers - 1),
              }
            : snapshot.reserve,
        balances:
          sessionSettlementMode === "offline_promise"
            ? {
                ...snapshot.balances,
                OFFAIR: {
                  ...snapshot.balances.OFFAIR,
                  amount: Math.max(0, Number.parseFloat(snapshot.balances.OFFAIR.amount) - input.amount).toString(),
                  source: "cached",
                  lastUpdatedAt: new Date().toISOString(),
                },
              }
            : snapshot.balances,
      })),
      translate("service.wallet.status.transferSent", {
        transferId: transfer.localTxId,
        peerAlias: resolvedPeerAlias,
        mode: session.mode.toUpperCase(),
        promoted: String(session.promotedToBle),
      }),
      [
        ...(trustDecision.decision === "warn"
          ? [
              translate("service.wallet.status.peerTrustWarn", {
                peer: resolvedPeerAlias,
              }),
            ]
          : []),
        ...(sessionSettlementMode === "direct_sol" && transfer.directSettlementSignature
          ? [
              translate("service.wallet.status.directSolSettled", {
                signature: transfer.directSettlementSignature.slice(0, 12),
              }),
            ]
          : []),
        ...(sessionSettlementMode === "instant_claim"
          ? [translate("service.wallet.status.instantClaimNegotiated")]
          : []),
        ...session.diagnostics,
      ],
    );
  } catch (error) {
    if (!transportHandedOff) {
      await closeTransportSession(session).catch(() => undefined);
    }
    throw error;
  }
}

export async function recordIncomingTransfer(
  state: WalletState,
  transfer: OfflineTransfer,
  diagnostics: string[],
): Promise<WalletState> {
  const duplicate = state.journal.find(
    (entry) =>
      entry.localTxId === transfer.localTxId ||
      (entry.promiseId && transfer.promiseId && entry.promiseId === transfer.promiseId) ||
      (entry.signatureBundle?.payloadHash &&
        transfer.signatureBundle?.payloadHash &&
        entry.signatureBundle.payloadHash === transfer.signatureBundle.payloadHash),
  );
  if (duplicate) {
    throw new Error(`Duplicate offline transfer rejected: ${transfer.localTxId}`);
  }
  await persistTrustInteraction(resolvePeerIdForIncomingTransfer(transfer), "received", transfer.amount);
  return prependStatus(
    updateActiveSnapshot(state, (snapshot) => ({
      ...snapshot,
      journal: [...snapshot.journal, transfer],
    })),
    translate("service.wallet.status.transferReceived", {
      transferId: transfer.localTxId,
    }),
    diagnostics,
  );
}

export function canArmReceiver(state: WalletState): { ok: boolean; reason?: string } {
  if (!state.manifest) {
    return {
      ok: false,
      reason: translate("service.wallet.error.receiverManifest"),
    };
  }
  if (!state.profile) {
    return {
      ok: false,
      reason: translate("send.walletRequired.body"),
    };
  }
  if (state.onboarding.quarantined) {
    return {
      ok: false,
      reason: translate("service.wallet.error.receiverQuarantined"),
    };
  }

  return { ok: true };
}
