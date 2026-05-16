import {
  ExtensionType,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SendTransactionError,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import bs58 from "bs58";

import {
  buildOffAirClaimSigningPayload,
  DEFAULT_FAST_OFFLINE_HIGH_TRUST_LIMIT_LAMPORTS,
  DEFAULT_FAST_OFFLINE_NEW_USER_LIMIT_LAMPORTS,
  DEFAULT_FAST_OFFLINE_TRUSTED_LIMIT_LAMPORTS,
  DEFAULT_VERIFIED_OFFLINE_MIN_LAMPORTS,
  deriveStableWalletId,
  OFFLINE_SETTLEMENT_MODE_FAST,
  OFFLINE_SETTLEMENT_MODE_VERIFIED,
  RECEIVER_PAYS_OFFLINE_SETTLEMENT_FEES,
  sha256Hex,
} from "@protocol-offair/shared";
import type {
  OfflineTransfer,
  PromiseChainState,
  PromiseStatus,
  PromiseTokenState,
  ProtocolLimits,
  ReserveBalance,
  WalletProfile,
  WalletPublicProfile,
} from "@protocol-offair/shared";

import { signAndSerializeTransaction } from "./custody";
import { recordDiagnosticError } from "./diagnostics";
import { getWalletRuntimeConfig } from "./chain";
import { translate } from "../i18n";

const DEFAULT_PROGRAM_ID = "Gv93ixNuQdSudaWXbk9mD1U6QbchZrJBuPokhNfjgDq2";
const WALLET_SEED_PREFIX = "wallet-v2";
const RESERVE_SEED_PREFIX = "reserve-v2";
const PROMISE_SEED_PREFIX = "promise-v2";
const PROMISE_RECEIPT_SEED_PREFIX = "promise-receipt-v1";
const IX_REGISTER_WALLET_PROFILE = 5;
const IX_ROTATE_DEVICE_KEY = 6;
const IX_FUND_SENDER_RESERVE = 7;
const IX_WITHDRAW_AVAILABLE_RESERVE = 8;
const IX_CREATE_PROMISE_CLAIM = 9;
const IX_MATERIALIZE_PROMISE_RECEIPT = 10;
const IX_SETTLE_PROMISE = 11;
const IX_CLAIM_AND_SETTLE_FAST = 12;
const CONFIG_DISC = 1;
const WALLET_DISC = 3;
const RESERVE_DISC = 4;
const PROMISE_DISC = 5;
const RECEIPT_DISC = 6;
const PROMISE_RECLAIMED_DISC = 7;
const MAX_WALLET_ID_BYTES = 32;
const MAX_PQ_PUBLIC_KEY_BYTES = 80;
const MAX_DEVICE_PUBLIC_KEY_BYTES = 160;
const HASH_BYTES = 32;
const textEncoder = new TextEncoder();

interface ProtocolConfigAccount {
  authority: string;
  offairMint: string;
  maxOffAirPerWallet: number;
  fastOfflineNewUserLimitLamports: bigint;
  fastOfflineTrustedLimitLamports: bigint;
  fastOfflineHighTrustLimitLamports: bigint;
  verifiedOfflineMinLamports: bigint;
  paused: boolean;
  updatedAt: string;
}

interface WalletRegistryAccount {
  walletId: string;
  walletAddress: string;
  walletPublicKey: string;
  pqPublicKey: string;
  activeDevicePublicKey: string;
  offairCapacityIssued: bigint;
  offlineRiskTier: number;
  createdAt: string;
  updatedAt: string;
}

interface SenderReserveVaultAccount {
  committedLamports: bigint;
  createdAt: string;
  updatedAt: string;
}

interface PromiseRecordAccount {
  promiseId: string;
  senderWallet: string;
  receiverWallet: string;
  amountLamports: bigint;
  payloadHash: string;
  signatureDigest: string;
  offlineSettlementTier?: OfflineTransfer["offlineSettlementTier"];
  receiptMaterializationRequired?: boolean;
  status: PromiseStatus;
  createdAt: string;
  lastAttemptAt?: string;
  settledAt?: string;
}

interface PromiseReceiptRecordAccount {
  promiseId: string;
  receiverWallet: string;
  receiptMint: string;
  receiptTokenAccount: string;
  mintedAt: string;
}

interface ProgramAccounts {
  programId: PublicKey;
  protocolConfig: PublicKey;
  blacklistRegistry: PublicKey;
  walletRegistry: PublicKey;
  reserveVault: PublicKey;
  promiseRecord: PublicKey;
  promiseReceiptRecord: PublicKey;
}

function getConnection() {
  const runtime = getWalletRuntimeConfig();
  return new Connection(runtime.solanaRpcUrl, "confirmed");
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRateLimitedError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("429") || message.includes("too many requests") || message.includes("rate limit");
}

async function withRpcRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      lastError = normalized;
      if (attempt === 4 || !isRateLimitedError(normalized)) {
        throw normalized;
      }
      void label;
      await sleep(350 * 2 ** attempt);
    }
  }

  throw lastError ?? new Error(`${label} failed without a concrete error.`);
}

function getProgramId() {
  const runtime = getWalletRuntimeConfig();
  return new PublicKey(runtime.airpayProgramId ?? DEFAULT_PROGRAM_ID);
}

function getOffairMint() {
  const runtime = getWalletRuntimeConfig();
  if (!runtime.offairMintAddress) {
    throw new Error(translate("service.offair.error.protocolUnavailable"));
  }
  return new PublicKey(runtime.offairMintAddress);
}

function instructionOpcode(opcode: number) {
  return Buffer.from([opcode & 0xff]);
}

function encodeString(value: string) {
  const raw = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(raw.length, 0);
  return Buffer.concat([length, raw]);
}

function encodeU64(value: bigint | number) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

function encodeU8(value: number) {
  return Buffer.from([value & 0xff]);
}

function encodeBool(value: boolean) {
  return Buffer.from([value ? 1 : 0]);
}

function encodeHash32(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(translate("service.offair.error.signatureMissing"));
  }
  return Buffer.from(normalized, "hex");
}

function bytesToHex(value: Buffer) {
  return value.toString("hex");
}

function encodePubkey(value: string | PublicKey) {
  return new PublicKey(value).toBuffer();
}

