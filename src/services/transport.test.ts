import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "buffer";

const mocks = vi.hoisted(() => {
  const transportIds = {
    serviceUuid: "8d4f0c60-f0f5-4388-a48d-d6e8cb1260fe",
    handshakeCharacteristicUuid: "8d4f0c61-f0f5-4388-a48d-d6e8cb1260fe",
    transferCharacteristicUuid: "8d4f0c62-f0f5-4388-a48d-d6e8cb1260fe",
    receiptCharacteristicUuid: "8d4f0c63-f0f5-4388-a48d-d6e8cb1260fe",
    closeCharacteristicUuid: "8d4f0c64-f0f5-4388-a48d-d6e8cb1260fe",
  };
  const device: Record<string, any> = {
    id: "ble-device-1",
    name: "AirPay Receiver",
    localName: null,
    serviceUUIDs: [transportIds.serviceUuid],
  };

  return {
    transportIds,
    scanCallback: null as ((error: unknown, device?: Record<string, any>) => void) | null,
    monitorCallbacks: [] as Array<(error: unknown, characteristic?: { value?: string }) => void>,
    subscriptions: [] as Array<{ remove: ReturnType<typeof vi.fn> }>,
    bleManager: {
      state: vi.fn(async () => "PoweredOn"),
      enable: vi.fn(async () => undefined),
      disable: vi.fn(async () => undefined),
      onStateChange: vi.fn(() => ({ remove: vi.fn() })),
      startDeviceScan: vi.fn((_uuids, _options, callback) => {
        mocks.scanCallback = callback;
      }),
      stopDeviceScan: vi.fn(),
    },
    device,
  };
});

vi.mock("react-native-ble-plx", () => ({
  State: {
    PoweredOn: "PoweredOn",
    PoweredOff: "PoweredOff",
    Unauthorized: "Unauthorized",
    Unsupported: "Unsupported",
  },
  BleManager: vi.fn(() => mocks.bleManager),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  PermissionsAndroid: {
    PERMISSIONS: {
      BLUETOOTH_SCAN: "android.permission.BLUETOOTH_SCAN",
      BLUETOOTH_CONNECT: "android.permission.BLUETOOTH_CONNECT",
      BLUETOOTH_ADVERTISE: "android.permission.BLUETOOTH_ADVERTISE",
      ACCESS_FINE_LOCATION: "android.permission.ACCESS_FINE_LOCATION",
    },
    RESULTS: { GRANTED: "granted" },
    requestMultiple: vi.fn(async () => ({
      "android.permission.BLUETOOTH_SCAN": "granted",
      "android.permission.BLUETOOTH_CONNECT": "granted",
      "android.permission.BLUETOOTH_ADVERTISE": "granted",
      "android.permission.ACCESS_FINE_LOCATION": "granted",
    })),
  },
}));

vi.mock("react-native-nfc-manager", () => ({
  default: {
    cancelTechnologyRequest: vi.fn(async () => undefined),
    getTag: vi.fn(),
    isSupported: vi.fn(async () => false),
    requestTechnology: vi.fn(),
    start: vi.fn(async () => undefined),
    isoDepHandler: {
      transceive: vi.fn(),
    },
  },
  Ndef: {
    decodeMessage: vi.fn(() => []),
    text: {
      decodePayload: vi.fn(() => ""),
    },
  },
  NfcTech: {
    IsoDep: "IsoDep",
    Ndef: "Ndef",
  },
}));

