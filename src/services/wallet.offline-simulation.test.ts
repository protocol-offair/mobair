import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
  secureStorage: new Map<string, string>(),
  transmittedTransfers: [] as Array<Record<string, any>>,
  nextReceiptOverrides: null as Record<string, any> | null,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => mocks.asyncStorage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      mocks.asyncStorage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      mocks.asyncStorage.delete(key);
    }),
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => mocks.secureStorage.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    mocks.secureStorage.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    mocks.secureStorage.delete(key);
  }),
  canUseBiometricAuthentication: vi.fn(() => false),
}));

vi.mock("../i18n", () => ({
  translate: (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
  formatDateTime: (value: string) => value,
}));

vi.mock("./chain", () => ({
  fetchLatestBlockhash: vi.fn(async () => "blockhash"),
  fetchSignatureStatuses: vi.fn(async () => []),
  fetchWalletBalances: vi.fn(async () => []),
  getWalletRuntimeConfig: vi.fn(() => ({
    solanaCluster: "devnet",
    offairTokenDecimals: 9,
  })),
  probeRpcReachability: vi.fn(async () => false),
  submitPendingChainTransaction: vi.fn(),
}));

vi.mock("./backend", () => ({
  fetchCurrentPolicyFromBackend: vi.fn(),
  fetchPendingChainTransactionsFromBackend: vi.fn(async () => []),
  provisionOfflineBudgetWithBackend: vi.fn(),
  registerDeviceWithBackend: vi.fn(),
  registerWalletWithBackend: vi.fn(),
}));

vi.mock("./custody", () => ({
  clearWalletVault: vi.fn(),
  createMnemonicWallet: vi.fn(),
  createWalletPromiseSignatures: vi.fn(async () => ({
    walletId: "wallet-sender",
    profile: {},
    signatures: [
      {
        role: "wallet",
        algorithm: "ed25519",
        signature: "wallet-signature",
        publicKey: "wallet-public-key",
        keyId: "wallet:wallet-sender",
      },
    ],
  })),
  getWalletSecuritySnapshot: vi.fn(() => createSecurity()),
  importMnemonicWallet: vi.fn(),
  importWalletCertificateFromBase64: vi.fn(),
  loadWalletMetadata: vi.fn(),
  loadWalletRegistry: vi.fn(async () => []),
  prepareSignedSolanaTransfer: vi.fn(),
  revealMnemonic: vi.fn(),
  setActiveWallet: vi.fn(),
  updateBackupConfirmation: vi.fn(),
}));

vi.mock("./integrity", () => ({
  buildDeviceManifest: vi.fn(),
  getDefaultTransportIds: vi.fn(() => createTransportIds()),
}));

vi.mock("./native/AirPayNative", () => ({
  signPayload: vi.fn(async (payload: string) => `device-signature:${payload.length}`),
}));

vi.mock("./offair", () => {
  const parseUiAmountToLamports = (amount: string) => {
    const normalized = amount.trim();
    if (!/^\d+(\.\d+)?$/.test(normalized)) {
      throw new Error("service.wallet.error.invalidTransferAmount");
    }
    const [whole, fraction = ""] = normalized.split(".");
    const padded = `${fraction}${"0".repeat(9)}`.slice(0, 9);
    return BigInt(`${whole}${padded}`);
  };

  return {
    claimPromiseOnChain: vi.fn(),
    ensureWalletProtocolState: vi.fn(),
    fetchReserveBalance: vi.fn(),
    fundReserve: vi.fn(),
    parseUiAmountToLamports,
    processIncomingPromises: vi.fn(async () => []),
    settlePromiseOnChain: vi.fn(),
    withdrawReserve: vi.fn(),
  };
});

vi.mock("./transport", () => ({
  bootstrapOfflineSession: vi.fn(),
  closeTransportSession: vi.fn(),
  transmitOfflineTransfer: vi.fn(async ({ transfer }) => {
    mocks.transmittedTransfers.push(transfer);
    return {
      receipt: {
        receiptId: "receipt-simulated",
        transferId: transfer.localTxId,
        receiverPrevTxHash: transfer.prevTxHash,
        ackSignature: "receiver-ack-signature",
        receivedAt: "2026-05-08T12:00:00.000Z",
        sessionId: transfer.sessionId,
        ...(mocks.nextReceiptOverrides ?? {}),
      },
    };
  }),
}));

vi.mock("./trust", () => ({
  evaluatePeerTrustDecision: vi.fn(() => ({
    decision: "allow",
    peerId: "receiver-wallet",
    trustBand: "neutral",
    trustScore: 70,
    riskLevel: "low",
    riskScore: 12,
    reasons: [],
  })),
  findPeerTrustPreview: vi.fn(() => null),
  loadLocalTrustState: vi.fn(async () => ({ peers: {}, blacklistDigests: {}, checkpoints: [] })),
  mutateLocalTrustState: vi.fn(async (mutator: (state: any) => any) =>
    mutator({ peers: {}, blacklistDigests: {}, checkpoints: [] }),
  ),
  recordPeerInteraction: vi.fn((state: any) => state),
}));

import { fetchLatestBlockhash, probeRpcReachability, submitPendingChainTransaction } from "./chain";
import { importMnemonicWallet, prepareSignedSolanaTransfer } from "./custody";
import {
  getOfflinePromiseCapacity,
  importCustodyWalletState,
  queueChainTransferState,
  recordIncomingTransfer,
  sendOfflineTransfer,
  submitPendingChainTransactionsState,
  type WalletState,
} from "./wallet";

const now = "2026-05-08T12:00:00.000Z";
const senderAddress = "FWHXfFtG9YE1m6rGYbcLoZJ4xJ4KAVng6E5HURy1w8ZV";
const receiverAddress = "AHZST1y4zBSRSGPqTqV35Ljk62UjSiMyBs1QtQvX6i1U";

function createTransportIds() {
  return {
    serviceUuid: "00000000-0000-4000-8000-000000000001",
    handshakeCharacteristicUuid: "00000000-0000-4000-8000-000000000002",
    transferCharacteristicUuid: "00000000-0000-4000-8000-000000000003",
    receiptCharacteristicUuid: "00000000-0000-4000-8000-000000000004",
    closeCharacteristicUuid: "00000000-0000-4000-8000-000000000005",
  };
}

function createSecurity() {
  return {
    storage: "secure-store" as const,
    biometryAvailable: false,
    biometricProtected: false,
    keyEnvelopeVersion: 1,
  };
}

function createWalletState(input: {
  offairAmount: string;
  reserveAmount: number;
  solAmount?: string;
  role?: "sender" | "receiver";
}): WalletState {
  const role = input.role ?? "sender";
  const walletId = role === "receiver" ? "wallet-receiver" : "wallet-sender";
  const deviceId = role === "receiver" ? "receiver-device" : "sender-device";
  const solanaAddress = role === "receiver" ? receiverAddress : senderAddress;
  const displayName = role === "receiver" ? "Receiver Wallet" : "AirPay Sender";
  const profile = {
    walletType: "global" as const,
    displayName,
    walletId,
    solanaAddress,
    publicKey: "sender-public-key",
    postQuantumPublicKey: "sender-pq-public-key",
    identityDerivationVersion: 1,
    identityContextHash: "identity-context",
    identityPublicKey: "sender-identity-public-key",
    publicKeyAnchored: true,
    publicKeyAnchorTx: "anchor-tx",
    publicKeyAnchoredAt: now,
    derivationPath: "m/44'/501'/0'/0'",
    createdAt: now,
    backupConfirmedAt: now,
    hasPassphrase: true,
    exportable: true,
    mnemonicWordCount: 12,
    isActiveOnDevice: true,
  };
  const security = createSecurity();
  const balances = {
    OFFAIR: {
      assetId: "OFFAIR" as const,
      amount: input.offairAmount,
      decimals: 9,
      lastUpdatedAt: now,
      source: "cached" as const,
    },
    SOL: {
      assetId: "SOL" as const,
      amount: input.solAmount ?? "5",
      decimals: 9,
      lastUpdatedAt: now,
      source: "cached" as const,
    },
  };
  const reserve = {
    budgetId: `reserve-${role}`,
    deviceId,
    assetId: "SOL",
    totalAmount: input.reserveAmount,
    remainingAmount: input.reserveAmount,
    remainingTransfers: input.reserveAmount > 0 ? 5 : 0,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  const snapshot = {
    profile,
    security,
    balances,
    pendingChainTransactions: [],
    onboarding: {
      rpcReachable: false,
      deviceKeyReady: true,
      onChainProfileReady: true,
      reserveReady: input.reserveAmount > 0,
      quarantined: false,
      executionSource: "local" as const,
      lastProtocolSyncAt: now,
      lastReserveCheckAt: now,
    },
    reserve,
    journal: [],
  };

  return {
    manifest: {
      deviceId,
      appVersion: "0.1.0",
      epoch: 3,
      stateRoot: "state-root",
      policyHash: "policy-hash",
      integrityLevel: "tee",
      attestationValid: true,
      lastOnlineAt: now,
      capabilities: ["ble", "attestation"],
      publicKey: "sender-device-public-key",
      walletPublicKey: profile.publicKey,
      solanaAddress: profile.solanaAddress,
      activeWalletId: profile.walletId,
      walletType: profile.walletType,
      walletDisplayName: profile.displayName,
      transportCapabilities: {
        nfc: false,
        bleCentral: true,
        blePeripheral: true,
        attestation: true,
        hce: false,
      },
    },
    policy: {
      policyId: "policy",
      policyHash: "policy-hash",
      minEpoch: 1,
      allowedStateRoots: ["state-root"],
      revokedStateRoots: [],
      maxOfflineTransfers: 5,
      maxOfflineAmount: 10,
      allowBleFallback: true,
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    statusLog: [],
    walletRegistry: [{ ...profile }],
    walletSnapshots: {
      [profile.walletId]: snapshot,
    },
    activeWalletId: profile.walletId,
    profile,
    security,
    balances,
    pendingChainTransactions: [],
    onboarding: snapshot.onboarding,
    reserve,
    journal: [],
  };
}

function createWalletShellState(): WalletState {
  const base = createWalletState({ offairAmount: "0", reserveAmount: 0 });

  return {
    ...base,
    manifest: base.manifest
      ? {
          ...base.manifest,
          walletPublicKey: undefined,
          solanaAddress: undefined,
          activeWalletId: undefined,
          walletDisplayName: undefined,
        }
      : null,
    statusLog: [],
    walletRegistry: [],
    walletSnapshots: {},
    activeWalletId: null,
    profile: null,
    security: createSecurity(),
    balances: {
      OFFAIR: {
        assetId: "OFFAIR",
        amount: "0.00",
        decimals: 6,
        lastUpdatedAt: now,
        source: "cached",
      },
      SOL: {
        assetId: "SOL",
        amount: "0.000",
        decimals: 9,
        lastUpdatedAt: now,
        source: "cached",
      },
    },
    pendingChainTransactions: [],
    onboarding: {
      rpcReachable: false,
      deviceKeyReady: false,
      onChainProfileReady: false,
      reserveReady: false,
      quarantined: false,
      executionSource: "local",
    },
    reserve: {
      budgetId: "reserve-empty",
      deviceId: base.manifest?.deviceId ?? "sender-device",
      assetId: "SOL",
      totalAmount: 0,
      remainingAmount: 0,
      remainingTransfers: 0,
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    journal: [],
  };
}

function createSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: "session-simulated",
    mode: "ble" as const,
    diagnostics: ["simulated in-memory BLE session"],
    peerProofDigest: {
      deviceId: "receiver-device",
      stateRoot: "receiver-state-root",
      baseRoot: "receiver-base-root",
      counter: 1,
      nonce: "receiver-nonce",
      lastOnlineAt: now,
      signature: "receiver-signature",
    },
    peerWalletAddress: receiverAddress,
    peerWalletId: "wallet-receiver",
    peerDisplayName: "Receiver Wallet",
    peerRpcReachable: false,
    peerInstantClaimCapable: false,
    peerTransportPublicKey: "receiver-transport-public-key",
    promotedToBle: false,
    transportIds: createTransportIds(),
    device: { id: "simulated-ble-device" },
    bleLease: {
      purpose: "scan",
      originalState: "PoweredOn",
      enabledByApp: false,
      restored: false,
    },
    ...overrides,
  } as any;
}

describe("wallet offline MVP simulation", () => {
  beforeEach(() => {
    mocks.asyncStorage.clear();
    mocks.secureStorage.clear();
    mocks.transmittedTransfers.length = 0;
    mocks.nextReceiptOverrides = null;
    vi.mocked(probeRpcReachability).mockResolvedValue(false);
    vi.mocked(importMnemonicWallet).mockReset();
    vi.mocked(prepareSignedSolanaTransfer).mockReset();
    vi.mocked(submitPendingChainTransaction).mockReset();
  });

  it("imports a custody wallet into active app state and reports import-specific deferred sync", async () => {
    const importedProfile = {
      ...createWalletState({ offairAmount: "0", reserveAmount: 0 }).profile!,
      walletId: "wallet-imported",
      displayName: "Imported Wallet",
      createdAt: now,
      backupConfirmedAt: now,
    };
    vi.mocked(importMnemonicWallet).mockResolvedValueOnce({
      mnemonic: "normalized mnemonic",
      profile: importedProfile,
      security: {
        ...createSecurity(),
        lastImportAt: now,
      },
    });

    const result = await importCustodyWalletState(createWalletShellState(), {
      mnemonic: "raw mnemonic",
      passphrase: "",
      displayName: "Imported Wallet",
    });

    expect(result.mnemonic).toBe("normalized mnemonic");
    expect(result.state.activeWalletId).toBe("wallet-imported");
    expect(result.state.profile).toMatchObject({
      walletId: "wallet-imported",
      displayName: "Imported Wallet",
      backupConfirmedAt: now,
    });
    expect(result.state.walletRegistry).toHaveLength(1);
    expect(result.state.walletRegistry[0]).toMatchObject({
      walletId: "wallet-imported",
      isActiveOnDevice: true,
    });
    expect(result.state.manifest).toMatchObject({
      activeWalletId: "wallet-imported",
      walletDisplayName: "Imported Wallet",
    });
    expect(result.state.statusLog).toEqual(
      expect.arrayContaining([
        expect.stringContaining("service.wallet.status.walletImported"),
        expect.stringContaining("service.wallet.status.walletImportedDeferred"),
      ]),
    );
    expect(result.state.statusLog.some((entry) => entry.includes("service.wallet.status.walletCreatedDeferred"))).toBe(
      false,
    );
  });

  it("keeps Solana Pay reference accounts when queued SOL intents are assembled online", async () => {
    const gatewayReference = "4KY1PdgYXNts1hPRV6KiUgqW87TVDi4G9gsAp7JbZW3i";
    const state = createWalletState({ offairAmount: "0", reserveAmount: 0 });
    vi.mocked(prepareSignedSolanaTransfer)
      .mockResolvedValueOnce({
        intent: {
          intentId: "intent-gateway",
          walletId: "wallet-sender",
          walletType: "global",
          assetId: "SOL",
          fromAddress: senderAddress,
          toAddress: receiverAddress,
          amount: "0.001",
          decimals: 9,
          createdAt: now,
          memo: "pay_gateway",
          reference: gatewayReference,
          requiresOnlineAssembly: true,
        },
        envelope: {
          intentId: "intent-gateway",
          publicKey: "sender-public-key",
          signedMessage: "signed-message",
          signature: "signature",
          signedAt: now,
        },
      } as any)
      .mockResolvedValueOnce({
        intent: {
          intentId: "intent-gateway",
          walletId: "wallet-sender",
          walletType: "global",
          assetId: "SOL",
          fromAddress: senderAddress,
          toAddress: receiverAddress,
          amount: "0.001",
          decimals: 9,
          createdAt: now,
          memo: "pay_gateway",
          reference: gatewayReference,
          recentBlockhash: "blockhash",
          requiresOnlineAssembly: false,
        },
        envelope: {
          intentId: "intent-gateway",
          publicKey: "sender-public-key",
          signedMessage: "signed-message-online",
          signature: "signature-online",
          signedAt: now,
          serializedTransaction: "serialized",
        },
      } as any);
    vi.mocked(submitPendingChainTransaction).mockResolvedValueOnce({
      status: "submitted",
      txSignature: "gateway-sol-signature",
      submittedAt: now,
    } as any);

    const queued = await queueChainTransferState(state, {
      assetId: "SOL",
      toAddress: receiverAddress,
      amount: "0.001",
      memo: "pay_gateway",
      reference: gatewayReference,
    });
    const submitted = await submitPendingChainTransactionsState(queued);

    expect(prepareSignedSolanaTransfer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        memo: "pay_gateway",
        reference: gatewayReference,
        recentBlockhash: "blockhash",
      }),
    );
    expect(submitPendingChainTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: expect.objectContaining({
          intent: expect.objectContaining({
            reference: gatewayReference,
          }),
        }),
      }),
    );
    expect(submitted.pendingChainTransactions[0]).toMatchObject({
      status: "submitted",
      txSignature: "gateway-sol-signature",
      intent: {
        reference: gatewayReference,
      },
    });
  });

  it("keeps Gateway SOL intents queued instead of failing when blockhash is unavailable", async () => {
    const gatewayReference = "4KY1PdgYXNts1hPRV6KiUgqW87TVDi4G9gsAp7JbZW3i";
    const state = createWalletState({ offairAmount: "0", reserveAmount: 0 });
    vi.mocked(fetchLatestBlockhash).mockResolvedValueOnce(undefined as any);
    vi.mocked(prepareSignedSolanaTransfer).mockResolvedValueOnce({
      intent: {
        intentId: "intent-gateway-offline",
        walletId: "wallet-sender",
        walletType: "global",
        assetId: "SOL",
        fromAddress: senderAddress,
        toAddress: receiverAddress,
        amount: "0.001",
        decimals: 9,
        createdAt: now,
        memo: "pay_gateway",
        reference: gatewayReference,
        requiresOnlineAssembly: true,
      },
      envelope: {
        intentId: "intent-gateway-offline",
        publicKey: "sender-public-key",
        signedMessage: "signed-message",
        signature: "signature",
        signedAt: now,
      },
    } as any);

    const queued = await queueChainTransferState(state, {
      assetId: "SOL",
      toAddress: receiverAddress,
      amount: "0.001",
      memo: "pay_gateway",
      reference: gatewayReference,
    });
    const submitted = await submitPendingChainTransactionsState(queued);

    expect(submitPendingChainTransaction).not.toHaveBeenCalled();
    expect(submitted.pendingChainTransactions[0]).toMatchObject({
      status: "queued",
      lastError: "service.chain.status.waitingOnlineAssembly",
      intent: {
        reference: gatewayReference,
      },
    });
  });

  it("settles directly on-chain when both devices are online", async () => {
    vi.mocked(probeRpcReachability).mockResolvedValueOnce(true);
    vi.mocked(prepareSignedSolanaTransfer).mockResolvedValueOnce({
      intent: { kind: "sol-transfer", amount: "0.01" },
      envelope: { signatures: ["sender-direct-signature"] },
    } as any);
    vi.mocked(submitPendingChainTransaction).mockResolvedValueOnce({
      status: "confirmed",
      txSignature: "direct-sol-signature-online",
      submittedAt: now,
      confirmedAt: now,
    } as any);

    const state = createWalletState({ offairAmount: "0", reserveAmount: 0 });

    const next = await sendOfflineTransfer(state, {
      amount: 0.01,
      peerAlias: "Receiver Wallet",
      allowTrustWarning: true,
      session: createSession({
        peerRpcReachable: true,
        peerInstantClaimCapable: true,
      }),
    });

    expect(next.journal).toHaveLength(1);
    expect(next.journal[0]).toMatchObject({
      amount: 0.01,
      assetId: "SOL",
      receiverAddress,
      claimStatus: "settled",
      settlementStatus: "reconciled",
      directSettlementSignature: "direct-sol-signature-online",
      sessionSettlementMode: "direct_sol",
    });
    expect(next.pendingChainTransactions[0]).toMatchObject({
      status: "confirmed",
      txSignature: "direct-sol-signature-online",
    });
    expect(mocks.transmittedTransfers).toHaveLength(1);
    expect(mocks.transmittedTransfers[0].sessionSettlementMode).toBe("direct_sol");
  });

  it("records both participant journals when both devices are online", async () => {
    vi.mocked(probeRpcReachability).mockResolvedValueOnce(true);
    vi.mocked(prepareSignedSolanaTransfer).mockResolvedValueOnce({
      intent: { kind: "sol-transfer", amount: "0.01" },
      envelope: { signatures: ["sender-direct-signature"] },
    } as any);
    vi.mocked(submitPendingChainTransaction).mockResolvedValueOnce({
      status: "confirmed",
      txSignature: "direct-sol-signature-online",
      submittedAt: now,
      confirmedAt: now,
    } as any);

    const senderState = createWalletState({ offairAmount: "0", reserveAmount: 0 });
    const receiverState = createWalletState({
      offairAmount: "0",
      reserveAmount: 0,
      solAmount: "0",
      role: "receiver",
    });

    const senderNext = await sendOfflineTransfer(senderState, {
      amount: 0.01,
      peerAlias: "Receiver Wallet",
      allowTrustWarning: true,
      session: createSession({
        peerRpcReachable: true,
        peerInstantClaimCapable: true,
      }),
    });
    const receiverNext = await recordIncomingTransfer(receiverState, senderNext.journal[0], [
      "receiver accepted direct SOL settlement while online",
    ]);

    expect(senderNext.journal[0]).toMatchObject({
      assetId: "SOL",
      sessionSettlementMode: "direct_sol",
      claimStatus: "settled",
      settlementStatus: "reconciled",
      directSettlementSignature: "direct-sol-signature-online",
    });
    expect(receiverNext.journal).toHaveLength(1);
    expect(receiverNext.journal[0]).toMatchObject({
      localTxId: senderNext.journal[0].localTxId,
      senderAddress,
      receiverAddress,
      assetId: "SOL",
      sessionSettlementMode: "direct_sol",
      claimStatus: "settled",
      settlementStatus: "reconciled",
      directSettlementSignature: "direct-sol-signature-online",
      receipt: {
        receiptId: "receipt-simulated",
        transferId: senderNext.journal[0].localTxId,
      },
    });
  });

  it("settles directly on-chain when only the sender has network", async () => {
    vi.mocked(probeRpcReachability).mockResolvedValueOnce(true);
    vi.mocked(prepareSignedSolanaTransfer).mockResolvedValueOnce({
      intent: { kind: "sol-transfer", amount: "0.01" },
      envelope: { signatures: ["sender-direct-signature"] },
    } as any);
    vi.mocked(submitPendingChainTransaction).mockResolvedValueOnce({
      status: "confirmed",
      txSignature: "direct-sol-signature",
      submittedAt: now,
      confirmedAt: now,
    } as any);

    const state = createWalletState({ offairAmount: "0", reserveAmount: 0 });

    const next = await sendOfflineTransfer(state, {
      amount: 0.01,
      peerAlias: "Receiver Wallet",
      allowTrustWarning: true,
      session: createSession({
        peerRpcReachable: false,
        peerInstantClaimCapable: false,
      }),
    });

    expect(next.journal).toHaveLength(1);
    expect(next.journal[0]).toMatchObject({
      amount: 0.01,
      assetId: "SOL",
      receiverAddress,
      claimStatus: "settled",
      settlementStatus: "reconciled",
      directSettlementSignature: "direct-sol-signature",
      sessionSettlementMode: "direct_sol",
    });
    expect(next.reserve.remainingAmount).toBe(0);
    expect(next.balances.OFFAIR.amount).toBe("0");
    expect(next.pendingChainTransactions[0]).toMatchObject({
      status: "confirmed",
      txSignature: "direct-sol-signature",
    });
    expect(mocks.transmittedTransfers).toHaveLength(1);
    expect(mocks.transmittedTransfers[0].assetId).toBe("SOL");
  });

  it("records both participant journals when only the sender has network", async () => {
    vi.mocked(probeRpcReachability).mockResolvedValueOnce(true);
    vi.mocked(prepareSignedSolanaTransfer).mockResolvedValueOnce({
      intent: { kind: "sol-transfer", amount: "0.01" },
      envelope: { signatures: ["sender-direct-signature"] },
    } as any);
    vi.mocked(submitPendingChainTransaction).mockResolvedValueOnce({
      status: "confirmed",
      txSignature: "direct-sol-signature",
      submittedAt: now,
      confirmedAt: now,
    } as any);

    const senderState = createWalletState({ offairAmount: "0", reserveAmount: 0 });
    const receiverState = createWalletState({
      offairAmount: "0",
      reserveAmount: 0,
      solAmount: "0",
      role: "receiver",
    });

    const senderNext = await sendOfflineTransfer(senderState, {
      amount: 0.01,
      peerAlias: "Receiver Wallet",
      allowTrustWarning: true,
      session: createSession({
        peerRpcReachable: false,
        peerInstantClaimCapable: false,
      }),
    });
    const receiverNext = await recordIncomingTransfer(receiverState, senderNext.journal[0], [
      "receiver accepted direct SOL settlement while offline",
    ]);

    expect(senderNext.journal[0]).toMatchObject({
      assetId: "SOL",
      sessionSettlementMode: "direct_sol",
      directSettlementSignature: "direct-sol-signature",
      settlementStatus: "reconciled",
    });
    expect(receiverNext.journal[0]).toMatchObject({
      localTxId: senderNext.journal[0].localTxId,
      assetId: "SOL",
      sessionSettlementMode: "direct_sol",
      directSettlementSignature: "direct-sol-signature",
      settlementStatus: "reconciled",
      receipt: {
        receiptId: "receipt-simulated",
        transferId: senderNext.journal[0].localTxId,
      },
    });
  });

  it("negotiates instant claim when only the receiver has network", async () => {
    vi.mocked(probeRpcReachability).mockResolvedValueOnce(false);
    const state = createWalletState({ offairAmount: "0", reserveAmount: 0 });

    const next = await sendOfflineTransfer(state, {
      amount: 0.01,
      peerAlias: "Receiver Wallet",
      allowTrustWarning: true,
      session: createSession({
        peerRpcReachable: true,
        peerInstantClaimCapable: true,
      }),
    });

    expect(next.journal).toHaveLength(1);
    expect(next.journal[0]).toMatchObject({
      amount: 0.01,
      assetId: "OFFAIR",
      receiverAddress,
      sessionSettlementMode: "instant_claim",
    });
    expect(next.reserve.remainingAmount).toBe(0);
    expect(next.balances.OFFAIR.amount).toBe("0");
    expect(mocks.transmittedTransfers).toHaveLength(1);
    expect(mocks.transmittedTransfers[0].sessionSettlementMode).toBe("instant_claim");
    expect(mocks.transmittedTransfers[0].signatureBundle.payloadHash).toBeTruthy();
    expect(mocks.transmittedTransfers[0].signatureBundle.payloadHash).not.toBe(mocks.transmittedTransfers[0].txHash);
    expect(mocks.transmittedTransfers[0].signatureBundle.signatures.map((entry: any) => entry.role)).toEqual([
      "device",
      "wallet",
    ]);
  });

  it("records settled sender and receiver journals when only the receiver has network", async () => {
    vi.mocked(probeRpcReachability).mockResolvedValueOnce(false);
    mocks.nextReceiptOverrides = {
      sessionSettlementMode: "instant_claim",
      claimStatus: "settled",
      claimTxSignature: "instant-claim-signature",
      settleTxSignature: "instant-settle-signature",
    };
    const senderState = createWalletState({ offairAmount: "0", reserveAmount: 0 });
    const receiverState = createWalletState({
      offairAmount: "0",
      reserveAmount: 0,
      solAmount: "0",
      role: "receiver",
    });

    const senderNext = await sendOfflineTransfer(senderState, {
      amount: 0.01,
      peerAlias: "Receiver Wallet",
      allowTrustWarning: true,
      session: createSession({
        peerRpcReachable: true,
        peerInstantClaimCapable: true,
      }),
    });
    const receiverNext = await recordIncomingTransfer(receiverState, senderNext.journal[0], [
      "receiver claimed and settled the promise online",
    ]);

    expect(senderNext.journal[0]).toMatchObject({
      assetId: "OFFAIR",
      sessionSettlementMode: "instant_claim",
      claimStatus: "settled",
      settlementStatus: "reconciled",
      instantClaimSignature: "instant-claim-signature",
      instantSettleSignature: "instant-settle-signature",
    });
    expect(receiverNext.journal[0]).toMatchObject({
      localTxId: senderNext.journal[0].localTxId,
      senderAddress,
      receiverAddress,
      sessionSettlementMode: "instant_claim",
      claimStatus: "settled",
      settlementStatus: "reconciled",
      instantClaimSignature: "instant-claim-signature",
      instantSettleSignature: "instant-settle-signature",
      receipt: {
        receiptId: "receipt-simulated",
        transferId: senderNext.journal[0].localTxId,
      },
    });
  });

  it("seals and transports a decimal offline promise when both devices are offline and sender capacity exists", async () => {
    vi.mocked(probeRpcReachability).mockResolvedValueOnce(false);
    const state = createWalletState({ offairAmount: "5", reserveAmount: 5 });

    const next = await sendOfflineTransfer(state, {
      amount: 1.25,
      peerAlias: "Receiver Wallet",
      allowTrustWarning: true,
      session: createSession(),
    });

    expect(next.journal).toHaveLength(1);
    expect(next.journal[0]).toMatchObject({
      amount: 1.25,
      assetId: "OFFAIR",
      receiverAddress,
      receipt: {
        receiptId: "receipt-simulated",
      },
      sessionSettlementMode: "offline_promise",
    });
    expect(next.reserve.remainingAmount).toBe(3.75);
    expect(next.reserve.remainingTransfers).toBe(4);
    expect(next.balances.OFFAIR.amount).toBe("3.75");
    expect(mocks.transmittedTransfers).toHaveLength(1);
    expect(mocks.transmittedTransfers[0].signatureBundle.signatures.map((entry: any) => entry.role)).toEqual([
      "device",
      "wallet",
    ]);
  });

  it("seals a limited local offline promise from cached SOL when both devices are offline", async () => {
    vi.mocked(probeRpcReachability).mockResolvedValueOnce(false);
    const state = createWalletState({ offairAmount: "0", reserveAmount: 0, solAmount: "0.5" });

    expect(getOfflinePromiseCapacity(state)).toMatchObject({
      maxAmount: 0.05,
      offairAmount: 0,
      reserveAmount: 0,
      localPromiseAmount: 0.05,
      source: "local",
    });

    const next = await sendOfflineTransfer(state, {
      amount: 0.02,
      peerAlias: "Receiver Wallet",
      allowTrustWarning: true,
      session: createSession(),
    });

    expect(next.journal).toHaveLength(1);
    expect(next.journal[0]).toMatchObject({
      amount: 0.02,
      assetId: "OFFAIR",
      receiverAddress,
      receipt: {
        receiptId: "receipt-simulated",
      },
      sessionSettlementMode: "offline_promise",
    });
    expect(next.reserve.remainingAmount).toBe(0);
    expect(next.balances.OFFAIR.amount).toBe("0");
    expect(mocks.transmittedTransfers[0].sessionSettlementMode).toBe("offline_promise");
  });

  it("records the receiver side of a fully offline promise with the local receipt intact", async () => {
    vi.mocked(probeRpcReachability).mockResolvedValueOnce(false);
    const senderState = createWalletState({ offairAmount: "0", reserveAmount: 0, solAmount: "0.5" });
    const receiverState = createWalletState({
      offairAmount: "0",
      reserveAmount: 0,
      solAmount: "0",
      role: "receiver",
    });

    const senderNext = await sendOfflineTransfer(senderState, {
      amount: 0.02,
      peerAlias: "Receiver Wallet",
      allowTrustWarning: true,
      session: createSession(),
    });
    const outgoingTransfer = senderNext.journal[0];

    const receiverNext = await recordIncomingTransfer(receiverState, outgoingTransfer, [
      "receiver accepted simulated offline receipt",
    ]);

    expect(receiverNext.journal).toHaveLength(1);
    expect(receiverNext.journal[0]).toMatchObject({
      localTxId: outgoingTransfer.localTxId,
      senderAddress,
      receiverAddress,
      sessionSettlementMode: "offline_promise",
      receipt: {
        receiptId: "receipt-simulated",
        transferId: outgoingTransfer.localTxId,
      },
    });
  });

  it("uses verified offline local capacity when lineage forces verified-only settlement", async () => {
    vi.mocked(probeRpcReachability).mockResolvedValueOnce(false);
    const baseState = createWalletState({ offairAmount: "0", reserveAmount: 0, solAmount: "0.5" });
    const state = {
      ...baseState,
      manifest: baseState.manifest
        ? {
            ...baseState.manifest,
            reputationEnvelope: {
              trustCeiling: 0,
              riskFloor: 95,
              cooldownUntil: null,
              lineageGeneration: 2,
              resetCount: 1,
              unresolvedExposure: 0,
              mode: "verified_only" as const,
              updatedAt: now,
              reasons: ["test lineage requires verified-only"],
            },
          }
        : null,
    };

    expect(getOfflinePromiseCapacity(state)).toMatchObject({
      maxAmount: 0.05,
      source: "local",
    });

    const next = await sendOfflineTransfer(state, {
      amount: 0.02,
      peerAlias: "Receiver Wallet",
      allowTrustWarning: true,
      session: createSession(),
      sessionSettlementMode: "offline_promise",
    });

    expect(next.journal[0]).toMatchObject({
      amount: 0.02,
      assetId: "OFFAIR",
      offlineSettlementTier: "verified_offline",
      receiptMaterializationRequired: true,
      sessionSettlementMode: "offline_promise",
    });
    expect(mocks.transmittedTransfers[0]).toMatchObject({
      offlineSettlementTier: "verified_offline",
      receiptMaterializationRequired: true,
    });
  });

  it("blocks local offline promises above the MVP cached-SOL limit", async () => {
    const state = createWalletState({ offairAmount: "0", reserveAmount: 0, solAmount: "0.5" });

    await expect(
      sendOfflineTransfer(state, {
        amount: 0.06,
        peerAlias: "Receiver Wallet",
        allowTrustWarning: true,
        session: createSession(),
        sessionSettlementMode: "offline_promise",
      }),
    ).rejects.toThrow("service.wallet.error.offairCapExceeded");
    expect(mocks.transmittedTransfers).toHaveLength(0);
  });

  it("blocks the offline promise before transport when both reserve and cached SOL capacity are missing", async () => {
    const state = createWalletState({ offairAmount: "0", reserveAmount: 0, solAmount: "0" });

    expect(getOfflinePromiseCapacity(state)).toMatchObject({
      maxAmount: 0,
      offairAmount: 0,
      reserveAmount: 0,
      localPromiseAmount: 0,
      source: "none",
    });

    await expect(
      sendOfflineTransfer(state, {
        amount: 0.05,
        peerAlias: "Receiver Wallet",
        allowTrustWarning: true,
        session: createSession(),
        sessionSettlementMode: "offline_promise",
      }),
    ).rejects.toThrow("service.wallet.error.offairCapExceeded");
    expect(mocks.transmittedTransfers).toHaveLength(0);
  });
});