function readI64(buffer: Buffer, offset: number) {
  return Number(buffer.readBigInt64LE(offset));
}

function readU64(buffer: Buffer, offset: number) {
  return buffer.readBigUInt64LE(offset);
}

function readFixedString(buffer: Buffer, offset: number, maxLength: number) {
  const length = buffer[offset] ?? 0;
  const start = offset + 1;
  const end = start + Math.min(length, maxLength);
  return {
    value: buffer.subarray(start, end).toString("utf8"),
    offset: start + maxLength,
  };
}

function isoFromUnix(value: number) {
  if (!value) {
    return undefined;
  }
  return new Date(value * 1000).toISOString();
}

function lamportsToSol(lamports: bigint) {
  const whole = lamports / 1_000_000_000n;
  const fraction = lamports % 1_000_000_000n;
  if (fraction === 0n) {
    return whole.toString();
  }
  return `${whole}.${fraction.toString().padStart(9, "0").replace(/0+$/, "")}`;
}

export function parseUiAmountToLamports(amount: string) {
  const normalized = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(translate("service.wallet.error.invalidTransferAmount"));
  }
  const [whole, fraction = ""] = normalized.split(".");
  const padded = `${fraction}${"0".repeat(9)}`.slice(0, 9);
  return BigInt(`${whole}${padded}`);
}

function buildProgramAccounts(input: {
  walletId: string;
  promiseId?: string;
}): ProgramAccounts {
  const programId = getProgramId();
  const [protocolConfig] = PublicKey.findProgramAddressSync([Buffer.from("protocol-config")], programId);
  const [blacklistRegistry] = PublicKey.findProgramAddressSync([Buffer.from("blacklist")], programId);
  const [walletRegistry] = PublicKey.findProgramAddressSync(
    [Buffer.from(WALLET_SEED_PREFIX), Buffer.from(input.walletId, "utf8")],
    programId,
  );
  const [reserveVault] = PublicKey.findProgramAddressSync(
    [Buffer.from(RESERVE_SEED_PREFIX), Buffer.from(input.walletId, "utf8")],
    programId,
  );
  const [promiseRecord] = input.promiseId
    ? PublicKey.findProgramAddressSync(
        [Buffer.from(PROMISE_SEED_PREFIX), Buffer.from(input.promiseId, "utf8")],
        programId,
      )
    : [PublicKey.default];
  const [promiseReceiptRecord] = input.promiseId
    ? PublicKey.findProgramAddressSync(
        [Buffer.from(PROMISE_RECEIPT_SEED_PREFIX), Buffer.from(input.promiseId, "utf8")],
        programId,
      )
    : [PublicKey.default];

  return {
    programId,
    protocolConfig,
    blacklistRegistry,
    walletRegistry,
    reserveVault,
    promiseRecord,
    promiseReceiptRecord,
  };
}