vi.mock("../i18n", () => ({
  translate: (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock("./chain", () => ({
  probeRpcReachability: vi.fn(async () => false),
}));

vi.mock("./custody", () => ({
  createWalletPromiseSignatures: vi.fn(async ({ message, walletId }: { message: string; walletId?: string }) => ({
    walletId: walletId ?? "wallet-receiver",
    profile: {},
    signatures: [
      {
        role: "pq",
        algorithm: "ml-dsa-65",
        signature: "pq-receipt-signature",
        publicKey: "receiver-pq-public-key",
        keyId: `pq:${walletId ?? "wallet-receiver"}`,
      },
      {
        role: "wallet",
        algorithm: "ed25519",
        signature: `wallet-receipt-signature:${message.length}`,
        publicKey: "receiver-wallet-public-key",
        keyId: `wallet:${walletId ?? "wallet-receiver"}`,
      },
      {
        role: "identity",
        algorithm: "ed25519",
        signature: "identity-receipt-signature",
        publicKey: "receiver-identity-public-key",
        keyId: `identity:${walletId ?? "wallet-receiver"}`,
      },
    ],
  })),
}));

vi.mock("./diagnostics", () => ({
  recordDiagnostic: vi.fn(async () => undefined),
  recordDiagnosticError: vi.fn(async () => undefined),
}));

vi.mock("./integrity", () => ({
  getDefaultTransportIds: vi.fn(() => mocks.transportIds),
}));

vi.mock("./native/AirPayNative", () => ({
  AirPayNativeEvents: {
    receiverReady: "AirPayReceiverReady",
    receiverConnected: "AirPayReceiverConnected",
    receiverDisconnected: "AirPayReceiverDisconnected",
    handshakeReceived: "AirPayHandshakeReceived",
    transferReceived: "AirPayTransferReceived",
    sessionClosed: "AirPaySessionClosed",
    nativeError: "AirPayNativeError",
  },
  getNativeEventEmitter: vi.fn(() => ({
    addListener: vi.fn(() => ({ remove: vi.fn() })),
  })),
  getSupportedCapabilities: vi.fn(async () => ({
    nfc: false,
    bleCentral: true,
    blePeripheral: true,
    attestation: true,
    hce: false,
    platform: "android",
  })),
  prepareReceiverSession: vi.fn(),
  publishReceipt: vi.fn(),
  signPayload: vi.fn(async () => "device-signature"),
  stopReceiverSession: vi.fn(),
}));

vi.mock("./transportSecurity", () => ({
  decryptPeerPayload: vi.fn(),
  encryptForPeerPayload: vi.fn(),
  getLocalTransportPublicKey: vi.fn(async () => "local-transport-public-key"),
  isSecureTransportEnvelope: vi.fn(() => false),
}));

vi.mock("./trust", () => ({
  buildSelectiveGossipEnvelope: vi.fn(() => ({ reputations: [], blacklist: [], checkpoints: [] })),
  ingestGossipEnvelope: vi.fn((state) => state),
  loadLocalTrustState: vi.fn(async () => ({ peers: {}, blacklistDigests: {}, checkpoints: [] })),
  mutateLocalTrustState: vi.fn(async (mutator: (state: any) => any) =>
    mutator({ peers: {}, blacklistDigests: {}, checkpoints: [] }),
  ),
  recordPeerInteraction: vi.fn((state) => state),
}));

import { acknowledgeTransfer, startNearbyReceiverDiscovery } from "./transport";

function createManifest() {
  return {
    deviceId: "sender-device",
    appVersion: "0.3.1",
    epoch: 1,
    stateRoot: "sender-state-root",
    policyHash: "policy-hash",
    integrityLevel: "tee",
    attestationValid: true,
    lastOnlineAt: "2026-05-09T09:00:00.000Z",
    capabilities: ["ble", "attestation"],
    publicKey: "sender-public-key",
    solanaAddress: "FWHXfFtG9YE1m6rGYbcLoZJ4xJ4KAVng6E5HURy1w8ZV",
    activeWalletId: "wallet-sender",
    walletType: "global",
    walletDisplayName: "Sender Wallet",
    transportCapabilities: {
      nfc: false,
      bleCentral: true,
      blePeripheral: true,
      attestation: true,
      hce: false,
    },
    bleServiceId: mocks.transportIds.serviceUuid,
  } as any;
}

function createBootstrapPayload() {
  return JSON.stringify({
    protocolVersion: 1,
    serviceUuid: mocks.transportIds.serviceUuid,
    transportPublicKey: "receiver-transport-public-key",
    envelope: {
      sessionId: "session-retry",
      manifest: {
        deviceId: "receiver-device",
        stateRoot: "receiver-state-root",
        lastOnlineAt: "2026-05-09T09:00:00.000Z",
        walletAddress: "AHZST1y4zBSRSGPqTqV35Ljk62UjSiMyBs1QtQvX6i1U",
        walletId: "wallet-receiver",
        walletDisplayName: "Receiver Wallet",
        rpcReachable: false,
        instantClaimCapable: false,
      },
      baseRoot: "receiver-base-root",
      nonce: "receiver-nonce",
      counter: 1,
      signature: "receiver-signature",
    },
  });
}

function encodeUtf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function buildBleFrames(sessionId: string, payload: string) {
  const encodedPayload = encodeUtf8(payload);
  const chunkSize = 120;
  const totalChunks = Math.max(1, Math.ceil(encodedPayload.length / chunkSize));

  return Array.from({ length: totalChunks }, (_, chunkIndex) =>
    encodeUtf8(
      JSON.stringify({
        sessionId,
        chunkIndex,
        totalChunks,
        chunk: encodedPayload.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize),
      }),
    ),
  );
}

async function settlePromises(times = 8) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe("transport BLE bootstrap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.scanCallback = null;
    mocks.monitorCallbacks.length = 0;
    mocks.subscriptions.length = 0;
    vi.clearAllMocks();

    mocks.device.isConnected = vi.fn(async () => false);
    mocks.device.connect = vi.fn(async () => mocks.device);
    mocks.device.requestMTU = vi.fn(async () => mocks.device);
    mocks.device.discoverAllServicesAndCharacteristics = vi.fn(async () => mocks.device);
    mocks.device.cancelConnection = vi.fn(async () => undefined);
    mocks.device.readCharacteristicForService = vi.fn(async () => ({
      value: encodeUtf8(createBootstrapPayload()),
    }));
    mocks.device.monitorCharacteristicForService = vi.fn((_serviceUuid, _characteristicUuid, callback) => {
      mocks.monitorCallbacks.push(callback);
      const subscription = { remove: vi.fn() };
      mocks.subscriptions.push(subscription);
      return subscription;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries the BLE bootstrap notification stream before direct-read fallback", async () => {
    const discovery = await startNearbyReceiverDiscovery({ manifest: createManifest() });

    mocks.scanCallback?.(null, mocks.device);
    const rawCandidate = discovery.getSnapshot().receivers[0];
    expect(rawCandidate).toMatchObject({
      candidateId: "ble:ble-device-1",
      preferred: true,
      resolved: false,
    });

    const resolvedPromise = discovery.resolveCandidate(rawCandidate.candidateId);
    await settlePromises();

    expect(mocks.device.monitorCharacteristicForService).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12000);
    await vi.advanceTimersByTimeAsync(250);
    await settlePromises();

    expect(mocks.device.monitorCharacteristicForService).toHaveBeenCalledTimes(2);
    buildBleFrames("session-retry", createBootstrapPayload()).forEach((frame) => {
      mocks.monitorCallbacks[1]?.(null, { value: frame });
    });

    const resolved = await resolvedPromise;
    expect(resolved).toMatchObject({
      resolved: true,
      displayName: "Receiver Wallet",
      walletAddress: "AHZST1y4zBSRSGPqTqV35Ljk62UjSiMyBs1QtQvX6i1U",
      walletId: "wallet-receiver",
    });
    expect(mocks.device.readCharacteristicForService).not.toHaveBeenCalled();
    expect(mocks.subscriptions[0]?.remove).toHaveBeenCalled();
    expect(mocks.subscriptions[1]?.remove).toHaveBeenCalled();

    const stopPromise = discovery.stop();
    await vi.advanceTimersByTimeAsync(120);
    await stopPromise;
  });

  it("does not expose generic BLE peripherals as selectable receiver candidates", async () => {
    const discovery = await startNearbyReceiverDiscovery({ manifest: createManifest() });

    mocks.scanCallback?.(null, {
      id: "generic-device",
      name: null,
      localName: null,
      serviceUUIDs: [],
    });
    expect(discovery.getSnapshot().receivers).toEqual([]);

    mocks.scanCallback?.(null, mocks.device);
    expect(discovery.getSnapshot().receivers[0]).toMatchObject({
      candidateId: "ble:ble-device-1",
      preferred: true,
      resolved: false,
    });

    const stopPromise = discovery.stop();
    await vi.advanceTimersByTimeAsync(120);
    await stopPromise;
  });
});

describe("transport receiver receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds the acknowledgement to the receiver wallet signature bundle", async () => {
    const transfer = {
      localTxId: "localtx-1",
      promiseId: "promise-1",
      sessionId: "session-1",
      senderPseudoId: "sender-device",
      receiverPseudoId: "receiver-device",
      senderAddress: "sender-address",
      receiverAddress: "receiver-address",
      walletId: "wallet-sender",
      walletType: "global",
      assetId: "OFFAIR",
      amount: 1,
      voucherIds: [],
      prevTxHash: "GENESIS",
      counter: 1,
      epoch: 1,
      policyHash: "policy-hash",
      peerProofDigest: "peer-proof",
      createdAt: "2026-05-13T12:00:00.000Z",
      encryptedPayload: "encrypted-payload",
      settlementStatus: "pending",
      sessionSettlementMode: "offline_promise",
      risk: {
        score: 0.1,
        band: "low",
        reasons: ["test"],
        computedAt: "2026-05-13T12:00:00.000Z",
      },
      signingAlgorithms: [],
      txHash: "sender-transfer-hash",
    } as any;

    const acknowledged = await acknowledgeTransfer(transfer, {
      walletId: "wallet-receiver",
      sessionSettlementMode: "offline_promise",
      claimStatus: "pending",
    });

    expect(acknowledged.receipt).toMatchObject({
      transferId: "localtx-1",
      walletId: "wallet-receiver",
      sessionSettlementMode: "offline_promise",
      claimStatus: "pending",
    });
    expect(acknowledged.receipt?.signatureBundle).toMatchObject({
      payloadVersion: 1,
      payloadHash: "sender-transfer-hash",
    });
    expect(acknowledged.receipt?.signatureBundle?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(acknowledged.receipt?.signatureBundle?.signatures.map((signature) => signature.role)).toEqual([
      "pq",
      "wallet",
      "identity",
    ]);
    expect(acknowledged.txHash).not.toBe(transfer.txHash);
  });
});
