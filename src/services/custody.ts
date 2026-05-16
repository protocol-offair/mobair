import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Buffer } from "buffer";
import forge from "node-forge";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

import { canonicalStringify, createNonce, deriveStableWalletId, sha256Hex } from "@protocol-offair/shared";
import { IDENTITY_DERIVATION_VERSION } from "@protocol-offair/shared";
import type {
  AssetBalance,
  ChainAssetId,
  OptionalCertificateProfile,
  PendingChainTransaction,
  PromiseSignature,
  SolanaTransferIntent,
  WalletIdentityProfile,
  WalletProfile,
  WalletRegistryEntry,
  WalletSecurityState,
} from "@protocol-offair/shared";

import { translate } from "../i18n";

const DERIVATION_PATH = "m/44'/501'/0'/0'";
const LEGACY_WALLET_VAULT_KEY = "airpay.wallet.vault";
const LEGACY_WALLET_METADATA_KEY = "airpay.wallet.metadata";
const WALLET_REGISTRY_KEY = "airpay.wallet.registry";
const ACTIVE_WALLET_ID_KEY = "airpay.wallet.active";
const AUTH_PROMPT = "Authenticate to unlock your AirPay wallet.";
const WALLET_AUTHORIZATION_CACHE_TTL_MS = 60_000;
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SOL_DECIMALS = 9;
const DEFAULT_OFFAIR_DECIMALS = 6;
const WALLET_CONTEXT_CACHE_TTL_MS = 20_000;
const WALLET_CONTEXT_BACKGROUND_CLEAR_DELAY_MS = 20_000;
const WALLET_BIOMETRIC_AUTHORIZATION_ENABLED = false;
const CERTIFICATE_MIME_TYPES = [
  "application/x-pkcs12",
  "application/pkcs12",
  "application/octet-stream",
];

interface WalletVaultPayload {
  identity: WalletIdentityProfile;
  mnemonic: string;
  passphrase: string;
  createdAt: string;
  importedAt?: string | null;
}

interface WalletCertificateSecret {
  pfxBase64: string;
  password: string;
}

interface DerivedWalletContext {
  keypair: Keypair;
  identityKeypair: ReturnType<typeof nacl.sign.keyPair.fromSeed>;
  pqPublicKey: Uint8Array;
  pqSecretKey: Uint8Array;
  profile: WalletProfile;
}

interface CachedWalletContext {
  walletId: string;
  context: DerivedWalletContext;
  expiresAt: number;
}

interface CachedWalletAuthorization {
  walletId: string;
  expiresAt: number;
}

export interface StoredWalletMetadata {
  profile: WalletProfile;
  security: WalletSecurityState;
  balances: AssetBalance[];
}

export interface SolanaAssetConfig {
  symbol: ChainAssetId;
  decimals: number;
  mintAddress?: string;
}

export interface WalletProvisioningResult {
  profile: WalletProfile;
  security: WalletSecurityState;
  mnemonic: string;
}

let cachedWalletContext: CachedWalletContext | null = null;
let cachedWalletAuthorization: CachedWalletAuthorization | null = null;
let walletContextCacheLifecycleBound = false;
let walletContextBackgroundClearTimer: ReturnType<typeof setTimeout> | null = null;

function clearWalletContextCache() {
  if (walletContextBackgroundClearTimer) {
    clearTimeout(walletContextBackgroundClearTimer);
    walletContextBackgroundClearTimer = null;
  }
  cachedWalletContext = null;
  cachedWalletAuthorization = null;
}

function bindWalletContextCacheLifecycle() {
  if (walletContextCacheLifecycleBound) {
    return;
  }

  AppState.addEventListener("change", (nextState) => {
    if (nextState === "background") {
      if (!walletContextBackgroundClearTimer) {
        walletContextBackgroundClearTimer = setTimeout(() => {
          clearWalletContextCache();
        }, WALLET_CONTEXT_BACKGROUND_CLEAR_DELAY_MS);
      }
      return;
    }

    if (walletContextBackgroundClearTimer) {
      clearTimeout(walletContextBackgroundClearTimer);
      walletContextBackgroundClearTimer = null;
    }
  });
  walletContextCacheLifecycleBound = true;
}

function normalizeWalletProfile(profile: WalletProfile): WalletProfile {
  return {
    ...profile,
    publicKeyAnchored: Boolean(profile.publicKeyAnchored),
    publicKeyAnchorTx: profile.publicKeyAnchorTx ?? null,
    publicKeyAnchoredAt: profile.publicKeyAnchoredAt ?? null,
  };
}

function normalizeRegistryEntry(entry: WalletRegistryEntry): WalletRegistryEntry {
  return {
    ...entry,
    publicKeyAnchored: Boolean(entry.publicKeyAnchored),
    publicKeyAnchorTx: entry.publicKeyAnchorTx ?? null,
    publicKeyAnchoredAt: entry.publicKeyAnchoredAt ?? null,
  };
}

export interface SignTransferInput {
  walletId?: string;
  assetId: ChainAssetId;
  toAddress: string;
  amount: string;
  memo?: string;
  reference?: string;
  recentBlockhash?: string;
  airMintAddress?: string;
  airDecimals?: number;
}

function registryStorageKey() {
  return WALLET_REGISTRY_KEY;
}

function metadataStorageKey(walletId: string) {
  return `airpay.wallet.metadata.${walletId}`;
}

function vaultStorageKey(walletId: string) {
  return `airpay.wallet.vault.${walletId}`;
}

function walletAuthorizationStorageKey(walletId: string) {
  return `airpay.wallet.auth.${walletId}`;
}