function getSenderCapacityAccountAddress(walletRegistry: PublicKey, mint: PublicKey) {
  return getAssociatedTokenAddressSync(
    mint,
    walletRegistry,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

function assertReceiverPaysSettlementFees(transfer: OfflineTransfer) {
  const feePolicy = transfer.settlementFeePolicy ?? RECEIVER_PAYS_OFFLINE_SETTLEMENT_FEES;
  if (
    feePolicy.payer !== "receiver" ||
    feePolicy.networkFeeAssetId !== "SOL" ||
    feePolicy.airPayPaysNetworkFees
  ) {
    throw new Error(translate("service.offair.error.receiverFeePolicyRequired"));
  }
}

function compactOnChainPqPublicKey(value: string) {
  const normalized = value.trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `sha256:${sha256Hex(normalized)}`;
}

async function getLatestBlockhash() {
  const connection = getConnection();
  const latest = await withRpcRetry("offair.getLatestBlockhash", () => connection.getLatestBlockhash("confirmed"));
  return latest.blockhash;
}

async function submitInstructions(input: {
  walletId?: string;
  instructions: TransactionInstruction[];
  additionalSigners?: Keypair[];
  operation?: string;
  instructionLabels?: string[];
}) {
  const connection = getConnection();
  const recentBlockhash = await getLatestBlockhash();
  const signed = await signAndSerializeTransaction({
    walletId: input.walletId,
    instructions: input.instructions,
    recentBlockhash,
    additionalSigners: input.additionalSigners,
  });
  const raw = Buffer.from(signed.serializedTransaction, "base64");
  const signature = signed.signature;
  try {
    await withRpcRetry("offair.sendRawTransaction", () =>
      connection.sendRawTransaction(raw, {
        preflightCommitment: "confirmed",
        skipPreflight: false,
      }),
    );
    await withRpcRetry("offair.confirmTransaction", () => connection.confirmTransaction(signature, "confirmed"));
  } catch (error) {
    let logs: string[] | undefined;
    if (error instanceof SendTransactionError) {
      try {
        logs = (await error.getLogs(connection)) ?? undefined;
      } catch {
        logs = error.logs ?? undefined;
      }
    }

    const enrichedMessage = [
      error instanceof Error ? error.message : String(error),
      logs && logs.length > 0 ? `Logs:\n${logs.join("\n")}` : null,
      `Operation: ${input.operation ?? "submit"}`,
      `Instruction count: ${input.instructions.length}`,
      input.instructionLabels?.length ? `Instructions: ${input.instructionLabels.join(", ")}` : null,
      `Serialized transaction bytes: ${raw.length}`,
      `Wallet: ${input.walletId ?? "ephemeral"}`,
      `Signature: ${signature}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const enrichedError = new Error(enrichedMessage);
    void recordDiagnosticError(`solana.${input.operation ?? "submit"}`, enrichedError, {
      walletId: input.walletId,
      operation: input.operation ?? "submit",
      instructionCount: input.instructions.length,
      instructionLabels: input.instructionLabels ?? [],
      serializedTransactionBytes: raw.length,
      signature,
      logs,
    });
    throw enrichedError;
  }
  return signature;
}

async function getAccountBuffer(address: PublicKey) {
  const account = await withRpcRetry("offair.getAccountInfo", () => getConnection().getAccountInfo(address, "confirmed"));
  return account?.data ? Buffer.from(account.data) : null;
}

function parseProtocolConfig(buffer: Buffer): ProtocolConfigAccount {
  if (buffer[0] !== CONFIG_DISC) {
    throw new Error(translate("service.offair.error.protocolUnavailable"));
  }
  let offset = 1;
  const authority = new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const offairMint = new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const maxOffAirPerWallet = Number(readU64(buffer, offset));
  offset += 8;
  const fastOfflineNewUserLimitLamports = readU64(buffer, offset);
  offset += 8;
  const fastOfflineTrustedLimitLamports = readU64(buffer, offset);
  offset += 8;
  const fastOfflineHighTrustLimitLamports = readU64(buffer, offset);
  offset += 8;
  const verifiedOfflineMinLamports = readU64(buffer, offset);
  offset += 8;
  const paused = buffer[offset] === 1;
  offset += 1;
  const updatedAt = isoFromUnix(readI64(buffer, offset)) ?? new Date(0).toISOString();

  return {
    authority,
    offairMint,
    maxOffAirPerWallet,
    fastOfflineNewUserLimitLamports,
    fastOfflineTrustedLimitLamports,
    fastOfflineHighTrustLimitLamports,
    verifiedOfflineMinLamports,
    paused,
    updatedAt,
  };
}

function parseWalletRegistry(buffer: Buffer): WalletRegistryAccount {
  if (buffer[0] !== WALLET_DISC) {
    throw new Error(translate("service.offair.error.protocolUnavailable"));
  }
  let offset = 1;
  const walletIdValue = readFixedString(buffer, offset, MAX_WALLET_ID_BYTES);
  offset = walletIdValue.offset;
  const walletAddress = new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const walletPublicKey = new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const pqPublicKeyValue = readFixedString(buffer, offset, MAX_PQ_PUBLIC_KEY_BYTES);
  offset = pqPublicKeyValue.offset;
  const deviceValue = readFixedString(buffer, offset, MAX_DEVICE_PUBLIC_KEY_BYTES);
  offset = deviceValue.offset;
  const offairCapacityIssued = readU64(buffer, offset);
  offset += 8;
  const offlineRiskTier = buffer[offset] ?? 2;
  offset += 1;
  const createdAt = isoFromUnix(readI64(buffer, offset)) ?? new Date(0).toISOString();
  offset += 8;
  const updatedAt = isoFromUnix(readI64(buffer, offset)) ?? createdAt;

  return {
    walletId: walletIdValue.value,
    walletAddress,
    walletPublicKey,
    pqPublicKey: pqPublicKeyValue.value,
    activeDevicePublicKey: deviceValue.value,
    offairCapacityIssued,
    offlineRiskTier,
    createdAt,
    updatedAt,
  };
}

function parseReserveVault(buffer: Buffer): SenderReserveVaultAccount {
  if (buffer[0] !== RESERVE_DISC) {
    throw new Error(translate("service.offair.error.protocolUnavailable"));
  }
  let offset = 1;
  const committedLamports = readU64(buffer, offset);
  offset += 8;
  const createdAt = isoFromUnix(readI64(buffer, offset)) ?? new Date(0).toISOString();
  offset += 8;
  const updatedAt = isoFromUnix(readI64(buffer, offset)) ?? createdAt;

  return {
    committedLamports,
    createdAt,
    updatedAt,
  };
}

function mapPromiseStatus(status: number): PromiseStatus {
  switch (status) {
    case 2:
      return "settled";
    case 1:
      return "claimed";
    default:
      return "pending";
  }
}

function parsePromiseRecord(buffer: Buffer): PromiseRecordAccount {
  if (buffer[0] === PROMISE_RECLAIMED_DISC) {
    let offset = 1;
    const promiseIdValue = readFixedString(buffer, offset, MAX_WALLET_ID_BYTES);
    offset = promiseIdValue.offset;
    const senderWallet = new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    const receiverWallet = new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    const amountLamports = readU64(buffer, offset);
    offset += 8;
    const settlementMode = buffer[offset] ?? OFFLINE_SETTLEMENT_MODE_FAST;
    offset += 1;
    const receiptMaterializationRequired = buffer[offset] === 1;
    offset += 1;
    const settledAt = isoFromUnix(readI64(buffer, offset));
    const fallbackDate = settledAt ?? new Date(0).toISOString();

    return {
      promiseId: promiseIdValue.value,
      senderWallet,
      receiverWallet,
      amountLamports,
      payloadHash: "",
      signatureDigest: "",
      offlineSettlementTier: settlementMode === OFFLINE_SETTLEMENT_MODE_VERIFIED ? "verified_offline" : "fast_offline",
      receiptMaterializationRequired,
      status: "settled",
      createdAt: fallbackDate,
      lastAttemptAt: settledAt,
      settledAt,
    };
  }

  if (buffer[0] !== PROMISE_DISC) {
    throw new Error(translate("service.offair.error.protocolUnavailable"));
  }
  let offset = 1;
  const promiseIdValue = readFixedString(buffer, offset, MAX_WALLET_ID_BYTES);
  offset = promiseIdValue.offset;
  const senderWallet = new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const receiverWallet = new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const amountLamports = readU64(buffer, offset);
  offset += 8;
  const payloadHash = bytesToHex(buffer.subarray(offset, offset + HASH_BYTES));
  offset += HASH_BYTES;
  const signatureDigest = bytesToHex(buffer.subarray(offset, offset + HASH_BYTES));
  offset += HASH_BYTES;
  const settlementMode = buffer[offset] ?? OFFLINE_SETTLEMENT_MODE_FAST;
  offset += 1;
  const receiptMaterializationRequired = buffer[offset] === 1;
  offset += 1;
  const status = mapPromiseStatus(buffer[offset]);
  offset += 1;
  const createdAt = isoFromUnix(readI64(buffer, offset)) ?? new Date(0).toISOString();
  offset += 8;
  const lastAttemptAt = isoFromUnix(readI64(buffer, offset));
  offset += 8;
  const settledAt = isoFromUnix(readI64(buffer, offset));

  return {
    promiseId: promiseIdValue.value,
    senderWallet,
    receiverWallet,
    amountLamports,
    payloadHash,
    signatureDigest,
    offlineSettlementTier: settlementMode === OFFLINE_SETTLEMENT_MODE_VERIFIED ? "verified_offline" : "fast_offline",
    receiptMaterializationRequired,
    status,
    createdAt,
    lastAttemptAt,
    settledAt,
  };
}

function parsePromiseReceiptRecord(buffer: Buffer): PromiseReceiptRecordAccount {
  if (buffer[0] !== RECEIPT_DISC) {
    throw new Error(translate("service.offair.error.protocolUnavailable"));
  }
  let offset = 1;
  const promiseIdValue = readFixedString(buffer, offset, MAX_WALLET_ID_BYTES);
  offset = promiseIdValue.offset;
  const receiverWallet = new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const receiptMint = new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const receiptTokenAccount = new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const mintedAt = isoFromUnix(readI64(buffer, offset)) ?? new Date(0).toISOString();

  return {
    promiseId: promiseIdValue.value,
    receiverWallet,
    receiptMint,
    receiptTokenAccount,
    mintedAt,
  };
}

function getWalletSignatureFromTransfer(transfer: OfflineTransfer) {
  const walletSignature = transfer.signatureBundle?.signatures.find(
    (signature) => signature.role === "wallet" && signature.algorithm === "ed25519" && signature.signature,
  );
  if (!walletSignature?.publicKey || !walletSignature.signature) {
    throw new Error(translate("service.offair.error.signatureMissing"));
  }
  return walletSignature;
}

function buildClaimEnvelope(transfer: OfflineTransfer) {
  if (!transfer.promiseId || !transfer.senderAddress || !transfer.receiverAddress) {
    throw new Error(translate("service.offair.error.promiseIncomplete"));
  }

  const amountLamports = parseUiAmountToLamports(String(transfer.amount));
  const offairAmount = amountLamports;
  const payloadHash = getSignedTransferPayloadHash(transfer);
  const settlementMode =
    transfer.offlineSettlementTier === "verified_offline"
      ? OFFLINE_SETTLEMENT_MODE_VERIFIED
      : OFFLINE_SETTLEMENT_MODE_FAST;
  const receiptMaterializationRequired = transfer.receiptMaterializationRequired ?? settlementMode === OFFLINE_SETTLEMENT_MODE_VERIFIED;
  const signing = buildOffAirClaimSigningPayload({
    promiseId: transfer.promiseId,
    senderAddress: transfer.senderAddress,
    receiverAddress: transfer.receiverAddress,
    amountLamports: amountLamports.toString(),
    offairAmount: offairAmount.toString(),
    payloadHash,
    settlementMode,
    receiptMaterializationRequired,
    version: 3,
  });

  return {
    amountLamports,
    offairAmount,
    payloadHash,
    settlementMode,
    receiptMaterializationRequired,
    signing,
  };
}

function shouldFallbackToLegacyFastClaim(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Operation: claim_and_settle_fast");
}

function getSignedTransferPayloadHash(transfer: OfflineTransfer) {
  if (transfer.signatureBundle?.payloadHash) {
    return transfer.signatureBundle.payloadHash;
  }

  const {
    txHash: _txHash,
    signatureBundle: _signatureBundle,
    receipt: _receipt,
    signingAlgorithms: _signingAlgorithms,
    claimStatus: _claimStatus,
    directSettlementSignature: _directSettlementSignature,
    instantClaimSignature: _instantClaimSignature,
    instantSettleSignature: _instantSettleSignature,
    ...signedTransfer
  } = transfer;

  return sha256Hex({
    ...signedTransfer,
    settlementStatus: "pending",
    signingAlgorithms: [],
  });
}

export async function fetchProtocolLimits(): Promise<ProtocolLimits> {
  const accounts = buildProgramAccounts({ walletId: "placeholder" });
  const buffer = await getAccountBuffer(accounts.protocolConfig);
  if (!buffer) {
    throw new Error(translate("service.offair.error.protocolUnavailable"));
  }
  const config = parseProtocolConfig(buffer);
  return {
    maxOffAirPerWallet: config.maxOffAirPerWallet,
    fastOfflineNewUserLimitLamports: config.fastOfflineNewUserLimitLamports.toString(),
    fastOfflineTrustedLimitLamports: config.fastOfflineTrustedLimitLamports.toString(),
    fastOfflineHighTrustLimitLamports: config.fastOfflineHighTrustLimitLamports.toString(),
    verifiedOfflineMinLamports: config.verifiedOfflineMinLamports.toString(),
    offairMintAddress: config.offairMint,
    paused: config.paused,
  };
}

export async function fetchWalletPublicProfile(walletId: string): Promise<WalletPublicProfile | null> {
  const accounts = buildProgramAccounts({ walletId });
  const buffer = await getAccountBuffer(accounts.walletRegistry);
  if (!buffer) {
    return null;
  }
  const profile = parseWalletRegistry(buffer);
  return {
    walletId: profile.walletId,
    walletPublicKey: profile.walletPublicKey,
    pqPublicKey: profile.pqPublicKey,
    activeDevicePublicKey: profile.activeDevicePublicKey,
    registeredAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

async function waitForWalletPublicProfile(walletId: string): Promise<WalletPublicProfile | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const profile = await fetchWalletPublicProfile(walletId);
    if (profile) {
      return profile;
    }
    await sleep(250 * (attempt + 1));
  }
  return null;
}

export async function registerWalletOnChain(input: {
  profile: WalletProfile;
  devicePublicKey?: string;
}): Promise<string> {
  const accounts = buildProgramAccounts({ walletId: input.profile.walletId });
  const payload = Buffer.concat([
    instructionOpcode(IX_REGISTER_WALLET_PROFILE),
    encodeString(input.profile.walletId),
    encodePubkey(input.profile.solanaAddress),
    encodePubkey(input.profile.publicKey),
    encodeString(compactOnChainPqPublicKey(input.profile.postQuantumPublicKey)),
    encodeString(input.devicePublicKey ?? input.profile.devicePublicKey ?? input.profile.publicKey),
  ]);
  const instruction = new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: new PublicKey(input.profile.publicKey), isSigner: true, isWritable: true },
      { pubkey: accounts.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: accounts.blacklistRegistry, isSigner: false, isWritable: false },
      { pubkey: accounts.walletRegistry, isSigner: false, isWritable: true },
      { pubkey: accounts.reserveVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: payload,
  });
  return submitInstructions({
    walletId: input.profile.walletId,
    instructions: [instruction],
    operation: "register_wallet_profile",
    instructionLabels: ["register_wallet_profile"],
  });
}

export async function rotateDeviceKeyOnChain(input: {
  profile: WalletProfile;
  devicePublicKey: string;
}): Promise<string> {
  const accounts = buildProgramAccounts({ walletId: input.profile.walletId });
  const payload = Buffer.concat([
    instructionOpcode(IX_ROTATE_DEVICE_KEY),
    encodeString(input.profile.walletId),
    encodeString(input.devicePublicKey),
  ]);
  const instruction = new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: new PublicKey(input.profile.publicKey), isSigner: true, isWritable: true },
      { pubkey: accounts.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: accounts.walletRegistry, isSigner: false, isWritable: true },
    ],
    data: payload,
  });
  return submitInstructions({
    walletId: input.profile.walletId,
    instructions: [instruction],
    operation: "rotate_device_key",
    instructionLabels: ["rotate_device_key"],
  });
}

export async function fetchReserveBalance(profile: WalletProfile): Promise<ReserveBalance> {
  const accounts = buildProgramAccounts({ walletId: profile.walletId });
  const connection = getConnection();
  const [accountInfo, walletRegistryInfo] = await Promise.all([
    withRpcRetry("offair.getReserveAccount", () =>
      connection.getAccountInfo(accounts.reserveVault, "confirmed"),
    ),
    withRpcRetry("offair.getWalletRegistry", () =>
      connection.getAccountInfo(accounts.walletRegistry, "confirmed"),
    ),
  ]);
  const lamports = BigInt(accountInfo?.lamports ?? 0);
  const rentFloor = BigInt(
    accountInfo?.data
      ? await withRpcRetry("offair.getReserveRentFloor", () =>
          connection.getMinimumBalanceForRentExemption(accountInfo.data.length, "confirmed"),
        )
      : 0,
  );
  const reserve = accountInfo?.data
    ? parseReserveVault(Buffer.from(accountInfo.data))
    : {
        committedLamports: 0n,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
  const walletRegistry = walletRegistryInfo?.data ? parseWalletRegistry(Buffer.from(walletRegistryInfo.data)) : null;
  const withdrawableLamports =
    lamports > rentFloor + reserve.committedLamports ? lamports - rentFloor - reserve.committedLamports : 0n;
  const capacityIssuedLamports = walletRegistry?.offairCapacityIssued ?? 0n;
  const capacityAvailableLamports =
    capacityIssuedLamports > reserve.committedLamports ? capacityIssuedLamports - reserve.committedLamports : 0n;

  return {
    walletId: profile.walletId,
    walletAddress: profile.solanaAddress,
    vaultAddress: accounts.reserveVault.toBase58(),
    lamports: lamports.toString(),
    sol: lamportsToSol(lamports),
    committedLamports: reserve.committedLamports.toString(),
    committedSol: lamportsToSol(reserve.committedLamports),
    withdrawableLamports: withdrawableLamports.toString(),
    withdrawableSol: lamportsToSol(withdrawableLamports),
    capacityIssuedLamports: capacityIssuedLamports.toString(),
    capacityIssuedSol: lamportsToSol(capacityIssuedLamports),
    capacityAvailableLamports: capacityAvailableLamports.toString(),
    capacityAvailableSol: lamportsToSol(capacityAvailableLamports),
    updatedAt: reserve.updatedAt,
  };
}

export async function fundReserve(input: {
  profile: WalletProfile;
  amount: string;
}): Promise<string> {
  const accounts = buildProgramAccounts({ walletId: input.profile.walletId });
  const amountLamports = parseUiAmountToLamports(input.amount);
  const offairMint = getOffairMint();
  const senderCapacityAccount = getSenderCapacityAccountAddress(accounts.walletRegistry, offairMint);
  const payload = Buffer.concat([
    instructionOpcode(IX_FUND_SENDER_RESERVE),
    encodeString(input.profile.walletId),
    encodePubkey(input.profile.solanaAddress),
    encodeU64(amountLamports),
  ]);
  const instruction = new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: new PublicKey(input.profile.publicKey), isSigner: true, isWritable: true },
      { pubkey: accounts.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: accounts.walletRegistry, isSigner: false, isWritable: true },
      { pubkey: accounts.reserveVault, isSigner: false, isWritable: true },
      { pubkey: offairMint, isSigner: false, isWritable: true },
      { pubkey: senderCapacityAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: payload,
  });
  return submitInstructions({
    walletId: input.profile.walletId,
    instructions: [instruction],
    operation: "fund_sender_reserve",
    instructionLabels: ["fund_sender_reserve"],
  });
}

export async function withdrawReserve(input: {
  profile: WalletProfile;
  amount: string;
}): Promise<string> {
  const accounts = buildProgramAccounts({ walletId: input.profile.walletId });
  const amountLamports = parseUiAmountToLamports(input.amount);
  const offairMint = getOffairMint();
  const senderCapacityAccount = getSenderCapacityAccountAddress(accounts.walletRegistry, offairMint);
  const payload = Buffer.concat([
    instructionOpcode(IX_WITHDRAW_AVAILABLE_RESERVE),
    encodeString(input.profile.walletId),
    encodeU64(amountLamports),
  ]);
  const instruction = new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: new PublicKey(input.profile.publicKey), isSigner: true, isWritable: true },
      { pubkey: accounts.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: accounts.walletRegistry, isSigner: false, isWritable: true },
      { pubkey: accounts.reserveVault, isSigner: false, isWritable: true },
      { pubkey: offairMint, isSigner: false, isWritable: true },
      { pubkey: senderCapacityAccount, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(input.profile.solanaAddress), isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: payload,
  });
  return submitInstructions({
    walletId: input.profile.walletId,
    instructions: [instruction],
    operation: "withdraw_available_reserve",
    instructionLabels: ["withdraw_available_reserve"],
  });
}

export async function claimPromiseOnChain(input: {
  profile: WalletProfile;
  transfer: OfflineTransfer;
}): Promise<PromiseChainState> {
  const transfer = input.transfer;
  assertReceiverPaysSettlementFees(transfer);
  const signature = getWalletSignatureFromTransfer(transfer);
  const claim = buildClaimEnvelope(transfer);
  const senderWalletId = transfer.walletId ?? deriveStableWalletId(transfer.senderAddress!);
  const receiverWalletId = input.profile.walletId;
  if (claim.settlementMode === OFFLINE_SETTLEMENT_MODE_FAST && !claim.receiptMaterializationRequired) {
    try {
      return await claimAndSettleFastOnChain({
        profile: input.profile,
        transfer,
        signature,
        claim,
        senderWalletId,
        receiverWalletId,
      });
    } catch (error) {
      if (!shouldFallbackToLegacyFastClaim(error)) {
        throw error;
      }
      void recordDiagnosticError("offair.claim_and_settle_fast.fallback", error, {
        promiseId: transfer.promiseId,
        senderWalletId,
        receiverWalletId,
      });
    }
  }
  const senderAccounts = buildProgramAccounts({ walletId: senderWalletId, promiseId: transfer.promiseId });
  const receiverAccounts = buildProgramAccounts({ walletId: receiverWalletId, promiseId: transfer.promiseId });
  const receiver = new PublicKey(input.profile.solanaAddress);
  const offairMint = getOffairMint();
  const senderCapacityAccount = getSenderCapacityAccountAddress(senderAccounts.walletRegistry, offairMint);
  const ensureSenderCapacityAccount = createAssociatedTokenAccountIdempotentInstruction(
    receiver,
    senderCapacityAccount,
    senderAccounts.walletRegistry,
    offairMint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
    publicKey: bs58.decode(signature.publicKey!),
    message: textEncoder.encode(claim.signing.canonicalPayload),
    signature: bs58.decode(signature.signature!),
  });
  const payload = Buffer.concat([
    instructionOpcode(IX_CREATE_PROMISE_CLAIM),
    encodeString(transfer.promiseId!),
    encodePubkey(transfer.senderAddress!),
    encodePubkey(input.profile.solanaAddress),
    encodeU64(claim.amountLamports),
    encodeHash32(claim.payloadHash),
    encodeHash32(claim.signing.digest),
    encodeU8(claim.settlementMode),
    encodeBool(claim.receiptMaterializationRequired),
  ]);
  const programInstruction = new TransactionInstruction({
    programId: senderAccounts.programId,
    keys: [
      { pubkey: receiver, isSigner: true, isWritable: true },
      { pubkey: senderAccounts.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: senderAccounts.blacklistRegistry, isSigner: false, isWritable: false },
      { pubkey: senderAccounts.walletRegistry, isSigner: false, isWritable: true },
      { pubkey: senderAccounts.reserveVault, isSigner: false, isWritable: true },
      { pubkey: receiverAccounts.walletRegistry, isSigner: false, isWritable: true },
      { pubkey: senderAccounts.promiseRecord, isSigner: false, isWritable: true },
      { pubkey: offairMint, isSigner: false, isWritable: false },
      { pubkey: senderCapacityAccount, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: payload,
  });

  const claimTx = await submitInstructions({
    walletId: input.profile.walletId,
    instructions: [ensureSenderCapacityAccount, ed25519Instruction, programInstruction],
    operation: "create_promise_claim",
    instructionLabels: [
      "ensure_sender_offair_account",
      "ed25519_verify_wallet_signature",
      "create_promise_claim",
    ],
  });

  return {
    promiseId: transfer.promiseId!,
    senderAddress: transfer.senderAddress!,
    receiverAddress: input.profile.solanaAddress,
    amountLamports: claim.amountLamports.toString(),
    offairAmount: claim.offairAmount.toString(),
    status: "claimed",
    offlineSettlementTier: transfer.offlineSettlementTier,
    receiptMaterializationRequired: claim.receiptMaterializationRequired,
    createdAt: transfer.createdAt,
    claimTx,
    settlementFeePayer: "receiver",
    feePayerAddress: input.profile.solanaAddress,
  };
}

async function claimAndSettleFastOnChain(input: {
  profile: WalletProfile;
  transfer: OfflineTransfer;
  signature: ReturnType<typeof getWalletSignatureFromTransfer>;
  claim: ReturnType<typeof buildClaimEnvelope>;
  senderWalletId: string;
  receiverWalletId: string;
}): Promise<PromiseChainState> {
  const { transfer, claim, signature } = input;
  if (!transfer.promiseId || !transfer.senderAddress) {
    throw new Error(translate("service.offair.error.promiseIncomplete"));
  }
  const senderAccounts = buildProgramAccounts({ walletId: input.senderWalletId, promiseId: transfer.promiseId });
  const receiverAccounts = buildProgramAccounts({ walletId: input.receiverWalletId, promiseId: transfer.promiseId });
  const receiver = new PublicKey(input.profile.solanaAddress);
  const offairMint = getOffairMint();
  const senderCapacityAccount = getSenderCapacityAccountAddress(senderAccounts.walletRegistry, offairMint);
  const ensureSenderCapacityAccount = createAssociatedTokenAccountIdempotentInstruction(
    receiver,
    senderCapacityAccount,
    senderAccounts.walletRegistry,
    offairMint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
    publicKey: bs58.decode(signature.publicKey!),
    message: textEncoder.encode(claim.signing.canonicalPayload),
    signature: bs58.decode(signature.signature!),
  });
  const payload = Buffer.concat([
    instructionOpcode(IX_CLAIM_AND_SETTLE_FAST),
    encodeString(transfer.promiseId),
    encodePubkey(transfer.senderAddress),
    encodePubkey(input.profile.solanaAddress),
    encodeU64(claim.amountLamports),
    encodeHash32(claim.payloadHash),
    encodeHash32(claim.signing.digest),
  ]);
  const programInstruction = new TransactionInstruction({
    programId: senderAccounts.programId,
    keys: [
      { pubkey: receiver, isSigner: true, isWritable: true },
      { pubkey: senderAccounts.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: senderAccounts.blacklistRegistry, isSigner: false, isWritable: false },
      { pubkey: senderAccounts.walletRegistry, isSigner: false, isWritable: true },
      { pubkey: senderAccounts.reserveVault, isSigner: false, isWritable: true },
      { pubkey: receiverAccounts.walletRegistry, isSigner: false, isWritable: true },
      { pubkey: senderAccounts.promiseRecord, isSigner: false, isWritable: true },
      { pubkey: offairMint, isSigner: false, isWritable: true },
      { pubkey: senderCapacityAccount, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: payload,
  });

  const directTx = await submitInstructions({
    walletId: input.profile.walletId,
    instructions: [ensureSenderCapacityAccount, ed25519Instruction, programInstruction],
    operation: "claim_and_settle_fast",
    instructionLabels: [
      "ensure_sender_offair_account",
      "ed25519_verify_wallet_signature",
      "claim_and_settle_fast",
    ],
  });
  const settledAt = new Date().toISOString();
  return {
    promiseId: transfer.promiseId,
    senderWalletId: input.senderWalletId,
    receiverWalletId: input.receiverWalletId,
    senderAddress: transfer.senderAddress,
    receiverAddress: input.profile.solanaAddress,
    amountLamports: claim.amountLamports.toString(),
    offairAmount: claim.offairAmount.toString(),
    status: "settled",
    offlineSettlementTier: transfer.offlineSettlementTier,
    receiptMaterializationRequired: false,
    createdAt: transfer.createdAt,
    lastAttemptAt: settledAt,
    settledAt,
    claimTx: directTx,
    settleTx: directTx,
    settlementFeePayer: "receiver",
    feePayerAddress: input.profile.solanaAddress,
  };
}

export async function materializePromiseReceiptOnChain(input: {
  profile: WalletProfile;
  transfer: OfflineTransfer;
}): Promise<PromiseTokenState> {
  if (!input.transfer.promiseId || !input.transfer.senderAddress) {
    throw new Error(translate("service.offair.error.promiseIncomplete"));
  }
  if (!input.transfer.receiptMaterializationRequired) {
    throw new Error(translate("service.offair.error.receiptNotRequired"));
  }
  assertReceiverPaysSettlementFees(input.transfer);

  const receiver = new PublicKey(input.profile.solanaAddress);
  const receiverWalletId = input.profile.walletId;
  const senderWalletId = input.transfer.walletId ?? deriveStableWalletId(input.transfer.senderAddress);
  const senderAccounts = buildProgramAccounts({ walletId: senderWalletId, promiseId: input.transfer.promiseId });
  const receiverAccounts = buildProgramAccounts({ walletId: receiverWalletId, promiseId: input.transfer.promiseId });
  const promiseReceiptMint = Keypair.generate();
  const promiseReceiptTokenAccount = getAssociatedTokenAddressSync(
    promiseReceiptMint.publicKey,
    receiver,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const mintSpace = getMintLen([ExtensionType.NonTransferable]);
  const mintRent = await withRpcRetry("offair.getPromiseReceiptMintRent", () =>
    getConnection().getMinimumBalanceForRentExemption(mintSpace),
  );
  const createMintInstruction = SystemProgram.createAccount({
    fromPubkey: receiver,
    newAccountPubkey: promiseReceiptMint.publicKey,
    lamports: mintRent,
    space: mintSpace,
    programId: TOKEN_2022_PROGRAM_ID,
  });
  const payload = Buffer.concat([
    instructionOpcode(IX_MATERIALIZE_PROMISE_RECEIPT),
    encodeString(input.transfer.promiseId),
  ]);
  const materializeInstruction = new TransactionInstruction({
    programId: senderAccounts.programId,
    keys: [
      { pubkey: receiver, isSigner: true, isWritable: true },
      { pubkey: senderAccounts.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: receiverAccounts.walletRegistry, isSigner: false, isWritable: true },
      { pubkey: senderAccounts.promiseRecord, isSigner: false, isWritable: true },
      { pubkey: senderAccounts.promiseReceiptRecord, isSigner: false, isWritable: true },
      { pubkey: promiseReceiptMint.publicKey, isSigner: false, isWritable: true },
      { pubkey: promiseReceiptTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: payload,
  });

  await submitInstructions({
    walletId: input.profile.walletId,
    instructions: [createMintInstruction, materializeInstruction],
    additionalSigners: [promiseReceiptMint],
    operation: "materialize_promise_receipt",
    instructionLabels: ["create_receipt_mint_account", "materialize_promise_receipt"],
  });

  const receipt = await fetchPromiseReceiptState(input.transfer.promiseId);
  if (!receipt) {
    throw new Error(translate("service.offair.error.protocolUnavailable"));
  }
  return {
    ...receipt,
    settlementFeePayer: "receiver",
    feePayerAddress: input.profile.solanaAddress,
  };
}

export async function settlePromiseOnChain(input: {
  profile: WalletProfile;
  transfer: OfflineTransfer;
}): Promise<PromiseChainState> {
  if (!input.transfer.promiseId || !input.transfer.senderAddress) {
    throw new Error(translate("service.offair.error.promiseIncomplete"));
  }
  assertReceiverPaysSettlementFees(input.transfer);

  const senderWalletId = input.transfer.walletId ?? deriveStableWalletId(input.transfer.senderAddress);
  const receiverWalletId = input.profile.walletId;
  const programAccounts = buildProgramAccounts({ walletId: senderWalletId, promiseId: input.transfer.promiseId });
  const receiverAccounts = buildProgramAccounts({ walletId: receiverWalletId, promiseId: input.transfer.promiseId });
  const receiver = new PublicKey(input.profile.solanaAddress);
  const offairMint = getOffairMint();
  const senderCapacityAccount = getSenderCapacityAccountAddress(programAccounts.walletRegistry, offairMint);
  const payload = Buffer.concat([
    instructionOpcode(IX_SETTLE_PROMISE),
    encodeString(input.transfer.promiseId),
  ]);
  const instruction = new TransactionInstruction({
    programId: programAccounts.programId,
    keys: [
      { pubkey: receiver, isSigner: true, isWritable: true },
      { pubkey: programAccounts.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: programAccounts.walletRegistry, isSigner: false, isWritable: true },
      { pubkey: programAccounts.reserveVault, isSigner: false, isWritable: true },
      { pubkey: receiverAccounts.walletRegistry, isSigner: false, isWritable: true },
      { pubkey: programAccounts.promiseRecord, isSigner: false, isWritable: true },
      { pubkey: offairMint, isSigner: false, isWritable: true },
      { pubkey: senderCapacityAccount, isSigner: false, isWritable: true },
      { pubkey: receiver, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: payload,
  });
  const settleTx = await submitInstructions({
    walletId: input.profile.walletId,
    instructions: [instruction],
    operation: "settle_promise",
    instructionLabels: ["settle_promise"],
  });
  const promise = await fetchPromiseChainState(input.transfer.promiseId);

  return {
    promiseId: input.transfer.promiseId,
    senderAddress: input.transfer.senderAddress,
    receiverAddress: input.profile.solanaAddress,
    amountLamports: promise?.amountLamports ?? "0",
    offairAmount: promise?.offairAmount ?? "0",
    status: promise?.status ?? "pending",
    createdAt: promise?.createdAt ?? input.transfer.createdAt,
    lastAttemptAt: promise?.lastAttemptAt,
    settledAt: promise?.settledAt,
    settleTx,
    settlementFeePayer: "receiver",
    feePayerAddress: input.profile.solanaAddress,
  };
}

export async function fetchPromiseChainState(promiseId: string): Promise<PromiseChainState | null> {
  const programId = getProgramId();
  const [promiseRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from(PROMISE_SEED_PREFIX), Buffer.from(promiseId, "utf8")],
    programId,
  );
  const buffer = await getAccountBuffer(promiseRecord);
  if (!buffer) {
    return null;
  }
  const record = parsePromiseRecord(buffer);
  const receipt = await fetchPromiseReceiptState(promiseId);
  return {
    promiseId: record.promiseId,
    senderAddress: record.senderWallet,
    receiverAddress: record.receiverWallet,
    amountLamports: record.amountLamports.toString(),
    offairAmount: record.amountLamports.toString(),
    status: record.status,
    offlineSettlementTier: record.offlineSettlementTier,
    receiptMaterializationRequired: record.receiptMaterializationRequired,
    createdAt: record.createdAt,
    lastAttemptAt: record.lastAttemptAt,
    settledAt: record.settledAt,
    receiptMint: receipt?.receiptMint,
    receiptTokenAccount: receipt?.receiptTokenAccount,
    receiptMintedAt: receipt?.mintedAt,
    settlementFeePayer: "receiver",
    feePayerAddress: record.receiverWallet,
  };
}

export async function fetchPromiseReceiptState(promiseId: string): Promise<PromiseTokenState | null> {
  const programId = getProgramId();
  const [promiseReceiptRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from(PROMISE_RECEIPT_SEED_PREFIX), Buffer.from(promiseId, "utf8")],
    programId,
  );
  const buffer = await getAccountBuffer(promiseReceiptRecord);
  if (!buffer) {
    return null;
  }
  const record = parsePromiseReceiptRecord(buffer);
  return {
    promiseId: record.promiseId,
    receiverAddress: record.receiverWallet,
    receiptMint: record.receiptMint,
    receiptTokenAccount: record.receiptTokenAccount,
    mintedAt: record.mintedAt,
    settlementFeePayer: "receiver",
    feePayerAddress: record.receiverWallet,
  };
}

export async function processIncomingPromises(input: {
  profile: WalletProfile;
  journal: OfflineTransfer[];
}): Promise<{
  states: Map<string, PromiseChainState>;
  logs: string[];
}> {
  const states = new Map<string, PromiseChainState>();
  const logs: string[] = [];

  for (const transfer of input.journal) {
    if (
      transfer.assetId !== "OFFAIR" ||
      !transfer.promiseId ||
      transfer.receiverAddress !== input.profile.solanaAddress ||
      transfer.settlementStatus !== "pending"
    ) {
      continue;
    }

    try {
      let chainState = await fetchPromiseChainState(transfer.promiseId);
      if (!chainState) {
        chainState = await claimPromiseOnChain({ profile: input.profile, transfer });
        logs.push(`Claimed promise ${transfer.promiseId}.`);
      }

      const shouldMaterializeReceipt =
        chainState.receiptMaterializationRequired ?? transfer.receiptMaterializationRequired ?? false;
      if (!chainState.receiptMint && shouldMaterializeReceipt) {
        try {
          const receipt = await materializePromiseReceiptOnChain({ profile: input.profile, transfer });
          chainState = {
            ...chainState,
            receiptMint: receipt.receiptMint,
            receiptTokenAccount: receipt.receiptTokenAccount,
            receiptMintedAt: receipt.mintedAt,
          };
          logs.push(`Materialized receipt ${receipt.receiptMint} for promise ${transfer.promiseId}.`);
        } catch (error) {
          const message = `Promise ${transfer.promiseId} receipt materialization failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          logs.push(message);
        }
      }

      if (chainState.status !== "settled") {
        chainState = await settlePromiseOnChain({ profile: input.profile, transfer });
        const message =
          chainState.status === "settled"
            ? `Settled promise ${transfer.promiseId}.`
            : `Promise ${transfer.promiseId} remains pending until reserve funding is sufficient.`;
        logs.push(message);
      }

      states.set(transfer.promiseId, chainState);
    } catch (error) {
      void recordDiagnosticError("offair.process", error, {
        promiseId: transfer.promiseId,
      });
      const message = `Promise ${transfer.promiseId} failed: ${error instanceof Error ? error.message : String(error)}`;
      logs.push(message);
    }
  }

  return { states, logs };
}

