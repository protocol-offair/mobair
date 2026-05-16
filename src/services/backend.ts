import type {
  AllowlistPolicy,
  DeviceManifest,
  OfflineBudget,
  OfflineVoucher,
  PendingChainTransaction,
  RiskSnapshot,
  WalletProfile,
  WalletRegistryEntry,
} from "@protocol-offair/shared";

import { getWalletRuntimeConfig, readErrorResponse, readJsonResponse } from "./chain";
import { buildClientSignatureHeaders } from "./clientSignature";
import { signWalletMessage } from "./custody";
import { postMaybeSecureJson } from "./transportSecurity";

type BackendWalletType = "global" | "individual" | "business";
type BackendChainTransactionStatus = "signed" | "queued" | "submitted" | "confirmed" | "failed";

interface BackendPolicy {
  policy_id: string;
  policy_hash: string;
  min_epoch: number;
  allowed_state_roots: string[];
  revoked_state_roots: string[];
  max_offline_transfers: number;
  max_offline_amount: number;
  fast_offline_new_user_limit_lamports?: number | string | null;
  fast_offline_trusted_limit_lamports?: number | string | null;
  fast_offline_high_trust_limit_lamports?: number | string | null;
  verified_offline_min_lamports?: number | string | null;
  allow_ble_fallback: boolean;
  expires_at: string;
}

interface BackendRisk {
  score: number;
  band: RiskSnapshot["band"];
  reasons: string[];
  computed_at: string;
}

interface BackendOfflineBudget {
  budget_id: string;
  device_id: string;
  asset_id: string;
  total_amount: number;
  remaining_amount: number;
  remaining_transfers: number;
  expires_at: string;
}

interface BackendOfflineVoucher {
  voucher_id: string;
  owner_device_id: string;
  wallet_id?: string | null;
  amount: number;
  asset_id: string;
  epoch: number;
  expires_at: string;
  issuer_signature: string;
  status: OfflineVoucher["status"];
}

interface BackendSolanaTransferIntent {
  intent_id: string;
  wallet_id?: string | null;
  wallet_type?: BackendWalletType | null;
  asset_id: "AIR" | "SOL";
  from_address: string;
  to_address: string;
  amount: string;
  decimals: number;
  created_at: string;
  memo?: string | null;
  reference?: string | null;
  recent_blockhash?: string | null;
  token_mint?: string | null;
  requires_online_assembly: boolean;
}

interface BackendSignedEnvelope {
  intent_id: string;
  public_key: string;
  signed_message: string;
  signature: string;
  signed_at: string;
  serialized_transaction?: string | null;
}

interface BackendPendingChainTransaction {
  wallet_id?: string | null;
  wallet_type?: BackendWalletType | null;
  intent: BackendSolanaTransferIntent;
  envelope: BackendSignedEnvelope;
  status: BackendChainTransactionStatus;
  tx_signature?: string | null;
  metadata_anchor_tx?: string | null;
  metadata_payload_hash?: string | null;
  last_error?: string | null;
  submitted_at?: string | null;
  confirmed_at?: string | null;
}

interface BackendWalletRegistrationResponse {
  wallet_id: string;
  wallet_type: BackendWalletType;
  display_name: string;
  document_type?: WalletProfile["documentType"] | null;
  document_id?: string | null;
  birth_date?: string | null;
  business_name?: string | null;
  responsible_name?: string | null;
  responsible_document_id?: string | null;
  solana_address: string;
  wallet_public_key: string;
  post_quantum_public_key?: string | null;
  identity_derivation_version?: number | null;
  identity_context_hash?: string | null;
  identity_public_key?: string | null;
  public_key_anchored?: boolean;
  public_key_anchor_tx?: string | null;
  public_key_anchored_at?: string | null;
  backup_confirmed_at?: string | null;
  is_active_on_device: boolean;
  created_at: string;
}

interface BackendGatewayWalletAuthChallengeResponse {
  message: string;
  nonce: string;
  expires_at?: string;
  expiresAt?: string;
  wallet_public_key?: string;
  walletPublicKey?: string;
}

