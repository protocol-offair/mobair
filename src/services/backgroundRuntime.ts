import { PermissionsAndroid, Platform, type Permission } from "react-native";

import {
  AirPayNativeEvents,
  getBackgroundRuntimeStatus,
  getNativeEventEmitter,
  hideOverlay,
  openBluetoothSettings,
  openNfcSettings,
  requestBluetoothEnable,
  requestOverlayPermission,
  showOverlay,
  startBackgroundRuntime,
  stopBackgroundRuntime,
  type NativeBackgroundRuntimeStatus,
  type NativeNetworkAvailableEvent,
} from "./native/AirPayNative";

export type BackgroundRuntimeStatus = NativeBackgroundRuntimeStatus & {
  permissions: Record<string, string>;
};

const FALLBACK_STATUS: BackgroundRuntimeStatus = {
  supported: Platform.OS === "android",
  backgroundServiceRunning: false,
  overlayPermissionGranted: false,
  overlayVisible: false,
  bluetoothEnabled: false,
  nfcEnabled: false,
  permissions: {},
};

function androidSdkVersion(): number {
  return typeof Platform.Version === "number" ? Platform.Version : Number.parseInt(String(Platform.Version), 10) || 0;
}

async function safeStatus(permissions: Record<string, string> = {}): Promise<BackgroundRuntimeStatus> {
  if (Platform.OS !== "android") {
    return { ...FALLBACK_STATUS, permissions };
  }

  try {
    return {
      ...(await getBackgroundRuntimeStatus()),
      permissions,
    };
  } catch {
    return { ...FALLBACK_STATUS, permissions };
  }
}

export async function requestOperationalPermissions(): Promise<Record<string, string>> {
  if (Platform.OS !== "android") {
    return {};
  }

  const sdkVersion = androidSdkVersion();
  const permissions = new Set<Permission>([
    PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ]);

  if (sdkVersion >= 31) {
    permissions.add(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
    permissions.add(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
    permissions.add(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE);
  }

  if (sdkVersion >= 33) {
    permissions.add(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }

  return PermissionsAndroid.requestMultiple(Array.from(permissions));
}

export async function enableBackgroundRuntime(): Promise<BackgroundRuntimeStatus> {
  const permissions = await requestOperationalPermissions();
  if (Platform.OS !== "android") {
    return { ...FALLBACK_STATUS, permissions };
  }

  let status: NativeBackgroundRuntimeStatus = await startBackgroundRuntime().catch(() => getBackgroundRuntimeStatus());

  if (!status.bluetoothEnabled) {
    status = await requestBluetoothEnable().catch(() => status);
  }
  if (!status.nfcEnabled) {
    status = await openNfcSettings().catch(() => status);
  }
  if (!status.overlayPermissionGranted) {
    status = await requestOverlayPermission().catch(() => status);
  } else if (!status.overlayVisible) {
    status = await showOverlay().catch(() => status);
  }

  return {
    ...(await safeStatus(permissions)),
    permissions,
  };
}

export async function disableBackgroundRuntime(): Promise<BackgroundRuntimeStatus> {
  await hideOverlay().catch(() => undefined);
  const status = await stopBackgroundRuntime().catch(() => null);
  return {
    ...(status ?? (await safeStatus())),
    permissions: {},
  };
}

export async function refreshBackgroundRuntimeStatus(): Promise<BackgroundRuntimeStatus> {
  return safeStatus();
}

export async function showBackgroundOverlay(): Promise<BackgroundRuntimeStatus> {
  return {
    ...(await showOverlay()),
    permissions: {},
  };
}

export async function hideBackgroundOverlay(): Promise<BackgroundRuntimeStatus> {
  return {
    ...(await hideOverlay()),
    permissions: {},
  };
}

export async function requestBluetoothActivation(): Promise<BackgroundRuntimeStatus> {
  return {
    ...(await requestBluetoothEnable()),
    permissions: {},
  };
}

export async function openBluetoothControlPanel(): Promise<BackgroundRuntimeStatus> {
  return {
    ...(await openBluetoothSettings()),
    permissions: {},
  };
}

export async function openNfcControlPanel(): Promise<BackgroundRuntimeStatus> {
  return {
    ...(await openNfcSettings()),
    permissions: {},
  };
}

export function subscribeBackgroundRuntimeEvents(input: {
  onNetworkAvailable?: (event: NativeNetworkAvailableEvent) => void;
  onStatus?: (status: NativeBackgroundRuntimeStatus) => void;
}): () => void {
  if (Platform.OS !== "android") {
    return () => undefined;
  }

  try {
    const emitter = getNativeEventEmitter();
    const networkSubscription = emitter.addListener(AirPayNativeEvents.networkAvailable, input.onNetworkAvailable ?? (() => undefined));
    const statusSubscription = emitter.addListener(AirPayNativeEvents.backgroundRuntimeStatus, input.onStatus ?? (() => undefined));
    return () => {
      networkSubscription.remove();
      statusSubscription.remove();
    };
  } catch {
    return () => undefined;
  }
}