export async function ensureWalletProtocolState(input: {
  profile: WalletProfile;
  devicePublicKey?: string;
  allowOnChainMutation?: boolean;
}): Promise<{
  protocol: ProtocolLimits;
  registry: WalletPublicProfile;
  reserve: ReserveBalance;
  registrationTx?: string;
  rotationTx?: string;
}> {
  const protocol = await fetchProtocolLimits();
  let registry = await waitForWalletPublicProfile(input.profile.walletId);
  let registrationTx: string | undefined;
  let rotationTx: string | undefined;

  if (!registry) {
    if (!input.allowOnChainMutation) {
      throw new Error(translate("service.offair.error.registryUnavailable"));
    }
    registrationTx = await registerWalletOnChain(input);
    registry = await waitForWalletPublicProfile(input.profile.walletId);
  } else if (input.devicePublicKey && registry.activeDevicePublicKey !== input.devicePublicKey) {
    if (input.allowOnChainMutation) {
      rotationTx = await rotateDeviceKeyOnChain({
        profile: input.profile,
        devicePublicKey: input.devicePublicKey,
      });
      registry = await waitForWalletPublicProfile(input.profile.walletId);
    }
  }

  if (!registry) {
    throw new Error(translate("service.offair.error.registryUnavailable"));
  }

  return {
    protocol,
    registry,
    reserve: await fetchReserveBalance(input.profile),
    registrationTx,
    rotationTx,
  };
}