function certificateStorageKey(walletId: string) {
  return `airpay.wallet.cert.${walletId}`;
}

function getStorageOptions(walletId: string): SecureStore.SecureStoreOptions {
  return {
    keychainService: vaultStorageKey(walletId),
  };
}

function getWalletAuthorizationOptions(walletId: string, prompt = AUTH_PROMPT): SecureStore.SecureStoreOptions {
  return {
    keychainService: walletAuthorizationStorageKey(walletId),
    requireAuthentication: WALLET_BIOMETRIC_AUTHORIZATION_ENABLED,
    authenticationPrompt: prompt,
  };
}

function getLegacyAuthenticatedStorageOptions(walletId: string, prompt = AUTH_PROMPT): SecureStore.SecureStoreOptions {
  return {
    keychainService: vaultStorageKey(walletId),
    requireAuthentication: false,
    authenticationPrompt: prompt,
  };
}

function getCertificateStorageOptions(walletId: string): SecureStore.SecureStoreOptions {
  return {
    keychainService: certificateStorageKey(walletId),
  };
}

function createSecurityState(partial?: Partial<WalletSecurityState>): WalletSecurityState {
  return {
    storage: "secure-store",
    keyEnvelopeVersion: 3,
    lastImportAt: null,
    lastMnemonicRevealAt: null,
    certificateImportedAt: null,
    certificateBacked: false,
    ...partial,
    biometryAvailable: SecureStore.canUseBiometricAuthentication(),
    biometricProtected: WALLET_BIOMETRIC_AUTHORIZATION_ENABLED && SecureStore.canUseBiometricAuthentication(),
  };
}

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(" ");
}

function hardenEd25519Index(index: number): number {
  return (index | 0x80000000) >>> 0;
}

function serializeIndex(index: number): Uint8Array {
  return new Uint8Array([
    (index >>> 24) & 0xff,
    (index >>> 16) & 0xff,
    (index >>> 8) & 0xff,
    index & 0xff,
  ]);
}

function parseDerivationPath(path: string): number[] {
  if (!path.startsWith("m")) {
    throw new Error(translate("service.custody.error.path"));
  }

  return path
    .split("/")
    .slice(1)
    .filter(Boolean)
    .map((segment) => {
      if (!segment.endsWith("'")) {
        throw new Error(translate("service.custody.error.hardened"));
      }

      const value = Number.parseInt(segment.slice(0, -1), 10);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(translate("service.custody.error.segment", { segment }));
      }

      return hardenEd25519Index(value);
    });
}

function deriveEd25519Slip10Seed(seed: Uint8Array, path: string): Uint8Array {
  let keyMaterial = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let secretKey = keyMaterial.slice(0, 32);
  let chainCode = keyMaterial.slice(32);

  for (const index of parseDerivationPath(path)) {
    const data = new Uint8Array(1 + secretKey.length + 4);
    data[0] = 0;
    data.set(secretKey, 1);
    data.set(serializeIndex(index), 1 + secretKey.length);

    keyMaterial = hmac(sha512, chainCode, data);
    secretKey = keyMaterial.slice(0, 32);
    chainCode = keyMaterial.slice(32);
  }

  return secretKey;
}

function deriveWalletId(publicKey: string): string {
  return deriveStableWalletId(publicKey);
}

function derivePostQuantumSeed(seed: Uint8Array, walletId: string): Uint8Array {
  return hmac(sha512, new TextEncoder().encode(`airpay:ml-dsa65:${walletId}`), seed).slice(0, 32);
}

function deriveIdentitySeed(seed: Uint8Array, identityContextHash: string): Uint8Array {
  return hmac(
    sha512,
    new TextEncoder().encode(`airpay:identity:v${IDENTITY_DERIVATION_VERSION}:${identityContextHash}`),
    seed,
  ).slice(0, 32);
}

function deriveWalletProfile(bundle: WalletVaultPayload, certificateProfile?: OptionalCertificateProfile | null): DerivedWalletContext {
  const seed = mnemonicToSeedSync(bundle.mnemonic, bundle.passphrase);
  const derivedSeed = deriveEd25519Slip10Seed(seed, DERIVATION_PATH);
  const pair = nacl.sign.keyPair.fromSeed(derivedSeed);
  const keypair = Keypair.fromSecretKey(Uint8Array.from(pair.secretKey));
  const publicKey = keypair.publicKey.toBase58();
  const walletId = deriveWalletId(publicKey);
  const identityContextHash = sha256Hex(
    canonicalStringify({
      version: IDENTITY_DERIVATION_VERSION,
      walletId,
      publicKey,
    }),
  );
  const identityKeypair = nacl.sign.keyPair.fromSeed(deriveIdentitySeed(seed, identityContextHash));
  const pqKeys = ml_dsa65.keygen(derivePostQuantumSeed(seed, walletId));

  return {
    keypair,
    identityKeypair,
    pqPublicKey: pqKeys.publicKey,
    pqSecretKey: pqKeys.secretKey,
    profile: {
      walletId,
      solanaAddress: publicKey,
      publicKey,
      postQuantumPublicKey: Buffer.from(pqKeys.publicKey).toString("base64"),
      identityDerivationVersion: IDENTITY_DERIVATION_VERSION,
      identityContextHash,
      identityPublicKey: bs58.encode(identityKeypair.publicKey),
      publicKeyAnchored: false,
      publicKeyAnchorTx: null,
      publicKeyAnchoredAt: null,
      derivationPath: DERIVATION_PATH,
      createdAt: bundle.createdAt,
      backupConfirmedAt: bundle.importedAt ?? null,
      hasPassphrase: bundle.passphrase.trim().length > 0,
      exportable: true,
      mnemonicWordCount: bundle.mnemonic.trim().split(/\s+/).length,
      certificateProfile: certificateProfile ?? null,
      ...bundle.identity,
    },
  };
}

