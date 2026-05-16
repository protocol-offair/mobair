import { BleManager, Device, State } from "react-native-ble-plx";
import NfcManager, { Ndef, NfcTech } from "react-native-nfc-manager";
import { PermissionsAndroid, Platform } from "react-native";

import {
  appendReceipt,
  buildHandshakeEnvelope,
  buildReceiptSigningPayload,
  canonicalStringify,
  createNonce,
  RECEIVER_PAYS_OFFLINE_SETTLEMENT_FEES,
  sha256Hex,
} from "@airpay/shared";
import type {
  DeviceManifest,
  HandshakeEnvelope,
  OfflineTransfer,
  PeerProofDigest,
  PromiseSignatureBundle,
  TransferReceipt,
} from "@airpay/shared";

import {
  AirPayNativeEvents,
  getSupportedCapabilities,
  getNativeEventEmitter,
  prepareReceiverSession as prepareNativeReceiverSession,
  publishReceipt as publishNativeReceipt,
  signPayload,
  stopReceiverSession as stopNativeReceiverSession,
  type NativeTransportIds,
} from "./native/AirPayNative";
import { decodeUtf8, encodeUtf8 } from "./native/base64";
import { probeRpcReachability } from "./chain";
import { getDefaultTransportIds } from "./integrity";
import { recordDiagnostic, recordDiagnosticError } from "./diagnostics";
import { decryptPeerPayload, encryptForPeerPayload, getLocalTransportPublicKey, isSecureTransportEnvelope } from "./transportSecurity";
import { createWalletPromiseSignatures } from "./custody";
import {
  buildSelectiveGossipEnvelope,
  ingestGossipEnvelope,
  loadLocalTrustState,
  mutateLocalTrustState,
  recordPeerInteraction,
  type GossipEnvelope,
} from "./trust";
import { translate } from "../i18n";

const bleManager = new BleManager();
interface SecureHandshakeEnvelope extends HandshakeEnvelope {
  gossip?: GossipEnvelope;
}

const handshakeCache = new Map<string, SecureHandshakeEnvelope>();
let nfcStarted = false;
let nfcOperationQueue: Promise<void> = Promise.resolve();

const BLUETOOTH_PERMISSIONS = [
  PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
  PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
  PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
  PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
];

export interface TransportSession {
  sessionId: string;
  mode: "nfc" | "ble" | "demo";
  diagnostics: string[];
  peerProofDigest: PeerProofDigest;
  peerWalletAddress?: string;
  peerWalletId?: string;
  peerDisplayName?: string;
  peerRpcReachable?: boolean;
  peerInstantClaimCapable?: boolean;
  peerTransportPublicKey: string;
  promotedToBle: boolean;
}

export type NfcDiscoveryStatus = "idle" | "scanning" | "matched" | "timed_out" | "unsupported" | "error";

export interface NearbyReceiverCandidate {
  candidateId: string;
  mode: "nfc" | "ble";
  displayName?: string;
  deviceName?: string;
  deviceId?: string;
  walletAddress?: string;
  walletId?: string;
  rpcReachable?: boolean;
  instantClaimCapable?: boolean;
  lastSeenAt: string;
  resolved: boolean;
  preferred: boolean;
}

export interface NearbyReceiverDiscoverySnapshot {
  receivers: NearbyReceiverCandidate[];
  bleActive: boolean;
  nfcStatus: NfcDiscoveryStatus;
}

export type ActiveTransportSession = TransportSession & {
  transportIds: NativeTransportIds;
  device: Device;
  bleLease: BlePowerLease;
};

export interface NearbyReceiverDiscoveryHandle {
  subscribe(listener: (snapshot: NearbyReceiverDiscoverySnapshot) => void): () => void;
  getSnapshot(): NearbyReceiverDiscoverySnapshot;
  resolveCandidate(candidateId: string): Promise<NearbyReceiverCandidate>;
  retryNfc(): Promise<void>;
  createSession(input: {
    manifest: DeviceManifest;
    baseRoot: string;
    counter: number;
    candidateId: string;
  }): Promise<ActiveTransportSession>;
  stop(): Promise<void>;
}

export interface ReceiverPreparation {
  sessionId: string;
  diagnostics: string[];
  bootstrapPayload: string;
}

export interface ReceiverLifecycleEvent {
  type: "ready" | "connected" | "disconnected" | "closed" | "error";
  sessionId?: string;
  message: string;
}

export interface IncomingTransferEvent {
  sessionId: string;
  transfer: OfflineTransfer;
  handshake?: HandshakeEnvelope;
}

interface BootstrapManifest {
  deviceId: string;
  stateRoot: string;
  lastOnlineAt: string;
  walletAddress?: string;
  walletId?: string;
  walletDisplayName?: string;
  rpcReachable?: boolean;
  instantClaimCapable?: boolean;
}

interface BootstrapEnvelope {
  sessionId: string;
  manifest: BootstrapManifest;
  baseRoot: string;
  nonce: string;
  counter: number;
  signature: string;
}

interface BootstrapPayload {
  protocolVersion: 1;
  serviceUuid?: string;
  transportPublicKey: string;
  envelope: BootstrapEnvelope;
  gossip?: GossipEnvelope;
}

interface BootstrapReadResult {
  bootstrap: BootstrapPayload;
  diagnostics: string[];
  mode: "nfc" | "ble";
  promotedToBle: boolean;
  device?: Device;
}

interface BleChunkFrame {
  sessionId: string;
  chunkIndex: number;
  totalChunks: number;
  chunk: string;
}

interface ReceiverSessionSecurityContext {
  peerTransportPublicKey?: string;
}

interface NearbyReceiverCandidateRecord extends NearbyReceiverCandidate {
  bootstrap?: BootstrapPayload;
  device?: Device;
}

interface BlePowerLease {
  purpose: "scan" | "advertise";
  originalState: State;
  enabledByApp: boolean;
  restored: boolean;
}

const NDEF_APP_SELECT_APDU = hexToBytes("00A4040007D276000085010100");
const CAPABILITY_CONTAINER_SELECT_APDU = hexToBytes("00A4000C02E103");
const NDEF_FILE_SELECT_APDU = hexToBytes("00A4000C02E104");
const APDU_SUCCESS_SW1 = 0x90;
const APDU_SUCCESS_SW2 = 0x00;
const APDU_READ_CHUNK_SIZE = 0xf0;
const NFC_BOOTSTRAP_TIMEOUT_MS = 8000;
const BLE_STATE_TIMEOUT_MS = 8000;
const BLE_RECEIPT_STREAM_TIMEOUT_MS = 30000;
const BLE_RECEIPT_RETRY_TIMEOUT_MS = 15000;
const BLE_RECEIPT_POLL_TIMEOUT_MS = 20000;
const BLE_DISCOVERY_SCAN_TIMEOUT_MS = 30000;
const BLE_DISCOVERY_LOOSE_RECEIVER_DELAY_MS = 4000;
const BLE_CONNECT_TIMEOUT_MS = 25000;
const BLE_BOOTSTRAP_STREAM_TIMEOUT_MS = 12000;
const BLE_BOOTSTRAP_RETRY_TIMEOUT_MS = 8000;
const P2P_HANDSHAKE_CONTEXT = "airpay.p2p.handshake";
const P2P_TRANSFER_CONTEXT = "airpay.p2p.transfer";
const P2P_RECEIPT_CONTEXT = "airpay.p2p.receipt";
const NFC_DISCOVERY_TIMEOUT_MESSAGE = "Timed out waiting for an NFC receiver tap.";
const receiverSecurityContexts = new Map<string, ReceiverSessionSecurityContext>();
let activeReceiverBleLease: BlePowerLease | null = null;

function summarizeGossipEnvelope(gossip?: GossipEnvelope) {
  if (!gossip) {
    return null;
  }

  return {
    reputations: gossip.reputations.length,
    blacklist: gossip.blacklist.length,
    checkpoints: gossip.checkpoints.length,
  };
}

function buildBleCandidateId(deviceId: string) {
  return `ble:${deviceId}`;
}

function findExistingCandidateIdForDevice(
  candidates: Map<string, NearbyReceiverCandidateRecord>,
  device: Device,
) {
  for (const [candidateId, candidate] of candidates.entries()) {
    if (candidate.device?.id === device.id || candidate.deviceId === device.id) {
      return candidateId;
    }
  }
  return null;
}

function buildResolvedCandidateId(input: {
  walletAddress?: string;
  deviceId?: string;
  sessionId?: string;
}) {
  return `peer:${input.walletAddress ?? input.deviceId ?? input.sessionId ?? createNonce("peer")}`;
}

function sortNearbyReceiverCandidates(left: NearbyReceiverCandidate, right: NearbyReceiverCandidate) {
  if (left.preferred !== right.preferred) {
    return left.preferred ? -1 : 1;
  }
  if (left.resolved !== right.resolved) {
    return left.resolved ? -1 : 1;
  }
  return right.lastSeenAt.localeCompare(left.lastSeenAt);
}

