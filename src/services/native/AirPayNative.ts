import { NativeEventEmitter, NativeModules, Platform } from "react-native";

export interface NativeTransportIds {
  serviceUuid: string;
  handshakeCharacteristicUuid: string;
  transferCharacteristicUuid: string;
  receiptCharacteristicUuid: string;
  closeCharacteristicUuid: string;
}

export interface NativeCapabilitySnapshot {
  nfc: boolean;
  bleCentral: boolean;
  blePeripheral: boolean;
  attestation: boolean;
  hce: boolean;
  platform: string;
}

export interface NativeIntegrityManifestResult {
  deviceId: string;
  integrityLevel: "strongbox" | "tee" | "software";
  attestationValid: boolean;
  keyAlias: string;
  publicKey: string;
  keySecurityLevel: "strongbox" | "tee" | "software" | "unknown";
  deviceSecurityLevel: "strongbox" | "tee" | "software" | "unknown";
  isHardwareBacked: boolean;
  attestationChallenge: string;
  attestationCertificates: string[];
  transportCapabilities: {
    nfc: boolean;
    bleCentral: boolean;
    blePeripheral: boolean;
    attestation: boolean;
    hce: boolean;
  };
}

export interface NativeReceiverSessionResult {
  sessionId: string;
  advertising: boolean;
  hceReady: boolean;
  diagnostics: string[];
}

export interface NativeBackgroundRuntimeStatus {
  supported: boolean;
  backgroundServiceRunning: boolean;
  overlayPermissionGranted: boolean;
  overlayVisible: boolean;
  bluetoothEnabled: boolean;
  nfcEnabled: boolean;
  networkConnected?: boolean;
}

export interface NativeNetworkAvailableEvent {
  connected: boolean;
  occurredAt: number;
}