function ensureValidMnemonic(mnemonic: string): string {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error(translate("service.custody.error.mnemonic"));
  }

  return normalized;
}

function createMemoInstruction(memo?: string): TransactionInstruction | null {
  if (!memo?.trim()) {
    return null;
  }

  return new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo.trim(), "utf8"),
  });
}

function parseDecimalAmount(amount: string, decimals: number): bigint {
  const normalized = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(translate("service.custody.error.amount"));
  }

  const [whole, fraction = ""] = normalized.split(".");
  const paddedFraction = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  return BigInt(`${whole}${paddedFraction}`);
}

function buildSerializedTransaction(context: DerivedWalletContext, intent: SolanaTransferIntent): string | undefined {
  if (!intent.recentBlockhash) {
    return undefined;
  }

  const fromPublicKey = context.keypair.publicKey;
  const transaction = new Transaction({
    feePayer: fromPublicKey,
    recentBlockhash: intent.recentBlockhash,
  });
  const memoInstruction = createMemoInstruction(intent.memo);
  const referencePublicKey = intent.reference ? new PublicKey(intent.reference) : null;
  const attachReference = (instruction: TransactionInstruction) => {
    if (referencePublicKey) {
      instruction.keys.push({
        pubkey: referencePublicKey,
        isSigner: false,
        isWritable: false,
      });
    }
    return instruction;
  };

  if (intent.assetId === "SOL") {
    const lamports = Number(parseDecimalAmount(intent.amount, intent.decimals));
    if (!Number.isSafeInteger(lamports)) {
      throw new Error(translate("service.custody.error.solRange"));
    }
    transaction.add(
      attachReference(
        SystemProgram.transfer({
          fromPubkey: fromPublicKey,
          toPubkey: new PublicKey(intent.toAddress),
          lamports,
        }),
      ),
    );
  } else {
    if (!intent.tokenMint) {
      return undefined;
    }

    const mint = new PublicKey(intent.tokenMint);
    const senderAta = getAssociatedTokenAddressSync(mint, fromPublicKey, false);
    const recipientAta = getAssociatedTokenAddressSync(mint, new PublicKey(intent.toAddress), false);
    transaction.add(
      attachReference(
        createTransferInstruction(
          senderAta,
          recipientAta,
          fromPublicKey,
          parseDecimalAmount(intent.amount, intent.decimals),
        ),
      ),
    );
  }

  if (memoInstruction) {
    transaction.add(memoInstruction);
  }

  transaction.sign(context.keypair);
  return Buffer.from(transaction.serialize()).toString("base64");
}

function createSignedEnvelope(context: DerivedWalletContext, intent: SolanaTransferIntent) {
  const signedMessage = canonicalStringify(intent);
  const signature = nacl.sign.detached(new TextEncoder().encode(signedMessage), context.keypair.secretKey);

  return {
    intentId: intent.intentId,
    publicKey: context.profile.publicKey,
    signedMessage,
    signature: bs58.encode(signature),
    signedAt: new Date().toISOString(),
    serializedTransaction: buildSerializedTransaction(context, intent),
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
  };
}

function certificateFingerprintFromDerBytes(derBytes: string): string {
  const md = forge.md.sha256.create();
  md.update(derBytes);
  return md.digest().toHex();
}

function formatDistinguishedName(name: forge.pki.CertificateField[] | forge.pki.Certificate["subject"]): string {
  const attributes = Array.isArray(name) ? name : name.attributes;
  return attributes
    .map((attribute) => `${attribute.shortName ?? attribute.name}=${attribute.value}`)
    .join(", ");
}

function inferCertificateAlgorithm(key: forge.pki.PrivateKey | null | undefined): OptionalCertificateProfile["algorithm"] {
  if (!key) {
    return undefined;
  }

  if ("n" in key && "e" in key) {
    return "x509-rsa-sha256";
  }

  return undefined;
}