function hasStrongBleReceiverSignal(device: Device, serviceUuid: string) {
  const expectedServiceUuid = serviceUuid.toLowerCase();
  const advertisedServices = (device.serviceUUIDs ?? []).map((uuid) => uuid.toLowerCase());
  const label = getBleDeviceLabel(device);
  const serviceDataLabel = getBleServiceDataLabel(device, expectedServiceUuid);
  return (
    advertisedServices.includes(expectedServiceUuid) ||
    Boolean(label?.startsWith("AirPay")) ||
    Boolean(serviceDataLabel?.startsWith("AirPay"))
  );
}

function getBleDeviceLabel(device: Device) {
  return device.name?.trim() || device.localName?.trim();
}

function getBleServiceDataLabel(device: Device, serviceUuid: string) {
  const serviceData = (device as Device & { serviceData?: Record<string, string> }).serviceData;
  if (!serviceData) {
    return undefined;
  }

  const payload =
    serviceData[serviceUuid] ??
    Object.entries(serviceData).find(([uuid]) => uuid.toLowerCase() === serviceUuid)?.[1];
  if (!payload) {
    return undefined;
  }

  try {
    return decodeUtf8(payload).trim();
  } catch {
    return undefined;
  }
}

function toNearbyReceiverCandidate(record: NearbyReceiverCandidateRecord): NearbyReceiverCandidate {
  return {
    candidateId: record.candidateId,
    mode: record.mode,
    displayName: record.displayName,
    deviceName: record.deviceName,
    deviceId: record.deviceId,
    walletAddress: record.walletAddress,
    walletId: record.walletId,
    rpcReachable: record.rpcReachable,
    instantClaimCapable: record.instantClaimCapable,
    lastSeenAt: record.lastSeenAt,
    resolved: record.resolved,
    preferred: record.preferred,
  };
}

function mergeBootstrapCandidateRecord(input: {
  existing?: NearbyReceiverCandidateRecord;
  bootstrap: BootstrapPayload;
  preferred: boolean;
  device?: Device;
}): NearbyReceiverCandidateRecord {
  const manifest = input.bootstrap.envelope.manifest;
  return {
    candidateId: buildResolvedCandidateId({
      walletAddress: manifest.walletAddress,
      deviceId: manifest.deviceId,
      sessionId: input.bootstrap.envelope.sessionId,
    }),
    mode: input.preferred ? "nfc" : input.existing?.mode ?? "ble",
    displayName:
      manifest.walletDisplayName?.trim() ||
      input.existing?.displayName ||
      input.device?.name?.trim(),
    deviceName: input.device?.name?.trim() ?? input.existing?.deviceName,
    deviceId: manifest.deviceId,
    walletAddress: manifest.walletAddress,
    walletId: manifest.walletId,
    rpcReachable: manifest.rpcReachable,
    instantClaimCapable: manifest.instantClaimCapable,
    lastSeenAt: new Date().toISOString(),
    resolved: true,
    preferred: input.preferred || input.existing?.preferred || false,
    bootstrap: input.bootstrap,
    device: input.device ?? input.existing?.device,
  };
}

function matchBootstrapToReceiverRecord(
  bootstrap: BootstrapPayload,
  record: NearbyReceiverCandidateRecord,
): boolean {
  const manifest = bootstrap.envelope.manifest;
  if (record.walletAddress?.trim() && manifest.walletAddress?.trim()) {
    return record.walletAddress === manifest.walletAddress;
  }
  if (record.deviceId?.trim() && manifest.deviceId?.trim()) {
    return record.deviceId === manifest.deviceId;
  }
  return record.candidateId === buildResolvedCandidateId({
    walletAddress: manifest.walletAddress,
    deviceId: manifest.deviceId,
    sessionId: bootstrap.envelope.sessionId,
  });
}