type AirPayNativeModuleShape = {
  adbAutomationEnabled?: boolean;
  getAdbAutomationEnabled?: () => Promise<boolean>;
  getSupportedCapabilities(): Promise<NativeCapabilitySnapshot>;
  getBackgroundRuntimeStatus(): Promise<NativeBackgroundRuntimeStatus>;
  startBackgroundRuntime(): Promise<NativeBackgroundRuntimeStatus>;
  stopBackgroundRuntime(): Promise<NativeBackgroundRuntimeStatus>;
  requestOverlayPermission(): Promise<NativeBackgroundRuntimeStatus>;
  showOverlay(): Promise<NativeBackgroundRuntimeStatus>;
  hideOverlay(): Promise<NativeBackgroundRuntimeStatus>;
  requestBluetoothEnable(): Promise<NativeBackgroundRuntimeStatus>;
  openBluetoothSettings(): Promise<NativeBackgroundRuntimeStatus>;
  openNfcSettings(): Promise<NativeBackgroundRuntimeStatus>;
  getIntegrityManifest(config: {
    appVersion: string;
    policyHash: string;
    attestationChallenge: string;
    bleServiceId: string;
  }): Promise<NativeIntegrityManifestResult>;
  signPayload(payload: string): Promise<string>;
  prepareReceiverSession(config: {
    sessionId: string;
    bootstrapPayload: string;
    transportIds: NativeTransportIds;
  }): Promise<NativeReceiverSessionResult>;
  publishReceipt(sessionId: string, receiptPayload: string): Promise<void>;
  stopReceiverSession(): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

const nativeModule = NativeModules.AirPayNative as AirPayNativeModuleShape | undefined;
export const AIRPAY_NATIVE_UNSUPPORTED = "AirPay native bridge is only available on Android builds with the native module linked.";

export const AirPayNativeEvents = {
  receiverReady: "AirPayReceiverReady",
  receiverConnected: "AirPayReceiverConnected",
  receiverDisconnected: "AirPayReceiverDisconnected",
  handshakeReceived: "AirPayHandshakeReceived",
  transferReceived: "AirPayTransferReceived",
  sessionClosed: "AirPaySessionClosed",
  networkAvailable: "AirPayNetworkAvailable",
  backgroundRuntimeStatus: "AirPayBackgroundRuntimeStatus",
  nativeError: "AirPayNativeError",
} as const;

let emitter: NativeEventEmitter | null = null;

function ensureNativeModule(): AirPayNativeModuleShape {
  if (Platform.OS !== "android" || !nativeModule) {
    throw new Error(AIRPAY_NATIVE_UNSUPPORTED);
  }

  return nativeModule;
}

export function getNativeEventEmitter(): NativeEventEmitter {
  if (!emitter) {
    emitter = new NativeEventEmitter(ensureNativeModule());
  }

  return emitter;
}

export async function getSupportedCapabilities(): Promise<NativeCapabilitySnapshot> {
  if (Platform.OS !== "android" || !nativeModule) {
    return {
      nfc: false,
      bleCentral: false,
      blePeripheral: false,
      attestation: false,
      hce: false,
      platform: Platform.OS,
    };
  }

  return nativeModule.getSupportedCapabilities();
}

export async function getBackgroundRuntimeStatus(): Promise<NativeBackgroundRuntimeStatus> {
  if (Platform.OS !== "android" || !nativeModule) {
    return {
      supported: false,
      backgroundServiceRunning: false,
      overlayPermissionGranted: false,
      overlayVisible: false,
      bluetoothEnabled: false,
      nfcEnabled: false,
    };
  }

  return nativeModule.getBackgroundRuntimeStatus();
}

export async function startBackgroundRuntime(): Promise<NativeBackgroundRuntimeStatus> {
  return ensureNativeModule().startBackgroundRuntime();
}

export async function stopBackgroundRuntime(): Promise<NativeBackgroundRuntimeStatus> {
  if (Platform.OS !== "android" || !nativeModule) {
    return getBackgroundRuntimeStatus();
  }

  return nativeModule.stopBackgroundRuntime();
}

export async function requestOverlayPermission(): Promise<NativeBackgroundRuntimeStatus> {
  return ensureNativeModule().requestOverlayPermission();
}

export async function showOverlay(): Promise<NativeBackgroundRuntimeStatus> {
  return ensureNativeModule().showOverlay();
}

export async function hideOverlay(): Promise<NativeBackgroundRuntimeStatus> {
  if (Platform.OS !== "android" || !nativeModule) {
    return getBackgroundRuntimeStatus();
  }

  return nativeModule.hideOverlay();
}

export async function requestBluetoothEnable(): Promise<NativeBackgroundRuntimeStatus> {
  return ensureNativeModule().requestBluetoothEnable();
}

export async function openBluetoothSettings(): Promise<NativeBackgroundRuntimeStatus> {
  return ensureNativeModule().openBluetoothSettings();
}

export async function openNfcSettings(): Promise<NativeBackgroundRuntimeStatus> {
  return ensureNativeModule().openNfcSettings();
}

export async function getIntegrityManifest(config: {
  appVersion: string;
  policyHash: string;
  attestationChallenge: string;
  bleServiceId: string;
}) {
  return ensureNativeModule().getIntegrityManifest(config);
}

export async function signPayload(payload: string): Promise<string> {
  return ensureNativeModule().signPayload(payload);
}

export async function prepareReceiverSession(config: {
  sessionId: string;
  bootstrapPayload: string;
  transportIds: NativeTransportIds;
}) {
  return ensureNativeModule().prepareReceiverSession(config);
}

export async function publishReceipt(sessionId: string, receiptPayload: string): Promise<void> {
  return ensureNativeModule().publishReceipt(sessionId, receiptPayload);
}

export async function stopReceiverSession(): Promise<void> {
  if (Platform.OS !== "android" || !nativeModule) {
    return;
  }

  await nativeModule.stopReceiverSession();
}

export function isAdbAutomationEnabled(): boolean {
  return Platform.OS === "android" && Boolean(nativeModule?.adbAutomationEnabled);
}

export async function getAdbAutomationEnabled(): Promise<boolean> {
  if (Platform.OS !== "android" || !nativeModule) {
    return false;
  }

  if (nativeModule.getAdbAutomationEnabled) {
    return Boolean(await nativeModule.getAdbAutomationEnabled());
  }

  return Boolean(nativeModule.adbAutomationEnabled);
}