interface BackendGatewayWalletSessionResponse {
  access_token?: string;
  accessToken?: string;
  token_type?: "airpay-wallet-signature";
  tokenType?: "airpay-wallet-signature";
  expires_at?: string;
  expiresAt?: string;
  wallet_public_key?: string;
  walletPublicKey?: string;
  wallet_address?: string | null;
  walletAddress?: string | null;
  wallet_id?: string | null;
  walletId?: string | null;
}

export interface DeviceBackendRegistration {
  policy: AllowlistPolicy;
  risk: RiskSnapshot;
  quarantined: boolean;
}

export interface BackendBudgetProvisioning {
  budget: OfflineBudget;
  vouchers: OfflineVoucher[];
  policy: AllowlistPolicy;
}

export interface GatewayWalletSessionSync {
  accessToken: string;
  tokenType: "airpay-wallet-signature";
  expiresAt: string;
  walletPublicKey: string;
  walletAddress?: string | null;
  walletId?: string | null;
}

function buildBackendUrl(path: string): string | null {
  const backendUrl = getWalletRuntimeConfig().backendUrl;
  if (!backendUrl) {
    return null;
  }

  return `${backendUrl.replace(/\/+$/, "")}${path}`;
}

function mapPolicy(policy: BackendPolicy): AllowlistPolicy {
  return {
    policyId: policy.policy_id,
    policyHash: policy.policy_hash,
    minEpoch: policy.min_epoch,
    allowedStateRoots: policy.allowed_state_roots,
    revokedStateRoots: policy.revoked_state_roots,
    maxOfflineTransfers: policy.max_offline_transfers,
    maxOfflineAmount: policy.max_offline_amount,
    fastOfflineNewUserLimitLamports:
      policy.fast_offline_new_user_limit_lamports != null ? String(policy.fast_offline_new_user_limit_lamports) : undefined,
    fastOfflineTrustedLimitLamports:
      policy.fast_offline_trusted_limit_lamports != null ? String(policy.fast_offline_trusted_limit_lamports) : undefined,
    fastOfflineHighTrustLimitLamports:
      policy.fast_offline_high_trust_limit_lamports != null ? String(policy.fast_offline_high_trust_limit_lamports) : undefined,
    verifiedOfflineMinLamports:
      policy.verified_offline_min_lamports != null ? String(policy.verified_offline_min_lamports) : undefined,
    allowBleFallback: policy.allow_ble_fallback,
    expiresAt: policy.expires_at,
  };
}

function mapRisk(risk: BackendRisk): RiskSnapshot {
  return {
    score: risk.score,
    band: risk.band,
    reasons: risk.reasons,
    computedAt: risk.computed_at,
  };
}

function mapBudget(budget: BackendOfflineBudget): OfflineBudget {
  return {
    budgetId: budget.budget_id,
    deviceId: budget.device_id,
    assetId: budget.asset_id,
    totalAmount: budget.total_amount,
    remainingAmount: budget.remaining_amount,
    remainingTransfers: budget.remaining_transfers,
    expiresAt: budget.expires_at,
  };
}

function mapVoucher(voucher: BackendOfflineVoucher): OfflineVoucher {
  return {
    voucherId: voucher.voucher_id,
    ownerDeviceId: voucher.owner_device_id,
    amount: voucher.amount,
    assetId: voucher.asset_id,
    epoch: voucher.epoch,
    expiresAt: voucher.expires_at,
    issuerSignature: voucher.issuer_signature,
    status: voucher.status,
  };
}