async function persistSessionTrustInteraction(
  peerId: string | undefined,
  kind: "encountered" | "handshake-accepted" | "receipt-published" | "closed" | "closed-clean",
) {
  if (!peerId?.trim()) {
    return;
  }

  await mutateLocalTrustState((current) =>
    recordPeerInteraction(current, {
      peerId,
      kind,
      occurredAt: new Date().toISOString(),
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withNfcOperationLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = nfcOperationQueue.then(operation, operation);
  nfcOperationQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function cancelNfcTechnologyRequestSettled(delayMs = 120): Promise<void> {
  await NfcManager.cancelTechnologyRequest().catch(() => undefined);
  if (delayMs > 0) {
    await sleep(delayMs);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function hexToBytes(value: string): number[] {
  return value.match(/.{1,2}/g)?.map((chunk) => Number.parseInt(chunk, 16)) ?? [];
}

function previewPayload(payload: string, maxLength = 220): string {
  const compact = payload.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}

function parseTransportJson<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error(`[AirPay] ${context} JSON parse failed`, {
      preview: previewPayload(raw),
      error: error instanceof Error ? error.message : String(error),
    });
    void recordDiagnosticError(`transport.${context.toLowerCase().replace(/[^a-z0-9]+/g, ".")}`, error, {
      preview: previewPayload(raw),
      context,
    });
    throw new Error(
      translate("service.transport.error.invalidJson", {
        context,
        preview: previewPayload(raw) || "<empty>",
      }),
    );
  }
}

function tryParseJsonSilently(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function buildReadBinaryApdu(offset: number, length: number): number[] {
  return [0x00, 0xb0, (offset >> 8) & 0xff, offset & 0xff, length & 0xff];
}

function decodeBootstrapPayload(textPayload: string): BootstrapPayload {
  const parsed = parseTransportJson<BootstrapPayload>(textPayload, "Receiver bootstrap payload");

  if (parsed.protocolVersion !== 1 || !parsed.envelope?.sessionId || !parsed.transportPublicKey) {
    throw new Error(translate("service.transport.error.bootstrapMalformed"));
  }

  return parsed;
}

function isBleChunkFrame(value: unknown): value is BleChunkFrame {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<BleChunkFrame>;
  return (
    typeof record.sessionId === "string" &&
    typeof record.chunkIndex === "number" &&
    typeof record.totalChunks === "number" &&
    typeof record.chunk === "string"
  );
}

function unwrapApduResponse(response: number[]): number[] {
  if (response.length < 2) {
    throw new Error(translate("service.transport.error.apduIncomplete"));
  }

  const sw1 = response[response.length - 2];
  const sw2 = response[response.length - 1];

  if (sw1 !== APDU_SUCCESS_SW1 || sw2 !== APDU_SUCCESS_SW2) {
    throw new Error(
      translate("service.transport.error.apduRejected", {
        status: `${sw1.toString(16)}${sw2.toString(16)}`,
      }),
    );
  }

  return response.slice(0, -2);
}

function decodeNdefBootstrapMessage(messageBytes: number[]): BootstrapPayload {
  const records = Ndef.decodeMessage(messageBytes);
  const record = records[0];
  if (!record?.payload) {
    throw new Error(translate("service.transport.error.ndefMissingTextRecord"));
  }

  const textPayload = Ndef.text.decodePayload(Uint8Array.from(record.payload as number[]));
  return decodeBootstrapPayload(textPayload);
}

async function readIsoDepBinary(offset: number, length: number): Promise<number[]> {
  const chunks: number[] = [];
  let cursor = offset;
  let remaining = length;

  while (remaining > 0) {
    const chunkLength = Math.min(remaining, APDU_READ_CHUNK_SIZE);
    const response = await NfcManager.isoDepHandler.transceive(buildReadBinaryApdu(cursor, chunkLength));
    chunks.push(...unwrapApduResponse(response));
    cursor += chunkLength;
    remaining -= chunkLength;
  }

  return chunks;
}

async function readBootstrapFromIsoDep(): Promise<BootstrapReadResult> {
  await NfcManager.requestTechnology(NfcTech.IsoDep, {
    alertMessage: translate("service.wallet.status.receiverReady"),
  });

  try {
    await NfcManager.isoDepHandler.transceive(NDEF_APP_SELECT_APDU).then(unwrapApduResponse);
    await NfcManager.isoDepHandler.transceive(CAPABILITY_CONTAINER_SELECT_APDU).then(unwrapApduResponse);
    await readIsoDepBinary(0, 15);
    await NfcManager.isoDepHandler.transceive(NDEF_FILE_SELECT_APDU).then(unwrapApduResponse);

    const nlenBytes = await readIsoDepBinary(0, 2);
    if (nlenBytes.length !== 2) {
      throw new Error(translate("service.transport.error.ndefInvalidLength"));
    }

    const ndefLength = (nlenBytes[0] << 8) | nlenBytes[1];
    if (ndefLength <= 0) {
      throw new Error(translate("service.transport.error.ndefEmptyMessage"));
    }

    const ndefMessage = await readIsoDepBinary(2, ndefLength);
    return {
      bootstrap: decodeNdefBootstrapMessage(ndefMessage),
      diagnostics: [
        `Receiver bootstrap read over Android HCE/IsoDep (${ndefLength} bytes).`,
        "NFC handoff can proceed to BLE discovery.",
      ],
      mode: "nfc",
      promotedToBle: true,
    };
  } finally {
    await cancelNfcTechnologyRequestSettled();
  }
}

async function readBootstrapFromNdefTag(): Promise<BootstrapReadResult> {
  await NfcManager.requestTechnology(NfcTech.Ndef, {
    alertMessage: translate("service.wallet.status.receiverReady"),
  });

  try {
    const tag = await NfcManager.getTag();
    const record = tag?.ndefMessage?.[0];
    if (!record?.payload) {
      throw new Error(translate("service.transport.error.ndefPayloadMissing"));
    }

    const textPayload = Ndef.text.decodePayload(Uint8Array.from(record.payload));
    return {
      bootstrap: decodeBootstrapPayload(textPayload),
      diagnostics: [
        "Receiver bootstrap read over plain NDEF.",
        "NFC handoff can proceed to BLE discovery.",
      ],
      mode: "nfc",
      promotedToBle: true,
    };
  } finally {
    await cancelNfcTechnologyRequestSettled();
  }
}

async function ensureBlePermissions(): Promise<void> {
  if (Platform.OS !== "android") {
    throw new Error(translate("service.transport.error.androidOnly"));
  }

  const results = await PermissionsAndroid.requestMultiple(BLUETOOTH_PERMISSIONS);
  const denied = Object.entries(results).filter(([, value]) => value !== PermissionsAndroid.RESULTS.GRANTED);

  if (denied.length > 0) {
    throw new Error(
      translate("service.transport.error.bluetoothDenied", {
        permissions: denied.map(([permission]) => permission).join(", "),
      }),
    );
  }
}

async function waitForBleState(targetState: State, timeoutMs: number): Promise<State> {
  const currentState = await bleManager.state();
  if (currentState === targetState) {
    return currentState;
  }

  return new Promise<State>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      subscription.remove();
      reject(
        new Error(
          translate("service.transport.error.bluetoothNotReady", {
            purpose: targetState,
            state: currentState,
          }),
        ),
      );
    }, timeoutMs);

    const subscription = bleManager.onStateChange((nextState) => {
      if (nextState === targetState) {
        clearTimeout(timeoutId);
        subscription.remove();
        resolve(nextState);
      }
    }, true);
  });
}

async function acquireBlePowerLease(purpose: "scan" | "advertise"): Promise<BlePowerLease> {
  await ensureBlePermissions();

  const currentState = await bleManager.state();
  if (currentState === State.PoweredOn) {
    return {
      purpose,
      originalState: currentState,
      enabledByApp: false,
      restored: false,
    };
  }

  if (Platform.OS === "android" && currentState === State.PoweredOff) {
    try {
      await bleManager.enable();
      await waitForBleState(State.PoweredOn, BLE_STATE_TIMEOUT_MS);
      void recordDiagnostic({
        level: "info",
        category: "transport.bluetooth.enabled",
        message: "Bluetooth was enabled by AirPay for the current transport session.",
        context: {
          purpose,
          originalState: currentState,
        },
      });
      return {
        purpose,
        originalState: currentState,
        enabledByApp: true,
        restored: false,
      };
    } catch (error) {
      const baseMessage = translate("service.transport.error.bluetoothOff", { context: purpose });
      const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
      throw new Error(`${baseMessage}${detail}`.trim());
    }
  }

  if (currentState === State.Unauthorized) {
    throw new Error(translate("service.transport.error.bluetoothUnauthorized", { context: purpose }));
  }
  if (currentState === State.Unsupported) {
    throw new Error(translate("service.transport.error.bluetoothUnsupported"));
  }

  throw new Error(
    translate("service.transport.error.bluetoothNotReady", {
      purpose,
      state: currentState,
    }),
  );
}

async function restoreBlePowerLease(lease: BlePowerLease | null | undefined): Promise<void> {
  if (!lease || lease.restored || !lease.enabledByApp) {
    return;
  }

  try {
    const currentState = await bleManager.state();
    if (currentState === State.PoweredOn) {
      await bleManager.disable();
      await waitForBleState(State.PoweredOff, BLE_STATE_TIMEOUT_MS);
      void recordDiagnostic({
        level: "info",
        category: "transport.bluetooth.restored",
        message: "Bluetooth state was restored after the AirPay transport session.",
        context: {
          purpose: lease.purpose,
          originalState: lease.originalState,
        },
      });
    }
  } catch (error) {
    void recordDiagnosticError("transport.bluetooth.restore", error, {
      purpose: lease.purpose,
      originalState: lease.originalState,
    });
  } finally {
    lease.restored = true;
  }
}

function describeBleFailure(error: unknown, context: string): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (message.toLowerCase().includes("operation was cancelled")) {
    return new Error(translate("service.transport.error.operationCancelled", { context }));
  }

  if (message.includes("BluetoothPoweredOff") || message.includes("powered off")) {
    return new Error(translate("service.transport.error.bluetoothOff", { context }));
  }
  if (message.includes("BluetoothUnauthorized")) {
    return new Error(translate("service.transport.error.bluetoothUnauthorized", { context }));
  }
  if (message.includes("BluetoothUnsupported")) {
    return new Error(translate("service.transport.error.bluetoothUnsupported"));
  }

  return error instanceof Error ? error : new Error(`${context} failed: ${message}`);
}

async function ensureNfcStarted(): Promise<void> {
  if (nfcStarted) {
    return;
  }

  const supported = await NfcManager.isSupported();
  if (!supported) {
    throw new Error(translate("service.transport.error.nfcUnsupported"));
  }

  await NfcManager.start();
  nfcStarted = true;
}

async function buildSignedEnvelope(input: {
  manifest: DeviceManifest;
  baseRoot: string;
  counter: number;
  sessionId?: string;
  gossip?: GossipEnvelope;
}): Promise<SecureHandshakeEnvelope> {
  const envelope = buildHandshakeEnvelope(input);
  const signedSessionId = input.sessionId ?? envelope.sessionId;
  const signature = await signPayload(
    canonicalStringify({
      sessionId: signedSessionId,
      manifest: input.manifest,
      baseRoot: input.baseRoot,
      nonce: envelope.nonce,
      counter: input.counter,
      gossip: input.gossip,
    }),
  );

  return {
    ...envelope,
    sessionId: signedSessionId,
    signature,
    gossip: input.gossip,
  };
}

function buildBootstrapManifest(manifest: DeviceManifest): BootstrapManifest {
  return {
    deviceId: manifest.deviceId,
    stateRoot: manifest.stateRoot,
    lastOnlineAt: manifest.lastOnlineAt,
    walletAddress: manifest.solanaAddress,
    walletId: manifest.activeWalletId,
    walletDisplayName: manifest.walletDisplayName,
    rpcReachable: manifest.rpcReachable,
    instantClaimCapable: manifest.instantClaimCapable,
  };
}

async function buildBootstrapEnvelope(input: {
  manifest: DeviceManifest;
  baseRoot: string;
  counter: number;
  sessionId?: string;
}): Promise<BootstrapEnvelope> {
  const manifest = buildBootstrapManifest(input.manifest);
  const nonce = createNonce("nonce");
  const sessionId = input.sessionId ?? createNonce("session");
  const signature = await signPayload(
    canonicalStringify({
      sessionId,
      manifest,
      baseRoot: input.baseRoot,
      nonce,
      counter: input.counter,
    }),
  );

  return {
    sessionId,
    manifest,
    baseRoot: input.baseRoot,
    nonce,
    counter: input.counter,
    signature,
  };
}

async function decryptTransportEnvelopePayload<T>(
  rawPayload: string,
  input: {
    context: string;
    sessionId: string;
    expectedPeerPublicKey?: string;
  },
): Promise<{ payload: T; senderPublicKey: string }> {
  const parsed = parseTransportJson<unknown>(rawPayload, `${input.context} envelope`);
  if (!isSecureTransportEnvelope(parsed)) {
    throw new Error(`${input.context} did not carry a secure transport envelope.`);
  }

  const decrypted = await decryptPeerPayload(parsed, {
    expectedContext: `${input.context}:${input.sessionId}`,
    expectedPeerPublicKey: input.expectedPeerPublicKey,
  });

  return {
    payload: parseTransportJson<T>(decrypted.plaintext, input.context),
    senderPublicKey: decrypted.senderPublicKey,
  };
}

function resolveTransportIds(manifest: DeviceManifest): NativeTransportIds {
  const defaults = getDefaultTransportIds();

  return {
    ...defaults,
    serviceUuid: manifest.bleServiceId ?? defaults.serviceUuid,
  };
}

