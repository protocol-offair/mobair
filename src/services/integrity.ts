import * as Application from "expo-application";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";

import type { AllowlistPolicy, DeviceManifest } from "@airpay/shared";
import { buildDeviceReputationAnchor, createNonce, evaluateDeviceIntegrity, sha256Hex } from "@airpay/shared";

import { getIntegrityManifest as getNativeIntegrityManifest } from "./native/AirPayNative";
import type { NativeTransportIds } from "./native/AirPayNative";

const INSTALLATION_SALT_KEY = "airpay.identity.installationSalt.v1";

async function getOrCreateInstallationSalt(): Promise<string> {
  const existing =
    (await SecureStore.getItemAsync(INSTALLATION_SALT_KEY, {
      keychainService: INSTALLATION_SALT_KEY,
    }).catch(() => null)) ?? (await SecureStore.getItemAsync(INSTALLATION_SALT_KEY).catch(() => null));
  if (existing) {
    return existing;
  }

  const salt = createNonce("dra_salt");
  await SecureStore.setItemAsync(INSTALLATION_SALT_KEY, salt, {
    keychainService: INSTALLATION_SALT_KEY,
  }).catch(async () => {
    await SecureStore.setItemAsync(INSTALLATION_SALT_KEY, salt);
  });
  return salt;
}

export async function buildDeviceManifest(policy: AllowlistPolicy): Promise<DeviceManifest> {
  const computedStateRoot = `state-${sha256Hex({
    appVersion: Application.nativeApplicationVersion ?? "0.1.0",
    build: Application.nativeBuildVersion ?? "1",
    packageName: Application.applicationId ?? "com.airpay.wallet",
  }).slice(0, 32)}`;
  const attestationChallenge = sha256Hex({
    policyHash: policy.policyHash,
    packageName: Application.applicationId ?? "com.airpay.wallet",
    build: Application.nativeBuildVersion ?? "1",
  });

  let nativeManifest:
    | Awaited<ReturnType<typeof getNativeIntegrityManifest>>
    | undefined;

  try {
    nativeManifest = await getNativeIntegrityManifest({
      appVersion: Application.nativeApplicationVersion ?? "0.1.0",
      policyHash: policy.policyHash,
      attestationChallenge,
      bleServiceId: getDefaultTransportIds().serviceUuid,
    });
  } catch {
    nativeManifest = undefined;
  }

  const fallbackFingerprintSeed = [
    Application.applicationId,
    Application.nativeBuildVersion,
    Device.brand,
    Device.modelName,
    Device.osBuildFingerprint,
  ]
    .filter(Boolean)
    .join(":");
  const installationSalt = await getOrCreateInstallationSalt();
  const reputationAnchor = buildDeviceReputationAnchor({
    normalizedSignals: {
      appId: Application.applicationId ?? "com.airpay.wallet",
      build: Application.nativeBuildVersion ?? "1",
      keyAlias: nativeManifest?.keyAlias,
      keySecurityLevel: nativeManifest?.keySecurityLevel,
      hardwareBacked: nativeManifest?.isHardwareBacked,
      transportCapabilities: nativeManifest?.transportCapabilities,
      nativeDeviceHash: nativeManifest?.deviceId,
      fallbackDeviceHash: sha256Hex(fallbackFingerprintSeed || "airpay-demo-device"),
    },
    installationSalt,
    policyHash: policy.policyHash,
    epoch: policy.minEpoch,
  });

  const manifest: DeviceManifest = {
    deviceId: nativeManifest?.deviceId ?? sha256Hex(fallbackFingerprintSeed || "airpay-demo-device").slice(0, 24),
    appVersion: Application.nativeApplicationVersion ?? "0.1.0",
    epoch: policy.minEpoch,
    stateRoot: policy.allowedStateRoots[0] ?? computedStateRoot,
    policyHash: policy.policyHash,
    integrityLevel: nativeManifest?.integrityLevel ?? (Device.osName === "Android" && Device.isDevice ? "tee" : "software"),
    attestationValid: nativeManifest?.attestationValid ?? Boolean(Device.isDevice),
    lastOnlineAt: new Date().toISOString(),
    capabilities: ["nfc", "ble", ...((nativeManifest?.attestationValid ?? Device.isDevice) ? (["attestation"] as const) : [])],
    keyAlias: nativeManifest?.keyAlias,
    publicKey: nativeManifest?.publicKey,
    keySecurityLevel: nativeManifest?.keySecurityLevel,
    deviceSecurityLevel: nativeManifest?.deviceSecurityLevel,
    isHardwareBacked: nativeManifest?.isHardwareBacked,
    attestationChallenge: nativeManifest?.attestationChallenge ?? attestationChallenge,
    attestationCertificates: nativeManifest?.attestationCertificates,
    bleServiceId: getDefaultTransportIds().serviceUuid,
    transportCapabilities: nativeManifest?.transportCapabilities,
  };
  const integrity = evaluateDeviceIntegrity(manifest);

  return {
    ...manifest,
    deviceIntegrityScore: integrity.score,
    deviceIntegrityState: integrity.state,
    integrityWarnings: integrity.reasons,
    deviceReputationAnchorHash: reputationAnchor.anchorHash,
    deviceReputationAnchorEpoch: reputationAnchor.epoch,
  };
}

export function getDefaultTransportIds(): NativeTransportIds {
  return {
    serviceUuid: "8d4f0c60-f0f5-4388-a48d-d6e8cb1260fe",
    handshakeCharacteristicUuid: "8d4f0c61-f0f5-4388-a48d-d6e8cb1260fe",
    transferCharacteristicUuid: "8d4f0c62-f0f5-4388-a48d-d6e8cb1260fe",
    receiptCharacteristicUuid: "8d4f0c63-f0f5-4388-a48d-d6e8cb1260fe",
    closeCharacteristicUuid: "8d4f0c64-f0f5-4388-a48d-d6e8cb1260fe",
  };
}