function toBackendManifest(manifest: DeviceManifest) {
  return {
    device_id: manifest.deviceId,
    app_version: manifest.appVersion,
    epoch: manifest.epoch,
    state_root: manifest.stateRoot,
    policy_hash: manifest.policyHash,
    integrity_level: manifest.integrityLevel,
    attestation_valid: manifest.attestationValid,
    last_online_at: manifest.lastOnlineAt,
    capabilities: manifest.capabilities,
    key_alias: manifest.keyAlias,
    public_key: manifest.publicKey,
    key_security_level: manifest.keySecurityLevel,
    device_security_level: manifest.deviceSecurityLevel,
    is_hardware_backed: manifest.isHardwareBacked,
    attestation_challenge: manifest.attestationChallenge,
    attestation_certificates: manifest.attestationCertificates ?? [],
    ble_service_id: manifest.bleServiceId,
    transport_capabilities: manifest.transportCapabilities ?? {},
    wallet_public_key: manifest.walletPublicKey,
    solana_address: manifest.solanaAddress,
    active_wallet_id: manifest.activeWalletId,
    wallet_type: manifest.walletType,
    wallet_display_name: manifest.walletDisplayName,
    device_integrity_score: manifest.deviceIntegrityScore,
    device_integrity_state: manifest.deviceIntegrityState,
    integrity_warnings: manifest.integrityWarnings ?? [],
    device_reputation_anchor_hash: manifest.deviceReputationAnchorHash,
    device_reputation_anchor_epoch: manifest.deviceReputationAnchorEpoch,
    reputation_envelope: manifest.reputationEnvelope
      ? {
          trust_ceiling: manifest.reputationEnvelope.trustCeiling,
          risk_floor: manifest.reputationEnvelope.riskFloor,
          cooldown_until: manifest.reputationEnvelope.cooldownUntil,
          lineage_generation: manifest.reputationEnvelope.lineageGeneration,
          reset_count: manifest.reputationEnvelope.resetCount,
          unresolved_exposure: manifest.reputationEnvelope.unresolvedExposure,
          mode: manifest.reputationEnvelope.mode,
          updated_at: manifest.reputationEnvelope.updatedAt,
          reasons: manifest.reputationEnvelope.reasons,
        }
      : undefined,
  };
}

function toBackendCertificateProfile(profile: WalletProfile["certificateProfile"]) {
  if (!profile) {
    return undefined;
  }

  return {
    certificate_id: profile.certificateId,
    alias: profile.alias,
    file_name: profile.fileName,
    fingerprint: profile.fingerprint,
    subject: profile.subject,
    issuer: profile.issuer,
    serial_number: profile.serialNumber,
    valid_from: profile.validFrom,
    valid_to: profile.validTo,
    algorithm: profile.algorithm,
    imported_at: profile.importedAt,
  };
}

function toRegistryEntry(response: BackendWalletRegistrationResponse): WalletRegistryEntry {
  return {
    walletId: response.wallet_id,
    walletType: response.wallet_type,
    displayName: response.display_name,
    documentType: response.document_type ?? null,
    documentId: response.document_id ?? null,
    birthDate: response.birth_date ?? null,
    businessName: response.business_name ?? null,
    responsibleName: response.responsible_name ?? null,
    responsibleDocumentId: response.responsible_document_id ?? null,
    solanaAddress: response.solana_address,
    publicKey: response.wallet_public_key,
    postQuantumPublicKey: response.post_quantum_public_key ?? undefined,
    identityDerivationVersion: response.identity_derivation_version ?? 1,
    identityContextHash: response.identity_context_hash ?? "",
    identityPublicKey: response.identity_public_key ?? "",
    publicKeyAnchored: response.public_key_anchored ?? false,
    publicKeyAnchorTx: response.public_key_anchor_tx ?? null,
    publicKeyAnchoredAt: response.public_key_anchored_at ?? null,
    backupConfirmedAt: response.backup_confirmed_at ?? null,
    isActiveOnDevice: response.is_active_on_device,
    createdAt: response.created_at,
  };
}