async function readBootstrapFromNfc(): Promise<BootstrapReadResult> {
  return withNfcOperationLock(async () => {
    await ensureNfcStarted();
    await cancelNfcTechnologyRequestSettled(0);

    const failures: string[] = [];

    try {
      return await readBootstrapFromIsoDep();
    } catch (error) {
      void recordDiagnosticError("transport.nfc.isodep", error);
      failures.push(error instanceof Error ? `IsoDep failed: ${error.message}` : "IsoDep failed.");
    }

    try {
      return await readBootstrapFromNdefTag();
    } catch (error) {
      void recordDiagnosticError("transport.nfc.ndef", error);
      failures.push(error instanceof Error ? `NDEF failed: ${error.message}` : "NDEF failed.");
    }

    throw new Error(
      translate("service.transport.error.nfcRead", {
        details: failures.join(" "),
      }),
    );
  });
}

function chunkTransportPayload(sessionId: string, payload: string) {
  const data = encodeUtf8(payload);
  const chunkSize = 140;
  const totalChunks = Math.max(1, Math.ceil(data.length / chunkSize));

  return Array.from({ length: totalChunks }, (_, index) =>
    JSON.stringify({
      sessionId,
      chunkIndex: index,
      totalChunks,
      chunk: data.slice(index * chunkSize, (index + 1) * chunkSize),
    }),
  );
}

function decodeStreamChunkPayload(input: { sessionId?: string; totalChunks?: number; chunks: Map<number, string> }): string {
  if (!input.sessionId || !input.totalChunks || input.chunks.size !== input.totalChunks) {
    throw new Error(translate("service.transport.error.bleStreamEnded"));
  }

  const merged = buildStringFromChunks(input.totalChunks, input.chunks);
  return decodeUtf8(merged);
}

function buildStringFromChunks(totalChunks: number, chunks: Map<number, string>): string {
  let merged = "";
  for (let index = 0; index < totalChunks; index += 1) {
    const value = chunks.get(index);
    if (!value) {
      throw new Error(
        translate("service.transport.error.bleMissingChunk", {
          index: index + 1,
          total: totalChunks,
        }),
      );
    }
    merged += value;
  }
  return merged;
}

async function waitForBleStreamPayload(input: {
  device: Device;
  serviceUuid: string;
  characteristicUuid: string;
  timeoutMs: number;
  context: string;
  expectedSessionId?: string;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const bucket = {
      sessionId: input.expectedSessionId,
      totalChunks: undefined as number | undefined,
      chunks: new Map<number, string>(),
    };

    const timeoutId = setTimeout(() => {
      subscription.remove();
      reject(new Error(translate("service.transport.error.bleStreamTimeout", { context: input.context })));
    }, input.timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutId);
      subscription.remove();
    };

    const subscription = input.device.monitorCharacteristicForService(
      input.serviceUuid,
      input.characteristicUuid,
      (error, characteristic) => {
        if (error) {
          cleanup();
          reject(describeBleFailure(error, input.context));
          return;
        }

        const encodedFrame = characteristic?.value ? decodeUtf8(characteristic.value).trim() : "";
        if (!encodedFrame) {
          return;
        }

        try {
          const frame = parseTransportJson<BleChunkFrame>(encodedFrame, `${input.context} frame`);
          if (bucket.sessionId && frame.sessionId !== bucket.sessionId) {
            return;
          }

          bucket.sessionId = frame.sessionId;
          bucket.totalChunks = frame.totalChunks;
          bucket.chunks.set(frame.chunkIndex, frame.chunk);

          if (bucket.totalChunks && bucket.chunks.size === bucket.totalChunks) {
            const payload = decodeStreamChunkPayload(bucket);
            cleanup();
            resolve(payload);
          }
        } catch (streamError) {
          cleanup();
          reject(streamError instanceof Error ? streamError : new Error(String(streamError)));
        }
      },
    );
  });
}

async function writeChunkedPayload(
  device: Device,
  serviceUuid: string,
  characteristicUuid: string,
  sessionId: string,
  payload: string,
) {
  const frames = chunkTransportPayload(sessionId, payload);

  for (const frame of frames) {
    await device.writeCharacteristicWithResponseForService(serviceUuid, characteristicUuid, encodeUtf8(frame));
  }
}

async function scanForReceiver(serviceUuid: string): Promise<Device> {
  return new Promise<Device>((resolve, reject) => {
    let fallbackDevice: Device | null = null;
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(looseReceiverTimerId);
      bleManager.stopDeviceScan();
      callback();
    };
    const resolveWithDevice = (device: Device, fallback: boolean) => {
      if (fallback) {
        void recordDiagnostic({
          level: "warn",
          category: "transport.discovery.loose_receiver",
          message:
            "BLE scan selected a receiver candidate without advertised AirPay service metadata after waiting for a stronger signal.",
          context: {
            deviceId: device.id,
            label: getBleDeviceLabel(device),
            serviceUuid,
            waitMs: BLE_DISCOVERY_LOOSE_RECEIVER_DELAY_MS,
          },
        });
      }
      settle(() => resolve(device));
    };

    const looseReceiverTimerId = setTimeout(() => {
      if (fallbackDevice) {
        resolveWithDevice(fallbackDevice, true);
      }
    }, BLE_DISCOVERY_LOOSE_RECEIVER_DELAY_MS);
    const timeoutId = setTimeout(() => {
      const fallback = fallbackDevice;
      if (fallback) {
        resolveWithDevice(fallback, true);
        return;
      }
      settle(() => reject(new Error(translate("service.transport.error.bleScanTimeout"))));
    }, BLE_DISCOVERY_SCAN_TIMEOUT_MS);

    bleManager.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
      if (error) {
        settle(() => reject(describeBleFailure(error, "receiver scan")));
        return;
      }

      if (!device) {
        return;
      }

      if (hasStrongBleReceiverSignal(device, serviceUuid)) {
        resolveWithDevice(device, false);
        return;
      }

      if ((device.serviceUUIDs ?? []).length === 0 && !fallbackDevice) {
        fallbackDevice = device;
      }
    });
  });
}

async function connectToSpecificReceiver(device: Device): Promise<Device> {
  const alreadyConnected = await device.isConnected().catch(() => false);
  const connected = alreadyConnected
    ? device
    : await device.connect({ timeout: BLE_CONNECT_TIMEOUT_MS, autoConnect: false }).catch((error) => {
        throw describeBleFailure(error, "receiver connect");
      });

  try {
    await connected.requestMTU(512);
  } catch {
    // MTU negotiation is best-effort on Android; the transfer still works with chunking.
  }

  return connected.discoverAllServicesAndCharacteristics();
}

async function connectToReceiver(transportIds: NativeTransportIds): Promise<Device> {
  const discovered = await scanForReceiver(transportIds.serviceUuid);
  return connectToSpecificReceiver(discovered);
}

async function readBootstrapFromBleDevice(
  device: Device,
  transportIds: NativeTransportIds,
  reason: string,
): Promise<BootstrapReadResult> {
  const connected = await connectToSpecificReceiver(device).catch((error) => {
    throw describeBleFailure(error, "receiver connect");
  });

  try {
    let payload = "";
    let diagnostics = [reason];

    try {
      payload = await waitForBleStreamPayload({
        device: connected,
        serviceUuid: transportIds.serviceUuid,
        characteristicUuid: transportIds.handshakeCharacteristicUuid,
        timeoutMs: BLE_BOOTSTRAP_STREAM_TIMEOUT_MS,
        context: "BLE bootstrap stream",
      });
      diagnostics.push("Receiver bootstrap received over BLE notification stream.");
    } catch (streamError) {
      diagnostics.push(
        `BLE bootstrap stream retry engaged: ${streamError instanceof Error ? streamError.message : String(streamError)}`,
      );

      await sleep(250);

      try {
        payload = await waitForBleStreamPayload({
          device: connected,
          serviceUuid: transportIds.serviceUuid,
          characteristicUuid: transportIds.handshakeCharacteristicUuid,
          timeoutMs: BLE_BOOTSTRAP_RETRY_TIMEOUT_MS,
          context: "BLE bootstrap retry stream",
        });
        diagnostics.push("Receiver bootstrap received over BLE notification retry stream.");
      } catch (retryError) {
        diagnostics.push(
          `BLE bootstrap direct-read fallback engaged: ${
            retryError instanceof Error ? retryError.message : String(retryError)
          }`,
        );

        const characteristic = await connected.readCharacteristicForService(
          transportIds.serviceUuid,
          transportIds.handshakeCharacteristicUuid,
        );
        if (!characteristic.value) {
          throw new Error(translate("service.transport.error.bleBootstrapMissing"));
        }

        payload = decodeUtf8(characteristic.value).trim();
        if (!payload) {
          throw new Error(translate("service.transport.error.bleBootstrapEmpty"));
        }
        diagnostics.push("Receiver bootstrap read directly from the BLE handshake characteristic.");
      }
    }

    return {
      bootstrap: decodeBootstrapPayload(payload),
      diagnostics,
      mode: "ble",
      promotedToBle: false,
      device: connected,
    };
  } catch (error) {
    await connected.cancelConnection().catch(() => undefined);
    throw error;
  }
}