function parseCertificateProfile(pfxBase64: string, password: string, fileName?: string): {
  profile: OptionalCertificateProfile;
  privateKey: forge.pki.PrivateKey | null;
} {
  const der = forge.util.decode64(pfxBase64);
  const asn1 = forge.asn1.fromDer(der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const keyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ??
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ??
    [];

  const certificateBag = certBags[0];
  const privateKeyBag = keyBags[0];
  const certificate = certificateBag?.cert ?? null;
  const privateKey = privateKeyBag?.key ?? null;
  const certificateDer = certificate ? forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes() : "";
  const fingerprint = certificate ? certificateFingerprintFromDerBytes(certificateDer) : sha256Hex(`${fileName ?? "pfx"}:${pfxBase64.length}`);

  return {
    profile: {
      certificateId: sha256Hex(`certificate:${fingerprint}`).slice(0, 24),
      alias: fileName ?? "imported-a1",
      fileName,
      fingerprint,
      subject: certificate ? formatDistinguishedName(certificate.subject) : "Unknown subject",
      issuer: certificate ? formatDistinguishedName(certificate.issuer) : "Unknown issuer",
      serialNumber: certificate?.serialNumber,
      validFrom: certificate?.validity.notBefore?.toISOString(),
      validTo: certificate?.validity.notAfter?.toISOString(),
      algorithm: inferCertificateAlgorithm(privateKey),
      importedAt: new Date().toISOString(),
    },
    privateKey,
  };
}

async function saveRegistry(entries: WalletRegistryEntry[]) {
  await AsyncStorage.setItem(registryStorageKey(), JSON.stringify(entries));
}

async function setActiveWalletId(walletId: string) {
  await AsyncStorage.setItem(ACTIVE_WALLET_ID_KEY, walletId);
}

async function getActiveWalletId(): Promise<string | null> {
  return AsyncStorage.getItem(ACTIVE_WALLET_ID_KEY);
}

async function storeVault(payload: WalletVaultPayload, walletId: string): Promise<void> {
  clearWalletContextCache();
  await SecureStore.setItemAsync(vaultStorageKey(walletId), JSON.stringify(payload), getStorageOptions(walletId));
  await provisionWalletAuthorizationGuard(walletId, translate("service.custody.auth.create"));
}

async function loadVault(
  walletId: string,
  options: {
    allowLegacyAuthentication?: boolean;
    prompt?: string;
  } = {},
): Promise<WalletVaultPayload> {
  const raw = await SecureStore.getItemAsync(vaultStorageKey(walletId), getStorageOptions(walletId)).catch(() => null);
  if (raw) {
    return JSON.parse(raw) as WalletVaultPayload;
  }

  if (options.allowLegacyAuthentication && SecureStore.canUseBiometricAuthentication()) {
    const legacyRaw = await SecureStore.getItemAsync(
      vaultStorageKey(walletId),
      getLegacyAuthenticatedStorageOptions(walletId, options.prompt),
    );
    if (legacyRaw) {
      return JSON.parse(legacyRaw) as WalletVaultPayload;
    }
  }

  throw new Error(translate("service.custody.error.walletMissing"));
}

function hasFreshWalletAuthorization(walletId: string): boolean {
  return Boolean(
    cachedWalletAuthorization?.walletId === walletId &&
      cachedWalletAuthorization.expiresAt > Date.now(),
  );
}

function rememberWalletAuthorization(walletId: string) {
  cachedWalletAuthorization = {
    walletId,
    expiresAt: Date.now() + WALLET_AUTHORIZATION_CACHE_TTL_MS,
  };
}

async function provisionWalletAuthorizationGuard(walletId: string, prompt: string): Promise<void> {
  if (!WALLET_BIOMETRIC_AUTHORIZATION_ENABLED || !SecureStore.canUseBiometricAuthentication()) {
    return;
  }

  await SecureStore.setItemAsync(
    walletAuthorizationStorageKey(walletId),
    createNonce("wallet-auth"),
    getWalletAuthorizationOptions(walletId, prompt),
  );
  rememberWalletAuthorization(walletId);
}

async function requireWalletAuthorization(walletId: string, prompt: string): Promise<void> {
  if (!WALLET_BIOMETRIC_AUTHORIZATION_ENABLED || !SecureStore.canUseBiometricAuthentication() || hasFreshWalletAuthorization(walletId)) {
    return;
  }

  const token = await SecureStore.getItemAsync(
    walletAuthorizationStorageKey(walletId),
    getWalletAuthorizationOptions(walletId, prompt),
  );
  if (!token) {
    await provisionWalletAuthorizationGuard(walletId, prompt);
    return;
  }

  rememberWalletAuthorization(walletId);
}

function usesLegacyAuthenticatedVault(metadata: StoredWalletMetadata | null): boolean {
  return (metadata?.security.keyEnvelopeVersion ?? 2) < 3;
}

async function loadAuthorizedVault(
  walletId: string,
  prompt: string,
): Promise<{ vault: WalletVaultPayload; metadata: StoredWalletMetadata | null }> {
  const metadata = await loadWalletMetadata(walletId);
  if (usesLegacyAuthenticatedVault(metadata)) {
    const vault = await loadVault(walletId, {
      allowLegacyAuthentication: true,
      prompt,
    });
    rememberWalletAuthorization(walletId);
    return {
      vault,
      metadata,
    };
  }

  await requireWalletAuthorization(walletId, prompt);
  return {
    vault: await loadVault(walletId),
    metadata,
  };
}

async function loadCertificateSecret(walletId: string): Promise<WalletCertificateSecret | null> {
  const raw = await SecureStore.getItemAsync(certificateStorageKey(walletId), getCertificateStorageOptions(walletId));
  return raw ? (JSON.parse(raw) as WalletCertificateSecret) : null;
}

async function saveCertificateSecret(walletId: string, payload: WalletCertificateSecret): Promise<void> {
  await SecureStore.setItemAsync(
    certificateStorageKey(walletId),
    JSON.stringify(payload),
    getCertificateStorageOptions(walletId),
  );
}

async function saveMetadata(metadata: StoredWalletMetadata): Promise<void> {
  const normalizedProfile = normalizeWalletProfile(metadata.profile);
  const normalizedMetadata: StoredWalletMetadata = {
    ...metadata,
    profile: normalizedProfile,
  };
  await AsyncStorage.setItem(metadataStorageKey(normalizedProfile.walletId), JSON.stringify(normalizedMetadata));
  const activeWalletId = (await getActiveWalletId()) ?? normalizedProfile.walletId;
  const registry = await loadWalletRegistry();
  const nextEntries = [
    ...registry.filter((entry) => entry.walletId !== normalizedProfile.walletId),
    toRegistryEntry(normalizedProfile, activeWalletId),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  await saveRegistry(nextEntries);
}

async function migrateLegacyStorageIfNeeded() {
  const registryRaw = await AsyncStorage.getItem(registryStorageKey());
  if (registryRaw) {
    return;
  }

  const legacyMetadataRaw = await AsyncStorage.getItem(LEGACY_WALLET_METADATA_KEY);
  if (!legacyMetadataRaw) {
    return;
  }
  const legacyVaultRaw = await SecureStore.getItemAsync(LEGACY_WALLET_VAULT_KEY, {
    keychainService: LEGACY_WALLET_VAULT_KEY,
    requireAuthentication: false,
    authenticationPrompt: AUTH_PROMPT,
  }).catch(() => null);

  if (!legacyVaultRaw) {
    return;
  }

  const legacyMetadata = JSON.parse(legacyMetadataRaw) as StoredWalletMetadata;
  const legacyVault = JSON.parse(legacyVaultRaw) as {
    mnemonic: string;
    passphrase: string;
    createdAt: string;
    importedAt?: string | null;
  };

  const identity: WalletIdentityProfile = {
    walletType: "global",
    displayName: legacyMetadata.profile.displayName ?? legacyMetadata.profile.solanaAddress.slice(0, 8),
  };

  const newBundle: WalletVaultPayload = {
    identity,
    mnemonic: legacyVault.mnemonic,
    passphrase: legacyVault.passphrase,
    createdAt: legacyVault.createdAt,
    importedAt: legacyVault.importedAt ?? legacyMetadata.profile.backupConfirmedAt ?? null,
  };
  const context = deriveWalletProfile(newBundle, legacyMetadata.profile.certificateProfile ?? null);
  const migratedMetadata: StoredWalletMetadata = {
    profile: {
      ...context.profile,
      backupConfirmedAt: legacyMetadata.profile.backupConfirmedAt,
    },
    security: {
      ...createSecurityState(),
      ...(legacyMetadata.security ?? {}),
    },
    balances: legacyMetadata.balances ?? buildInitialBalances(),
  };

  await storeVault(newBundle, context.profile.walletId);
  await setActiveWalletId(context.profile.walletId);
  await saveRegistry([toRegistryEntry(migratedMetadata.profile, context.profile.walletId)]);
  await AsyncStorage.setItem(metadataStorageKey(context.profile.walletId), JSON.stringify(migratedMetadata));
}

async function requireWalletId(walletId?: string): Promise<string> {
  await migrateLegacyStorageIfNeeded();
  const activeWalletId = walletId ?? (await getActiveWalletId());
  if (!activeWalletId) {
    throw new Error(translate("service.custody.error.walletMissing"));
  }
  return activeWalletId;
}

async function loadWalletContext(walletId?: string, prompt = AUTH_PROMPT): Promise<DerivedWalletContext> {
  bindWalletContextCacheLifecycle();
  const resolvedWalletId = await requireWalletId(walletId);
  if (cachedWalletContext?.walletId === resolvedWalletId && cachedWalletContext.expiresAt > Date.now()) {
    await requireWalletAuthorization(resolvedWalletId, prompt);
    return cachedWalletContext.context;
  }
  const { vault, metadata } = await loadAuthorizedVault(resolvedWalletId, prompt);
  const context = deriveWalletProfile(vault, metadata?.profile.certificateProfile ?? null);
  cachedWalletContext = {
    walletId: resolvedWalletId,
    context,
    expiresAt: Date.now() + WALLET_CONTEXT_CACHE_TTL_MS,
  };
  return context;
}

async function loadRegistryUnsafe(): Promise<WalletRegistryEntry[]> {
  await migrateLegacyStorageIfNeeded();
  const raw = await AsyncStorage.getItem(registryStorageKey());
  return raw ? (JSON.parse(raw) as WalletRegistryEntry[]).map(normalizeRegistryEntry) : [];
}

export function buildInitialBalances(): AssetBalance[] {
  const now = new Date().toISOString();
  return [
    {
      assetId: "SOL",
      amount: "0",
      decimals: SOL_DECIMALS,
      lastUpdatedAt: now,
      source: "cached",
    },
    {
      assetId: "OFFAIR",
      amount: "0",
      decimals: DEFAULT_OFFAIR_DECIMALS,
      lastUpdatedAt: now,
      source: "cached",
    },
  ];
}

export function buildAssetConfig(offairMintAddress?: string, offairDecimals = DEFAULT_OFFAIR_DECIMALS): Record<ChainAssetId, SolanaAssetConfig> {
  return {
    SOL: {
      symbol: "SOL",
      decimals: SOL_DECIMALS,
    },
    OFFAIR: {
      symbol: "OFFAIR",
      decimals: offairDecimals,
      mintAddress: offairMintAddress,
    },
    AIR: {
      symbol: "AIR",
      decimals: offairDecimals,
      mintAddress: offairMintAddress,
    },
  };
}

export function getWalletSecuritySnapshot(): WalletSecurityState {
  return createSecurityState();
}

export async function loadWalletRegistry(): Promise<WalletRegistryEntry[]> {
  const entries = await loadRegistryUnsafe();
  const activeWalletId = await getActiveWalletId();
  return entries.map((entry) => ({
    ...entry,
    isActiveOnDevice: entry.walletId === activeWalletId,
  }));
}

export async function loadWalletMetadata(walletId?: string): Promise<StoredWalletMetadata | null> {
  const resolvedWalletId = walletId ?? (await getActiveWalletId());
  if (!resolvedWalletId) {
    return null;
  }

  await migrateLegacyStorageIfNeeded();
  const raw = await AsyncStorage.getItem(metadataStorageKey(resolvedWalletId));
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as StoredWalletMetadata;
  return {
    ...parsed,
    profile: normalizeWalletProfile(parsed.profile),
  };
}

export async function setActiveWallet(walletId: string): Promise<StoredWalletMetadata | null> {
  const metadata = await loadWalletMetadata(walletId);
  if (!metadata) {
    return null;
  }

  await setActiveWalletId(walletId);
  const registry = await loadWalletRegistry();
  await saveRegistry(registry.map((entry) => ({ ...entry, isActiveOnDevice: entry.walletId === walletId })));
  return metadata;
}

export async function clearWalletVault(): Promise<void> {
  clearWalletContextCache();
  const registry = await loadWalletRegistry();
  const secureDeletes = registry.flatMap((entry) => [
    SecureStore.deleteItemAsync(vaultStorageKey(entry.walletId), getStorageOptions(entry.walletId)).catch(() => undefined),
    SecureStore.deleteItemAsync(walletAuthorizationStorageKey(entry.walletId), {
      keychainService: walletAuthorizationStorageKey(entry.walletId),
    }).catch(() => undefined),
    SecureStore.deleteItemAsync(certificateStorageKey(entry.walletId), getCertificateStorageOptions(entry.walletId)).catch(() => undefined),
  ]);
  const asyncDeletes = registry.map((entry) => AsyncStorage.removeItem(metadataStorageKey(entry.walletId)));

  await Promise.all([
    ...secureDeletes,
    ...asyncDeletes,
    AsyncStorage.removeItem(registryStorageKey()),
    AsyncStorage.removeItem(ACTIVE_WALLET_ID_KEY),
    SecureStore.deleteItemAsync(LEGACY_WALLET_VAULT_KEY, {
      keychainService: LEGACY_WALLET_VAULT_KEY,
      requireAuthentication: false,
      authenticationPrompt: AUTH_PROMPT,
    }).catch(() => undefined),
    AsyncStorage.removeItem(LEGACY_WALLET_METADATA_KEY),
  ]);
}

function buildProvisioningResult(
  context: DerivedWalletContext,
  security: WalletSecurityState,
  mnemonic: string,
): WalletProvisioningResult {
  return {
    mnemonic,
    profile: context.profile,
    security,
  };
}

async function upsertWallet(bundle: WalletVaultPayload, security: WalletSecurityState): Promise<WalletProvisioningResult> {
  const existingRegistry = await loadWalletRegistry();
  const context = deriveWalletProfile(bundle);

  await storeVault(bundle, context.profile.walletId);
  await setActiveWalletId(context.profile.walletId);

  const metadata: StoredWalletMetadata = {
    profile: {
      ...context.profile,
      isActiveOnDevice: true,
    },
    security,
    balances: buildInitialBalances(),
  };
  await saveMetadata(metadata);

  const nextRegistry = [
    ...existingRegistry.filter((entry) => entry.walletId !== context.profile.walletId).map((entry) => ({
      ...entry,
      isActiveOnDevice: false,
    })),
    toRegistryEntry(metadata.profile, context.profile.walletId),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  await saveRegistry(nextRegistry);

  return buildProvisioningResult(context, security, bundle.mnemonic);
}

export async function createMnemonicWallet(input: {
  passphrase: string;
  displayName?: string;
}): Promise<WalletProvisioningResult> {
  const bundle: WalletVaultPayload = {
    identity: {
      walletType: "global",
      displayName: input.displayName?.trim() || "AirPay Wallet",
    },
    mnemonic: generateMnemonic(wordlist, 128),
    passphrase: input.passphrase,
    createdAt: new Date().toISOString(),
    importedAt: null,
  };

  return upsertWallet(bundle, createSecurityState());
}

export async function importMnemonicWallet(input: {
  mnemonic: string;
  passphrase: string;
  displayName?: string;
}): Promise<WalletProvisioningResult> {
  const normalizedMnemonic = ensureValidMnemonic(input.mnemonic);
  const importedAt = new Date().toISOString();
  const bundle: WalletVaultPayload = {
    identity: {
      walletType: "global",
      displayName: input.displayName?.trim() || "Recovered Wallet",
    },
    mnemonic: normalizedMnemonic,
    passphrase: input.passphrase,
    createdAt: importedAt,
    importedAt,
  };

  return upsertWallet(
    bundle,
    createSecurityState({
      lastImportAt: importedAt,
    }),
  );
}

export async function revealMnemonic(walletId?: string): Promise<{ mnemonic: string; security: WalletSecurityState }> {
  const resolvedWalletId = await requireWalletId(walletId);
  const { vault, metadata } = await loadAuthorizedVault(resolvedWalletId, translate("service.custody.auth.reveal"));
  if (metadata) {
    const nextMetadata: StoredWalletMetadata = {
      ...metadata,
      security: {
        ...metadata.security,
        lastMnemonicRevealAt: new Date().toISOString(),
      },
    };
    await saveMetadata(nextMetadata);
  }

  return {
    mnemonic: vault.mnemonic,
    security: createSecurityState({
      lastMnemonicRevealAt: new Date().toISOString(),
      certificateBacked: Boolean(metadata?.profile.certificateProfile),
      certificateImportedAt: metadata?.profile.certificateProfile?.importedAt ?? null,
    }),
  };
}

export async function importWalletCertificate(walletId?: string): Promise<OptionalCertificateProfile> {
  const resolvedWalletId = await requireWalletId(walletId);
  const selection = await DocumentPicker.getDocumentAsync({
    multiple: false,
    type: CERTIFICATE_MIME_TYPES,
    copyToCacheDirectory: true,
  });

  if (selection.canceled || !selection.assets[0]?.uri) {
    throw new Error(translate("service.custody.error.certificateNoFile"));
  }

  const picked = selection.assets[0];
  const password = await SecureStore.getItemAsync(`${certificateStorageKey(resolvedWalletId)}.passwordHint`);
  const base64Payload = await FileSystem.readAsStringAsync(picked.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const parsed = parseCertificateProfile(base64Payload, password ?? "");
  const profile: OptionalCertificateProfile = {
    ...parsed.profile,
    fileName: picked.name ?? parsed.profile.fileName,
  };

  await saveCertificateSecret(resolvedWalletId, {
    pfxBase64: base64Payload,
    password: password ?? "",
  });

  const metadata = await loadWalletMetadata(resolvedWalletId);
  if (metadata) {
    await saveMetadata({
      ...metadata,
      profile: {
        ...metadata.profile,
        certificateProfile: profile,
      },
      security: {
        ...metadata.security,
        certificateImportedAt: profile.importedAt,
        certificateBacked: Boolean(profile.algorithm),
      },
    });
  }

  return profile;
}

export async function importWalletCertificateFromBase64(input: {
  walletId?: string;
  pfxBase64: string;
  password: string;
  fileName?: string;
}): Promise<OptionalCertificateProfile> {
  const resolvedWalletId = await requireWalletId(input.walletId);
  const parsed = parseCertificateProfile(input.pfxBase64, input.password, input.fileName);

  await saveCertificateSecret(resolvedWalletId, {
    pfxBase64: input.pfxBase64,
    password: input.password,
  });
  await SecureStore.setItemAsync(`${certificateStorageKey(resolvedWalletId)}.passwordHint`, input.password);

  const metadata = await loadWalletMetadata(resolvedWalletId);
  if (metadata) {
    await saveMetadata({
      ...metadata,
      profile: {
        ...metadata.profile,
        certificateProfile: parsed.profile,
      },
      security: {
        ...metadata.security,
        certificateImportedAt: parsed.profile.importedAt,
        certificateBacked: Boolean(parsed.profile.algorithm),
      },
    });
  }

  return parsed.profile;
}

async function maybeCreateCertificateSignature(walletId: string, message: string): Promise<PromiseSignature | null> {
  const metadata = await loadWalletMetadata(walletId);
  const certificateProfile = metadata?.profile.certificateProfile;
  if (!certificateProfile) {
    return null;
  }

  const certificateSecret = await loadCertificateSecret(walletId);
  if (!certificateSecret || certificateProfile.algorithm !== "x509-rsa-sha256") {
    return null;
  }

  const parsed = parseCertificateProfile(certificateSecret.pfxBase64, certificateSecret.password, certificateProfile.fileName);
  if (!parsed.privateKey || !("n" in parsed.privateKey)) {
    return null;
  }

  const md = forge.md.sha256.create();
  md.update(message, "utf8");
  const signature = parsed.privateKey.sign(md);

  return {
    role: "certificate",
    algorithm: "x509-rsa-sha256",
    signature: Buffer.from(signature, "binary").toString("base64"),
    keyId: certificateProfile.certificateId,
    certificateFingerprint: certificateProfile.fingerprint,
    metadata: {
      subject: certificateProfile.subject,
      issuer: certificateProfile.issuer,
      validTo: certificateProfile.validTo,
    },
  };
}

export async function signWalletMessage(message: string, walletId?: string): Promise<{ publicKey: string; signature: string }> {
  const context = await loadWalletContext(walletId, translate("service.custody.auth.unlock"));
  const signature = nacl.sign.detached(new TextEncoder().encode(message), context.keypair.secretKey);

  return {
    publicKey: context.profile.publicKey,
    signature: bs58.encode(signature),
  };
}

export async function serializeWalletInstructionsTransaction(input: {
  walletId?: string;
  instructions: TransactionInstruction[];
  recentBlockhash: string;
}): Promise<{
  walletId: string;
  publicKey: string;
  serializedTransaction: string;
  signature: string;
}> {
  const context = await loadWalletContext(input.walletId, translate("service.custody.auth.sign"));
  const transaction = new Transaction({
    feePayer: context.keypair.publicKey,
    recentBlockhash: input.recentBlockhash,
  });

  for (const instruction of input.instructions) {
    transaction.add(instruction);
  }

  transaction.sign(context.keypair);
  const signature = transaction.signature;
  if (!signature) {
    throw new Error("Wallet transaction signature was not produced.");
  }

  return {
    walletId: context.profile.walletId,
    publicKey: context.profile.publicKey,
    serializedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
    signature: bs58.encode(signature),
  };
}

export async function signAndSerializeTransaction(input: {
  walletId?: string;
  instructions: TransactionInstruction[];
  recentBlockhash: string;
  additionalSigners?: Keypair[];
}): Promise<{
  publicKey: string;
  signature: string;
  serializedTransaction: string;
}> {
  const context = await loadWalletContext(input.walletId, translate("service.custody.auth.sign"));
  const transaction = new Transaction({
    feePayer: context.keypair.publicKey,
    recentBlockhash: input.recentBlockhash,
  });

  for (const instruction of input.instructions) {
    transaction.add(instruction);
  }

  transaction.sign(context.keypair, ...(input.additionalSigners ?? []));
  const signature = transaction.signature;
  if (!signature) {
    throw new Error(translate("service.custody.error.transactionSignature"));
  }

  return {
    publicKey: context.profile.publicKey,
    signature: bs58.encode(signature),
    serializedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
  };
}

export async function createWalletPromiseSignatures(input: {
  message: string;
  walletId?: string;
}): Promise<{
  walletId: string;
  profile: WalletProfile;
  signatures: PromiseSignature[];
  certificateProfile?: OptionalCertificateProfile | null;
}> {
  const context = await loadWalletContext(input.walletId, translate("service.custody.auth.sign"));
  const messageBytes = new TextEncoder().encode(input.message);
  const walletSignature = nacl.sign.detached(messageBytes, context.keypair.secretKey);
  const identitySignature = nacl.sign.detached(messageBytes, context.identityKeypair.secretKey);
  const pqSignature = ml_dsa65.sign(messageBytes, context.pqSecretKey);
  const certificateSignature = await maybeCreateCertificateSignature(context.profile.walletId, input.message);

  return {
    walletId: context.profile.walletId,
    profile: context.profile,
    signatures: [
      {
        role: "pq",
        algorithm: "ml-dsa-65",
        signature: Buffer.from(pqSignature).toString("base64"),
        publicKey: context.profile.postQuantumPublicKey,
        keyId: `pq:${context.profile.walletId}`,
      },
      {
        role: "wallet",
        algorithm: "ed25519",
        signature: bs58.encode(walletSignature),
        publicKey: context.profile.publicKey,
        keyId: `wallet:${context.profile.walletId}`,
      },
      {
        role: "identity",
        algorithm: "ed25519",
        signature: bs58.encode(identitySignature),
        publicKey: context.profile.identityPublicKey,
        keyId: `identity:${context.profile.walletId}`,
        metadata: {
          derivationVersion: context.profile.identityDerivationVersion,
          identityContextHash: context.profile.identityContextHash,
        },
      },
      ...(certificateSignature ? [certificateSignature] : []),
    ],
    certificateProfile: context.profile.certificateProfile,
  };
}

export async function prepareSignedSolanaTransfer(input: SignTransferInput): Promise<{
  intent: SolanaTransferIntent;
  envelope: {
    intentId: string;
    publicKey: string;
    signedMessage: string;
    signature: string;
    signedAt: string;
    serializedTransaction?: string;
  };
}> {
  const context = await loadWalletContext(input.walletId, translate("service.custody.auth.sign"));
  const createdAt = new Date().toISOString();
  const destination = new PublicKey(input.toAddress).toBase58();
  const intent: SolanaTransferIntent = {
    intentId: createNonce("intent"),
    walletId: context.profile.walletId,
    walletType: context.profile.walletType,
    assetId: input.assetId,
    fromAddress: context.profile.solanaAddress,
    toAddress: destination,
    amount: input.amount,
    decimals: input.assetId === "SOL" ? SOL_DECIMALS : input.airDecimals ?? DEFAULT_OFFAIR_DECIMALS,
    createdAt,
    memo: input.memo?.trim() || undefined,
    reference: input.reference ? new PublicKey(input.reference).toBase58() : undefined,
    recentBlockhash: input.recentBlockhash,
    tokenMint: input.assetId === "AIR" || input.assetId === "OFFAIR" ? input.airMintAddress : undefined,
    requiresOnlineAssembly:
      input.assetId === "AIR" || input.assetId === "OFFAIR"
        ? !Boolean(input.airMintAddress && input.recentBlockhash)
        : !Boolean(input.recentBlockhash),
  };

  return {
    intent,
    envelope: createSignedEnvelope(context, intent),
  };
}

export async function createSignedChainTransaction(input: {
  walletId?: string;
  assetId: ChainAssetId;
  toAddress: string;
  amount: string;
  memo?: string;
  reference?: string;
  recentBlockhash?: string;
  assetConfig: SolanaAssetConfig;
}): Promise<PendingChainTransaction> {
  const prepared = await prepareSignedSolanaTransfer({
    walletId: input.walletId,
    assetId: input.assetId,
    toAddress: input.toAddress,
    amount: input.amount,
    memo: input.memo,
    reference: input.reference,
    recentBlockhash: input.recentBlockhash,
    airMintAddress: input.assetConfig.mintAddress,
    airDecimals: input.assetConfig.decimals,
  });

  return {
    walletId: prepared.intent.walletId,
    walletType: prepared.intent.walletType,
    intent: prepared.intent,
    envelope: prepared.envelope,
    status: "signed",
  };
}

export async function signSolanaInstructions(input: {
  walletId?: string;
  instructions: TransactionInstruction[];
  recentBlockhash?: string;
}): Promise<string> {
  const context = await loadWalletContext(input.walletId, translate("service.custody.auth.sign"));
  const recentBlockhash = input.recentBlockhash ?? (await fetchLatestBlockhashFromRpc());
  if (!recentBlockhash) {
    throw new Error(translate("service.custody.error.blockhash"));
  }

  const transaction = new Transaction({
    feePayer: context.keypair.publicKey,
    recentBlockhash,
  });
  input.instructions.forEach((instruction) => transaction.add(instruction));
  transaction.sign(context.keypair);
  return Buffer.from(transaction.serialize()).toString("base64");
}

async function fetchLatestBlockhashFromRpc(): Promise<string | undefined> {
  const runtime = Constants.expoConfig?.extra as { solanaRpcUrl?: string } | undefined;
  const rpcUrl = runtime?.solanaRpcUrl ?? "https://devnet.rpcpool.com";

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "airpay-custody-blockhash",
        method: "getLatestBlockhash",
        params: [{ commitment: "confirmed" }],
      }),
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as { result?: { value?: { blockhash?: string } } };
    return payload.result?.value?.blockhash;
  } catch {
    return undefined;
  }
}

export function updateBackupConfirmation(profile: WalletProfile): WalletProfile {
  return {
    ...profile,
    backupConfirmedAt: new Date().toISOString(),
  };
}

export async function persistWalletProfile(profile: WalletProfile): Promise<void> {
  const metadata = await loadWalletMetadata(profile.walletId);
  if (!metadata) {
    return;
  }

  await saveMetadata({
    ...metadata,
    profile,
  });
}

export function deriveDryRunSignature(envelope: { intentId: string; signature: string; signedAt: string }): string {
  return `dryrun_${sha256Hex(`${envelope.intentId}:${envelope.signature}:${envelope.signedAt}`).slice(0, 32)}`;
}