function mapPendingTransaction(transaction: BackendPendingChainTransaction): PendingChainTransaction {
  return {
    walletId: transaction.wallet_id ?? undefined,
    walletType: transaction.wallet_type ?? undefined,
    intent: {
      intentId: transaction.intent.intent_id,
      walletId: transaction.intent.wallet_id ?? undefined,
      walletType: transaction.intent.wallet_type ?? undefined,
      assetId: transaction.intent.asset_id,
      fromAddress: transaction.intent.from_address,
      toAddress: transaction.intent.to_address,
      amount: transaction.intent.amount,
      decimals: transaction.intent.decimals,
      createdAt: transaction.intent.created_at,
      memo: transaction.intent.memo ?? undefined,
      reference: transaction.intent.reference ?? undefined,
      recentBlockhash: transaction.intent.recent_blockhash ?? undefined,
      tokenMint: transaction.intent.token_mint ?? undefined,
      requiresOnlineAssembly: transaction.intent.requires_online_assembly,
    },
    envelope: {
      intentId: transaction.envelope.intent_id,
      publicKey: transaction.envelope.public_key,
      signedMessage: transaction.envelope.signed_message,
      signature: transaction.envelope.signature,
      signedAt: transaction.envelope.signed_at,
      serializedTransaction: transaction.envelope.serialized_transaction ?? undefined,
    },
    status: transaction.status,
    txSignature: transaction.tx_signature ?? undefined,
    metadataAnchorTx: transaction.metadata_anchor_tx ?? undefined,
    metadataPayloadHash: transaction.metadata_payload_hash ?? undefined,
    lastError: transaction.last_error ?? undefined,
    submittedAt: transaction.submitted_at ?? undefined,
    confirmedAt: transaction.confirmed_at ?? undefined,
  };
}

export async function fetchCurrentPolicyFromBackend(): Promise<AllowlistPolicy | null> {
  const url = buildBackendUrl("/policies/current");
  if (!url) {
    return null;
  }

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(await readErrorResponse(response, "AirPay policy fetch"));
  }

  const payload = await readJsonResponse<{ policy: BackendPolicy }>(response, "AirPay policy fetch");
  return mapPolicy(payload.policy);
}

export async function registerDeviceWithBackend(manifest: DeviceManifest): Promise<DeviceBackendRegistration | null> {
  const url = buildBackendUrl("/devices/register");
  if (!url) {
    return null;
  }

  const payload = await postMaybeSecureJson<{
    policy: BackendPolicy;
    risk: BackendRisk;
    quarantined: boolean;
  }>({
    url,
    context: "devices.register",
    payload: {
      manifest: toBackendManifest(manifest),
      public_key: manifest.publicKey ?? manifest.deviceId,
    },
  });

  return {
    policy: mapPolicy(payload.policy),
    risk: mapRisk(payload.risk),
    quarantined: payload.quarantined,
  };
}

export async function registerWalletWithBackend(input: {
  manifest: DeviceManifest;
  profile: WalletProfile;
}): Promise<WalletRegistryEntry | null> {
  const url = buildBackendUrl("/wallet/register");
  if (!url) {
    return null;
  }

  const requestPayload = {
    device_id: input.manifest.deviceId,
    wallet_id: input.profile.walletId,
    wallet_type: input.profile.walletType,
    display_name: input.profile.displayName,
    document_type: input.profile.documentType ?? undefined,
    document_id: input.profile.documentId ?? undefined,
    birth_date: input.profile.birthDate ?? undefined,
    business_name: input.profile.businessName ?? undefined,
    responsible_name: input.profile.responsibleName ?? undefined,
    responsible_document_id: input.profile.responsibleDocumentId ?? undefined,
    wallet_public_key: input.profile.publicKey,
    post_quantum_public_key: input.profile.postQuantumPublicKey,
    identity_derivation_version: input.profile.identityDerivationVersion,
    identity_context_hash: input.profile.identityContextHash,
    identity_public_key: input.profile.identityPublicKey,
    solana_address: input.profile.solanaAddress,
    certificate_profile: toBackendCertificateProfile(input.profile.certificateProfile),
    manifest: toBackendManifest(input.manifest),
  };
  const response = await postMaybeSecureJson<BackendWalletRegistrationResponse>({
    url,
    context: "wallet.register",
    payload: requestPayload,
    headers: await buildClientSignatureHeaders({
      method: "POST",
      url,
      context: "wallet.register",
      payload: requestPayload,
      deviceId: input.manifest.deviceId,
      walletId: input.profile.walletId,
    }),
  });

  return toRegistryEntry(response);
}