async function readBootstrapFromBle(transportIds: NativeTransportIds, reason: string): Promise<BootstrapReadResult> {
  const device = await scanForReceiver(transportIds.serviceUuid);
  return readBootstrapFromBleDevice(device, transportIds, reason);
}

async function waitForReceiptViaPollingRead(
  device: Device,
  transportIds: NativeTransportIds,
  sessionId: string,
  peerTransportPublicKey: string,
): Promise<TransferReceipt> {
  const deadline = Date.now() + BLE_RECEIPT_POLL_TIMEOUT_MS;
  let lastEnvelopeError: Error | null = null;

  while (Date.now() < deadline) {
    const characteristic = await device.readCharacteristicForService(
      transportIds.serviceUuid,
      transportIds.receiptCharacteristicUuid,
    );
    if (characteristic.value) {
      const payload = decodeUtf8(characteristic.value).trim();
      if (payload) {
        const parsed = tryParseJsonSilently(payload);
        if (!parsed) {
          await sleep(250);
          continue;
        }
        if (isBleChunkFrame(parsed) && parsed.sessionId === sessionId) {
          await sleep(250);
          continue;
        }

        try {
          const decrypted = await decryptTransportEnvelopePayload<TransferReceipt>(payload, {
            context: P2P_RECEIPT_CONTEXT,
            sessionId,
            expectedPeerPublicKey: peerTransportPublicKey,
          });
          const receipt = decrypted.payload;
          if (receipt.sessionId === sessionId) {
            return receipt;
          }
        } catch (error) {
          lastEnvelopeError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    await sleep(400);
  }

  if (lastEnvelopeError) {
    throw lastEnvelopeError;
  }

  throw new Error(translate("service.transport.error.bleReceiptTimeout"));
}

async function waitForReceipt(
  device: Device,
  transportIds: NativeTransportIds,
  sessionId: string,
  peerTransportPublicKey: string,
): Promise<TransferReceipt> {
  try {
    const payload = await waitForBleStreamPayload({
      device,
      serviceUuid: transportIds.serviceUuid,
      characteristicUuid: transportIds.receiptCharacteristicUuid,
      timeoutMs: BLE_RECEIPT_STREAM_TIMEOUT_MS,
      context: "BLE receipt stream",
      expectedSessionId: sessionId,
    });
    const decrypted = await decryptTransportEnvelopePayload<TransferReceipt>(payload.trim(), {
      context: P2P_RECEIPT_CONTEXT,
      sessionId,
      expectedPeerPublicKey: peerTransportPublicKey,
    });
    const receipt = decrypted.payload;
    if (receipt.sessionId !== sessionId) {
      throw new Error(translate("service.transport.error.bleReceiptSessionMismatch"));
    }
    return receipt;
  } catch (streamError) {
    void recordDiagnostic({
      level: "warn",
      category: "transport.receipt.fallback",
      message: "Retrying BLE receipt notification stream before polling fallback.",
      context: {
        sessionId,
        reason: streamError instanceof Error ? streamError.message : String(streamError),
      },
    });
    try {
      const retryPayload = await waitForBleStreamPayload({
        device,
        serviceUuid: transportIds.serviceUuid,
        characteristicUuid: transportIds.receiptCharacteristicUuid,
        timeoutMs: BLE_RECEIPT_RETRY_TIMEOUT_MS,
        context: "BLE receipt retry stream",
        expectedSessionId: sessionId,
      });
      const decrypted = await decryptTransportEnvelopePayload<TransferReceipt>(retryPayload.trim(), {
        context: P2P_RECEIPT_CONTEXT,
        sessionId,
        expectedPeerPublicKey: peerTransportPublicKey,
      });
      const receipt = decrypted.payload;
      if (receipt.sessionId !== sessionId) {
        throw new Error(translate("service.transport.error.bleReceiptSessionMismatch"));
      }
      return receipt;
    } catch (retryError) {
      void recordDiagnostic({
        level: "warn",
        category: "transport.receipt.fallback",
        message: "Falling back from BLE receipt notification retry to polling read.",
        context: {
          sessionId,
          reason: retryError instanceof Error ? retryError.message : String(retryError),
        },
      });
      return waitForReceiptViaPollingRead(device, transportIds, sessionId, peerTransportPublicKey);
    }
  }
}

function buildTransportSessionFromBootstrapResult(input: {
  bootstrapResult: BootstrapReadResult;
  bleLease: BlePowerLease;
  fallbackDiagnostics?: string[];
}): ActiveTransportSession {
  const defaults = getDefaultTransportIds();
  const effectiveTransportIds: NativeTransportIds = {
    ...defaults,
    serviceUuid: input.bootstrapResult.bootstrap.serviceUuid ?? defaults.serviceUuid,
  };
  const peerProofDigestFromBootstrap = {
    deviceId: input.bootstrapResult.bootstrap.envelope.manifest.deviceId,
    stateRoot: input.bootstrapResult.bootstrap.envelope.manifest.stateRoot,
    baseRoot: input.bootstrapResult.bootstrap.envelope.baseRoot,
    counter: input.bootstrapResult.bootstrap.envelope.counter,
    nonce: input.bootstrapResult.bootstrap.envelope.nonce,
    lastOnlineAt: input.bootstrapResult.bootstrap.envelope.manifest.lastOnlineAt,
    signature: input.bootstrapResult.bootstrap.envelope.signature,
  };
  const gossipSummary = summarizeGossipEnvelope(input.bootstrapResult.bootstrap.gossip);

  return {
    sessionId: input.bootstrapResult.bootstrap.envelope.sessionId,
    mode: input.bootstrapResult.mode,
    diagnostics: [
      ...input.bootstrapResult.diagnostics,
      ...(input.fallbackDiagnostics ?? []),
      ...(input.bootstrapResult.device ? [] : ["BLE connection established with the receiver peripheral."]),
      ...(input.bleLease.enabledByApp ? ["Bluetooth was enabled temporarily for this transaction."] : []),
      ...(gossipSummary
        ? [
            `Trust gossip received: ${gossipSummary.reputations} reputation hints, ${gossipSummary.blacklist} blacklist digests, ${gossipSummary.checkpoints} checkpoints.`,
          ]
        : []),
    ],
    peerProofDigest: peerProofDigestFromBootstrap,
    peerWalletAddress: input.bootstrapResult.bootstrap.envelope.manifest.walletAddress,
    peerWalletId: input.bootstrapResult.bootstrap.envelope.manifest.walletId,
    peerDisplayName: input.bootstrapResult.bootstrap.envelope.manifest.walletDisplayName,
    peerRpcReachable: input.bootstrapResult.bootstrap.envelope.manifest.rpcReachable,
    peerInstantClaimCapable: input.bootstrapResult.bootstrap.envelope.manifest.instantClaimCapable,
    peerTransportPublicKey: input.bootstrapResult.bootstrap.transportPublicKey,
    promotedToBle: input.bootstrapResult.promotedToBle,
    transportIds: effectiveTransportIds,
    device:
      input.bootstrapResult.device ??
      (() => {
        throw new Error("Receiver device missing for active transport session.");
      })(),
    bleLease: input.bleLease,
  };
}

async function ingestBootstrapTrustGossip(bootstrap: BootstrapPayload | undefined) {
  if (!bootstrap?.gossip) {
    return;
  }
  await mutateLocalTrustState((current) => ingestGossipEnvelope(current, bootstrap.gossip!));
}

async function findMatchingBleBootstrapResult(input: {
  target: NearbyReceiverCandidateRecord;
  transportIds: NativeTransportIds;
  candidates: Map<string, NearbyReceiverCandidateRecord>;
}): Promise<BootstrapReadResult> {
  for (const candidate of input.candidates.values()) {
    if (!candidate.device) {
      continue;
    }

    try {
      const bootstrapResult = await readBootstrapFromBleDevice(
        candidate.device,
        input.transportIds,
        "Matching NFC-selected receiver over BLE.",
      );
      if (input.target.bootstrap && matchBootstrapToReceiverRecord(bootstrapResult.bootstrap, input.target)) {
        return bootstrapResult;
      }
      await bootstrapResult.device?.cancelConnection().catch(() => undefined);
    } catch {
      // Best-effort matching against scanned BLE peripherals.
    }
  }

  throw new Error(translate("service.transport.error.nfcBleMatchMissing"));
}

export async function startNearbyReceiverDiscovery(input: {
  manifest: DeviceManifest;
}): Promise<NearbyReceiverDiscoveryHandle> {
  const transportIds = resolveTransportIds(input.manifest);
  const capabilitySnapshot = await getSupportedCapabilities().catch(() => ({
    nfc: Boolean(input.manifest.transportCapabilities?.nfc),
    bleCentral: true,
    blePeripheral: Boolean(input.manifest.transportCapabilities?.blePeripheral),
    attestation: Boolean(input.manifest.transportCapabilities?.attestation),
    hce: Boolean(input.manifest.transportCapabilities?.hce),
    platform: Platform.OS,
  }));
  const bleLease = await acquireBlePowerLease("scan");
  const candidates = new Map<string, NearbyReceiverCandidateRecord>();
  const listeners = new Set<(snapshot: NearbyReceiverDiscoverySnapshot) => void>();
  let bleActive = true;
  let nfcStatus: NfcDiscoveryStatus = capabilitySnapshot.nfc ? "scanning" : "unsupported";
  let stopped = false;
  let leaseTransferred = false;
  let nfcAttempt = 0;

  const emitSnapshot = () => {
    const snapshot: NearbyReceiverDiscoverySnapshot = {
      receivers: Array.from(candidates.values()).map(toNearbyReceiverCandidate).sort(sortNearbyReceiverCandidates),
      bleActive,
      nfcStatus,
    };
    listeners.forEach((listener) => listener(snapshot));
  };

  const upsertRawBleCandidate = (device: Device) => {
    const candidateId = findExistingCandidateIdForDevice(candidates, device) ?? buildBleCandidateId(device.id);
    const existing = candidates.get(candidateId);
    const label = getBleDeviceLabel(device);
    const preferred = existing?.preferred ?? hasStrongBleReceiverSignal(device, transportIds.serviceUuid);
    candidates.set(candidateId, {
      candidateId: existing?.candidateId ?? candidateId,
      mode: existing?.mode ?? "ble",
      displayName: existing?.displayName ?? label,
      deviceName: label,
      deviceId: existing?.deviceId ?? device.id,
      walletAddress: existing?.walletAddress,
      walletId: existing?.walletId,
      lastSeenAt: new Date().toISOString(),
      resolved: existing?.resolved ?? false,
      preferred,
      rpcReachable: existing?.rpcReachable,
      instantClaimCapable: existing?.instantClaimCapable,
      bootstrap: existing?.bootstrap,
      device,
    });
    emitSnapshot();
  };

  const mergeResolvedCandidate = (bootstrap: BootstrapPayload, preferred: boolean, device?: Device) => {
    const resolvedId = buildResolvedCandidateId({
      walletAddress: bootstrap.envelope.manifest.walletAddress,
      deviceId: bootstrap.envelope.manifest.deviceId,
      sessionId: bootstrap.envelope.sessionId,
    });
    const bleCandidateId = device ? buildBleCandidateId(device.id) : undefined;
    const merged = mergeBootstrapCandidateRecord({
      existing: candidates.get(resolvedId) ?? (bleCandidateId ? candidates.get(bleCandidateId) : undefined),
      bootstrap,
      preferred,
      device,
    });
    if (bleCandidateId && bleCandidateId !== resolvedId) {
      candidates.delete(bleCandidateId);
    }
    candidates.set(resolvedId, merged);
    emitSnapshot();
    return merged;
  };

  const runNfcDiscoveryAttempt = async () => {
    if (!capabilitySnapshot.nfc || stopped) {
      nfcStatus = capabilitySnapshot.nfc ? "idle" : "unsupported";
      emitSnapshot();
      return;
    }

    const attemptId = ++nfcAttempt;
    nfcStatus = "scanning";
    emitSnapshot();

    try {
      const result = await withTimeout(readBootstrapFromNfc(), NFC_BOOTSTRAP_TIMEOUT_MS, NFC_DISCOVERY_TIMEOUT_MESSAGE);
      if (stopped || attemptId !== nfcAttempt) {
        await result.device?.cancelConnection().catch(() => undefined);
        return;
      }
      mergeResolvedCandidate(result.bootstrap, true, result.device);
      await ingestBootstrapTrustGossip(result.bootstrap);
      nfcStatus = "matched";
      emitSnapshot();
    } catch (error) {
      await cancelNfcTechnologyRequestSettled();
      if (stopped || attemptId !== nfcAttempt) {
        return;
      }
      nfcStatus =
        error instanceof Error && error.message === NFC_DISCOVERY_TIMEOUT_MESSAGE ? "timed_out" : "error";
      emitSnapshot();
    }
  };

  bleManager.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
    if (stopped) {
      bleManager.stopDeviceScan();
      return;
    }
    if (error) {
      bleActive = false;
      void recordDiagnosticError("transport.discovery.scan", error, {
        serviceUuid: transportIds.serviceUuid,
      });
      emitSnapshot();
      return;
    }
    if (!device) {
      return;
    }
    if (hasStrongBleReceiverSignal(device, transportIds.serviceUuid)) {
      upsertRawBleCandidate(device);
    }
  });

  emitSnapshot();
  void runNfcDiscoveryAttempt();

  const stopInternal = async (restoreLease: boolean) => {
    if (stopped) {
      if (restoreLease && !leaseTransferred) {
        await restoreBlePowerLease(bleLease);
      }
      return;
    }

    stopped = true;
    bleManager.stopDeviceScan();
    bleActive = false;
    await cancelNfcTechnologyRequestSettled();
    if (restoreLease && !leaseTransferred) {
      await restoreBlePowerLease(bleLease);
    }
    emitSnapshot();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener({
        receivers: Array.from(candidates.values()).map(toNearbyReceiverCandidate).sort(sortNearbyReceiverCandidates),
        bleActive,
        nfcStatus,
      });
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return {
        receivers: Array.from(candidates.values()).map(toNearbyReceiverCandidate).sort(sortNearbyReceiverCandidates),
        bleActive,
        nfcStatus,
      };
    },
    async resolveCandidate(candidateId) {
      const candidate = candidates.get(candidateId);
      if (!candidate) {
        throw new Error(translate("service.transport.error.discoveryCandidateMissing"));
      }
      if (candidate.resolved) {
        return toNearbyReceiverCandidate(candidate);
      }
      if (!candidate.device) {
        throw new Error(translate("service.transport.error.discoveryCandidateUnavailable"));
      }

      const bootstrapResult = await readBootstrapFromBleDevice(
        candidate.device,
        transportIds,
        "Resolving selected receiver over BLE.",
      );
      const merged = mergeResolvedCandidate(bootstrapResult.bootstrap, false, candidate.device);
      await ingestBootstrapTrustGossip(bootstrapResult.bootstrap);
      await bootstrapResult.device?.cancelConnection().catch(() => undefined);
      return toNearbyReceiverCandidate(merged);
    },
    async retryNfc() {
      if (!capabilitySnapshot.nfc) {
        nfcStatus = "unsupported";
        emitSnapshot();
        return;
      }
      await cancelNfcTechnologyRequestSettled();
      await runNfcDiscoveryAttempt();
    },
    async createSession(args) {
      const candidate = candidates.get(args.candidateId);
      if (!candidate) {
        throw new Error(translate("service.transport.error.discoveryCandidateMissing"));
      }

      try {
        bleManager.stopDeviceScan();
        bleActive = false;
        await cancelNfcTechnologyRequestSettled();
        emitSnapshot();

        let bootstrapResult: BootstrapReadResult;
        if (candidate.device) {
          bootstrapResult = await readBootstrapFromBleDevice(
            candidate.device,
            transportIds,
            candidate.mode === "nfc"
              ? "NFC selected receiver confirmed over BLE."
              : "Selected BLE receiver confirmed.",
          );
        } else if (candidate.mode === "nfc" && candidate.bootstrap) {
          bootstrapResult = await findMatchingBleBootstrapResult({
            target: candidate,
            transportIds,
            candidates,
          });
        } else {
          throw new Error(translate("service.transport.error.discoveryCandidateUnavailable"));
        }

        const merged = mergeResolvedCandidate(
          bootstrapResult.bootstrap,
          candidate.mode === "nfc" || candidate.preferred,
          bootstrapResult.device,
        );
        await ingestBootstrapTrustGossip(bootstrapResult.bootstrap);
        leaseTransferred = true;
        stopped = true;
        return buildTransportSessionFromBootstrapResult({
          bootstrapResult: {
            ...bootstrapResult,
            mode: candidate.mode === "nfc" ? "nfc" : bootstrapResult.mode,
            promotedToBle: candidate.mode === "nfc" ? true : bootstrapResult.promotedToBle,
            diagnostics: [
              ...bootstrapResult.diagnostics,
              ...(merged.mode === "nfc" ? ["Receiver selected by NFC proximity and confirmed over BLE."] : []),
            ],
          },
          bleLease,
        });
      } catch (error) {
        await stopInternal(true);
        throw error;
      }
    },
    async stop() {
      await stopInternal(true);
    },
  };
}

export async function bootstrapOfflineSession(input: {
  manifest: DeviceManifest;
  baseRoot: string;
  counter: number;
}): Promise<ActiveTransportSession> {
  const localTransportIds = resolveTransportIds(input.manifest);
  const capabilitySnapshot = await getSupportedCapabilities().catch(() => ({
    nfc: Boolean(input.manifest.transportCapabilities?.nfc),
    bleCentral: true,
    blePeripheral: Boolean(input.manifest.transportCapabilities?.blePeripheral),
    attestation: Boolean(input.manifest.transportCapabilities?.attestation),
    hce: Boolean(input.manifest.transportCapabilities?.hce),
    platform: Platform.OS,
  }));
  const bleLease = await acquireBlePowerLease("scan");

  try {
    let bootstrapResult: BootstrapReadResult;
    if (capabilitySnapshot.nfc) {
      try {
        bootstrapResult = await withTimeout(
          readBootstrapFromNfc(),
          NFC_BOOTSTRAP_TIMEOUT_MS,
          "Timed out waiting for an NFC bootstrap tap.",
        );
      } catch (error) {
        await cancelNfcTechnologyRequestSettled();
        const message = error instanceof Error ? error.message : "NFC bootstrap failed.";
        void recordDiagnostic({
          level: "warn",
          category: "transport.bootstrap.fallback",
          message: "Falling back from NFC bootstrap to BLE-only discovery.",
          context: {
            reason: message,
            nfcCapable: capabilitySnapshot.nfc,
            serviceUuid: localTransportIds.serviceUuid,
          },
        });
        bootstrapResult = await readBootstrapFromBle(
          localTransportIds,
          `NFC bootstrap failed; falling back to BLE-only discovery. ${message}`,
        );
      }
    } else {
      bootstrapResult = await readBootstrapFromBle(
        localTransportIds,
        "NFC is unavailable on this device; using BLE-only discovery.",
      );
    }

    const defaults = getDefaultTransportIds();
    const effectiveTransportIds: NativeTransportIds = {
      ...defaults,
      serviceUuid: bootstrapResult.bootstrap.serviceUuid ?? defaults.serviceUuid,
    };
    const device = bootstrapResult.device ?? (await connectToReceiver(effectiveTransportIds));
    if (bootstrapResult.bootstrap.gossip) {
      await mutateLocalTrustState((current) => ingestGossipEnvelope(current, bootstrapResult.bootstrap.gossip!));
    }

    return buildTransportSessionFromBootstrapResult({
      bootstrapResult: {
        ...bootstrapResult,
        device,
      },
      bleLease,
    });
  } catch (error) {
    await restoreBlePowerLease(bleLease);
    throw error;
  }
}