export async function createGatewayWalletSessionWithBackend(input: {
  profile: WalletProfile;
  audience?: string;
}): Promise<GatewayWalletSessionSync | null> {
  const challengeUrl = buildBackendUrl("/v1/auth/wallet/challenge");
  const sessionUrl = buildBackendUrl("/v1/auth/wallet/session");
  if (!challengeUrl || !sessionUrl) {
    return null;
  }

  const walletPublicKey = input.profile.publicKey;
  const walletAddress = input.profile.solanaAddress || input.profile.publicKey;
  const walletId = input.profile.walletId;
  const challengeResponse = await fetch(challengeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      walletPublicKey,
      walletAddress,
      walletId,
      audience: input.audience ?? "airpay-mobile",
    }),
  });
  if (!challengeResponse.ok) {
    throw new Error(await readErrorResponse(challengeResponse, "AirPay Gateway wallet challenge"));
  }

  const challenge = await readJsonResponse<BackendGatewayWalletAuthChallengeResponse>(
    challengeResponse,
    "AirPay Gateway wallet challenge",
  );
  const signed = await signWalletMessage(challenge.message, walletId);
  if (signed.publicKey !== walletPublicKey) {
    throw new Error("AirPay Gateway wallet auth signed with a different wallet.");
  }

  const sessionResponse = await fetch(sessionUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: challenge.message,
      signature: signed.signature,
      walletPublicKey,
      walletAddress,
      walletId,
    }),
  });
  if (!sessionResponse.ok) {
    throw new Error(await readErrorResponse(sessionResponse, "AirPay Gateway wallet session"));
  }

  const session = await readJsonResponse<BackendGatewayWalletSessionResponse>(
    sessionResponse,
    "AirPay Gateway wallet session",
  );
  const accessToken = session.accessToken ?? session.access_token;
  const expiresAt = session.expiresAt ?? session.expires_at;
  const responseWalletPublicKey = session.walletPublicKey ?? session.wallet_public_key;
  if (!accessToken || !expiresAt || !responseWalletPublicKey) {
    throw new Error("AirPay Gateway wallet session response is incomplete.");
  }

  return {
    accessToken,
    tokenType: session.tokenType ?? session.token_type ?? "airpay-wallet-signature",
    expiresAt,
    walletPublicKey: responseWalletPublicKey,
    walletAddress: session.walletAddress ?? session.wallet_address ?? walletAddress,
    walletId: session.walletId ?? session.wallet_id ?? walletId,
  };
}

export async function provisionOfflineBudgetWithBackend(input: {
  deviceId: string;
  walletId?: string;
  requestedAmount: number;
  requestedTransfers: number;
}): Promise<BackendBudgetProvisioning | null> {
  const url = buildBackendUrl("/offline-budget/provision");
  if (!url) {
    return null;
  }

  const requestPayload = {
    device_id: input.deviceId,
    wallet_id: input.walletId,
    requested_amount: input.requestedAmount,
    requested_transfers: input.requestedTransfers,
  };
  const payload = await postMaybeSecureJson<{
    budget: BackendOfflineBudget;
    vouchers: BackendOfflineVoucher[];
    policy: BackendPolicy;
  }>({
    url,
    context: "offline_budget.provision",
    payload: requestPayload,
    headers: input.walletId
      ? await buildClientSignatureHeaders({
          method: "POST",
          url,
          context: "offline_budget.provision",
          payload: requestPayload,
          deviceId: input.deviceId,
          walletId: input.walletId,
        })
      : undefined,
  });

  return {
    budget: mapBudget(payload.budget),
    vouchers: payload.vouchers.map(mapVoucher),
    policy: mapPolicy(payload.policy),
  };
}

export async function fetchPendingChainTransactionsFromBackend(input: {
  deviceId: string;
  walletId?: string;
}): Promise<PendingChainTransaction[]> {
  const url = buildBackendUrl("/wallet/tx/pending/query");
  if (!url) {
    return [];
  }

  const requestPayload = {
    device_id: input.deviceId,
    wallet_id: input.walletId,
  };
  const payload = await postMaybeSecureJson<{ transactions: BackendPendingChainTransaction[] }>({
    url,
    context: "wallet.tx.pending.query",
    payload: requestPayload,
    headers: input.walletId
      ? await buildClientSignatureHeaders({
          method: "POST",
          url,
          context: "wallet.tx.pending.query",
          payload: requestPayload,
          deviceId: input.deviceId,
          walletId: input.walletId,
        })
      : undefined,
  });

  return payload.transactions.map(mapPendingTransaction);
}