export async function transmitOfflineTransfer(input: {
  session: Awaited<ReturnType<typeof bootstrapOfflineSession>>;
  manifest: DeviceManifest;
  baseRoot: string;
  counter: number;
  transfer: OfflineTransfer;
}): Promise<{ receipt: TransferReceipt; session: TransportSession }> {
  const trustState = await loadLocalTrustState();
  const gossip = buildSelectiveGossipEnvelope(trustState, {
    maxPeers: 8,
    maxBlacklist: 8,
    maxCheckpoints: 8,
    targetPeerIds: [
      input.session.peerWalletAddress ?? "",
      input.session.peerWalletId ?? "",
      input.session.peerProofDigest.deviceId,
      input.transfer.receiverAddress ?? "",
      input.transfer.receiverPseudoId,
    ],
  });
  const localEnvelope = await buildSignedEnvelope({
    manifest: input.manifest,
    baseRoot: input.baseRoot,
    counter: input.counter,
    sessionId: input.session.sessionId,
    gossip,
  });

  try {
    const receiptPromise = waitForReceipt(
      input.session.device,
      input.session.transportIds,
      input.session.sessionId,
      input.session.peerTransportPublicKey,
    );
    // Android may finish enabling the receipt CCCD shortly after ble-plx returns
    // the monitor subscription. Give the receiver a short window before it can
    // publish a receipt, otherwise very fast local acknowledgements can be missed.
    await sleep(750);
    const encryptedHandshake = await encryptForPeerPayload(
      localEnvelope,
      input.session.peerTransportPublicKey,
      `${P2P_HANDSHAKE_CONTEXT}:${input.session.sessionId}`,
    );
    const encryptedTransfer = await encryptForPeerPayload(
      input.transfer,
      input.session.peerTransportPublicKey,
      `${P2P_TRANSFER_CONTEXT}:${input.session.sessionId}`,
    );
    await writeChunkedPayload(
      input.session.device,
      input.session.transportIds.serviceUuid,
      input.session.transportIds.handshakeCharacteristicUuid,
      input.session.sessionId,
      JSON.stringify(encryptedHandshake),
    );
    await writeChunkedPayload(
      input.session.device,
      input.session.transportIds.serviceUuid,
      input.session.transportIds.transferCharacteristicUuid,
      input.session.sessionId,
      JSON.stringify(encryptedTransfer),
    );

    const receipt = await receiptPromise;
    await persistSessionTrustInteraction(
      input.session.peerWalletAddress ?? input.session.peerProofDigest.deviceId,
      "receipt-published",
    );
    try {
      await input.session.device.writeCharacteristicWithResponseForService(
        input.session.transportIds.serviceUuid,
        input.session.transportIds.closeCharacteristicUuid,
        encodeUtf8(JSON.stringify({ sessionId: input.session.sessionId, reason: "done" })),
      );
    } catch (error) {
      void recordDiagnostic({
        level: "warn",
        category: "transport.close.signal",
        message:
          "Final BLE close signal failed after the transfer receipt was received. AirPay ignored the close write and kept the completed transfer.",
        context: {
          sessionId: input.session.sessionId,
          peerId: input.session.peerWalletAddress ?? input.session.peerProofDigest.deviceId,
          rawError: error instanceof Error ? error.message : String(error),
        },
      });
    }
    await persistSessionTrustInteraction(
      input.session.peerWalletAddress ?? input.session.peerProofDigest.deviceId,
      "closed-clean",
    );

    return {
      receipt,
      session: input.session,
    };
  } finally {
    await persistSessionTrustInteraction(input.session.peerWalletAddress ?? input.session.peerProofDigest.deviceId, "closed");
    await input.session.device.cancelConnection().catch(() => undefined);
    await restoreBlePowerLease(input.session.bleLease);
  }
}

export async function prepareReceiverTransport(input: {
  manifest: DeviceManifest;
  baseRoot: string;
  counter: number;
  transportIds: NativeTransportIds;
}): Promise<ReceiverPreparation> {
  const previousLease = activeReceiverBleLease;
  activeReceiverBleLease = null;
  await restoreBlePowerLease(previousLease);
  const bleLease = await acquireBlePowerLease("advertise");
  try {
    const rpcReachable = await probeRpcReachability().catch(() => false);
    const envelope = await buildBootstrapEnvelope({
      ...input,
      manifest: {
        ...input.manifest,
        rpcReachable,
        instantClaimCapable: rpcReachable,
      },
    });
    const transportPublicKey = await getLocalTransportPublicKey();
    const trustState = await loadLocalTrustState();
    const gossip = buildSelectiveGossipEnvelope(trustState, {
      maxPeers: 8,
      maxBlacklist: 8,
      maxCheckpoints: 8,
    });
    const bootstrapPayload = JSON.stringify({
      protocolVersion: 1,
      serviceUuid: input.transportIds.serviceUuid,
      transportPublicKey,
      envelope,
      gossip,
    } satisfies BootstrapPayload);
    const nativeSession = await prepareNativeReceiverSession({
      sessionId: envelope.sessionId,
      bootstrapPayload,
      transportIds: input.transportIds,
    });
    receiverSecurityContexts.set(envelope.sessionId, {});
    activeReceiverBleLease = bleLease;

    return {
      sessionId: nativeSession.sessionId,
      diagnostics: [
        ...nativeSession.diagnostics,
        `Bootstrap payload prepared (${encodeUtf8(bootstrapPayload).length} bytes).`,
        `Trust gossip prepared: ${gossip.reputations.length} reputation hints, ${gossip.blacklist.length} blacklist digests, ${gossip.checkpoints.length} checkpoints.`,
        ...(bleLease.enabledByApp ? ["Bluetooth was enabled temporarily for this receiver session."] : []),
      ],
      bootstrapPayload,
    };
  } catch (error) {
    await restoreBlePowerLease(bleLease);
    throw error;
  }
}

export function subscribeToReceiverLifecycle(listener: (event: ReceiverLifecycleEvent) => void): () => void {
  const emitter = getNativeEventEmitter();
  const subscriptions = [
    emitter.addListener(AirPayNativeEvents.receiverReady, (payload) =>
      listener({
        type: "ready",
        sessionId: payload?.sessionId,
        message: translate("service.wallet.status.receiverReady"),
      }),
    ),
    emitter.addListener(AirPayNativeEvents.receiverConnected, (payload) =>
      listener({
        type: "connected",
        sessionId: payload?.sessionId,
        message: translate("hook.receiver.peerConnected"),
      }),
    ),
    emitter.addListener(AirPayNativeEvents.receiverDisconnected, (payload) =>
      listener({
        type: "disconnected",
        sessionId: payload?.sessionId,
        message: translate("hook.receiver.peerDisconnected"),
      }),
    ),
    emitter.addListener(AirPayNativeEvents.sessionClosed, (payload) => {
      const peerId = payload?.sessionId
        ? handshakeCache.get(payload.sessionId)?.manifest.solanaAddress ?? handshakeCache.get(payload.sessionId)?.manifest.deviceId
        : undefined;
      void persistSessionTrustInteraction(peerId, "closed-clean").catch(() => undefined);
      listener({
        type: "closed",
        sessionId: payload?.sessionId,
        message: translate("hook.receiver.sessionClosed"),
      });
    }),
    emitter.addListener(AirPayNativeEvents.nativeError, (payload) =>
      listener({
        type: "error",
        sessionId: payload?.sessionId,
        message: payload?.message ?? translate("hook.receiver.nativeError"),
      }),
    ),
  ];

  return () => {
    subscriptions.forEach((subscription) => subscription.remove());
  };
}

export function subscribeToIncomingTransfers(listener: (event: IncomingTransferEvent) => void): () => void {
  const emitter = getNativeEventEmitter();
  const pendingTransferPayloads = new Map<string, string[]>();

  const processTransferPayload = async (sessionId: string, rawPayload: string) => {
    try {
      const decrypted = await decryptTransportEnvelopePayload<OfflineTransfer>(rawPayload, {
        context: P2P_TRANSFER_CONTEXT,
        sessionId,
        expectedPeerPublicKey: receiverSecurityContexts.get(sessionId)?.peerTransportPublicKey,
      });
      receiverSecurityContexts.set(sessionId, {
        peerTransportPublicKey: decrypted.senderPublicKey,
      });
      listener({
        sessionId,
        transfer: decrypted.payload,
        handshake: handshakeCache.get(sessionId),
      });
    } catch (error) {
      console.error("[AirPay] dropping malformed native transfer payload", error);
      void recordDiagnosticError("transport.native.transfer", error, { sessionId });
    }
  };

  const drainPendingTransferPayloads = (sessionId: string) => {
    const queuedPayloads = pendingTransferPayloads.get(sessionId);
    if (!queuedPayloads?.length) {
      return;
    }

    pendingTransferPayloads.delete(sessionId);
    queuedPayloads.forEach((queuedPayload) => {
      void processTransferPayload(sessionId, queuedPayload);
    });
  };

  const handshakeSubscription = emitter.addListener(AirPayNativeEvents.handshakeReceived, (payload) => {
    if (!payload?.sessionId || !payload?.payload) {
      return;
    }
    void (async () => {
      try {
        const decrypted = await decryptTransportEnvelopePayload<SecureHandshakeEnvelope>(payload.payload, {
          context: P2P_HANDSHAKE_CONTEXT,
          sessionId: payload.sessionId,
          expectedPeerPublicKey: receiverSecurityContexts.get(payload.sessionId)?.peerTransportPublicKey,
        });
        if (decrypted.payload.gossip) {
          await mutateLocalTrustState((current) => ingestGossipEnvelope(current, decrypted.payload.gossip!));
        }
        const peerId = decrypted.payload.manifest.solanaAddress ?? decrypted.payload.manifest.deviceId;
        await persistSessionTrustInteraction(peerId, "encountered");
        await persistSessionTrustInteraction(peerId, "handshake-accepted");
        handshakeCache.set(payload.sessionId, decrypted.payload);
        receiverSecurityContexts.set(payload.sessionId, {
          peerTransportPublicKey: decrypted.senderPublicKey,
        });
        drainPendingTransferPayloads(payload.sessionId);
      } catch (error) {
        console.error("[AirPay] dropping malformed native handshake payload", error);
        void recordDiagnosticError("transport.native.handshake", error, { sessionId: payload.sessionId });
      }
    })();
  });
  const transferSubscription = emitter.addListener(AirPayNativeEvents.transferReceived, (payload) => {
    if (!payload?.sessionId || !payload?.payload) {
      return;
    }

    if (!receiverSecurityContexts.get(payload.sessionId)?.peerTransportPublicKey) {
      const queuedPayloads = pendingTransferPayloads.get(payload.sessionId) ?? [];
      queuedPayloads.push(payload.payload);
      pendingTransferPayloads.set(payload.sessionId, queuedPayloads.slice(-4));
      return;
    }

    void processTransferPayload(payload.sessionId, payload.payload);
  });

  return () => {
    handshakeSubscription.remove();
    transferSubscription.remove();
    pendingTransferPayloads.clear();
  };
}

export async function acknowledgeTransfer(
  transfer: OfflineTransfer,
  extras: Partial<
    Pick<
      TransferReceipt,
      | "walletId"
      | "sessionSettlementMode"
      | "claimStatus"
      | "claimTxSignature"
      | "settleTxSignature"
      | "directSettlementSignature"
    >
  > = {},
): Promise<OfflineTransfer> {
  const receiptSeed = {
    receiptId: createNonce("receipt"),
    transferId: transfer.localTxId,
    receiverPrevTxHash: transfer.prevTxHash,
    receivedAt: new Date().toISOString(),
    sessionId: transfer.sessionId,
    settlementFeePolicy: transfer.settlementFeePolicy ?? RECEIVER_PAYS_OFFLINE_SETTLEMENT_FEES,
    ...extras,
  };
  const ackSignature = await signPayload(canonicalStringify(receiptSeed)).catch(() =>
    Promise.resolve(
      sha256Hex({
        transferId: transfer.localTxId,
        encryptedPayload: transfer.encryptedPayload,
        receivedAt: receiptSeed.receivedAt,
      }),
    ),
  );
  const receipt: TransferReceipt = {
    ...receiptSeed,
    ackSignature,
  };
  const signatureBundle = await createReceiverReceiptSignatureBundle(transfer, receipt);

  return appendReceipt(transfer, signatureBundle ? { ...receipt, signatureBundle } : receipt);
}

async function createReceiverReceiptSignatureBundle(
  transfer: OfflineTransfer,
  receipt: TransferReceipt,
): Promise<PromiseSignatureBundle | undefined> {
  if (!receipt.walletId) {
    return undefined;
  }

  const signingPayload = buildReceiptSigningPayload({
    receipt,
    transferHash: transfer.txHash,
  });
  const walletSignatures = await createWalletPromiseSignatures({
    walletId: receipt.walletId,
    message: signingPayload.canonicalPayload,
  });

  return {
    payloadVersion: 1,
    payloadHash: signingPayload.payloadHash,
    digest: signingPayload.digest,
    createdAt: new Date().toISOString(),
    certificateProfile: walletSignatures.certificateProfile ?? undefined,
    signatures: walletSignatures.signatures,
  };
}

export async function publishTransferReceipt(transfer: OfflineTransfer): Promise<TransferReceipt> {
  if (!transfer.receipt) {
    throw new Error(translate("service.transport.error.receiptRequired"));
  }

  const peerTransportPublicKey = receiverSecurityContexts.get(transfer.sessionId)?.peerTransportPublicKey;
  if (!peerTransportPublicKey) {
    throw new Error("Receiver transport security context is missing for this session.");
  }

  const encryptedReceipt = await encryptForPeerPayload(
    transfer.receipt,
    peerTransportPublicKey,
    `${P2P_RECEIPT_CONTEXT}:${transfer.sessionId}`,
  );
  await publishNativeReceipt(transfer.sessionId, JSON.stringify(encryptedReceipt));
  const peerId =
    handshakeCache.get(transfer.sessionId)?.manifest.solanaAddress ?? transfer.senderAddress ?? transfer.senderPseudoId;
  await persistSessionTrustInteraction(peerId, "receipt-published");
  return transfer.receipt;
}

export async function stopReceiverTransport(): Promise<void> {
  const closedPeerIds = Array.from(handshakeCache.values()).map(
    (handshake) => handshake.manifest.solanaAddress ?? handshake.manifest.deviceId,
  );
  handshakeCache.clear();
  receiverSecurityContexts.clear();
  try {
    await stopNativeReceiverSession();
  } finally {
    await Promise.all(closedPeerIds.map((peerId) => persistSessionTrustInteraction(peerId, "closed")));
    const lease = activeReceiverBleLease;
    activeReceiverBleLease = null;
    await restoreBlePowerLease(lease);
  }
}

export async function closeTransportSession(
  session: Awaited<ReturnType<typeof bootstrapOfflineSession>>,
): Promise<void> {
  await persistSessionTrustInteraction(session.peerWalletAddress ?? session.peerProofDigest.deviceId, "closed");
  await session.device.cancelConnection().catch(() => undefined);
  await restoreBlePowerLease(session.bleLease);
}
