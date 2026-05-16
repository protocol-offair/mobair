import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

import { postMaybeSecureJson } from "./transportSecurity";

const DIAGNOSTICS_STORAGE_KEY = "airpay.diagnostics.entries";
const DIAGNOSTICS_DEVICE_ID_STORAGE_KEY = "airpay.diagnostics.deviceId";
const MAX_DIAGNOSTIC_ENTRIES = 200;
const SENSITIVE_KEY_PATTERN =
  /(mnemonic|secret|private|signature|signed|certificate|cert|pfx|attestation|public[_-]?key|post[_-]?quantum|digest|encrypted|issuer_signature|ack_signature|serialized_transaction|password|challenge)/i;
const SENSITIVE_TOKEN_PATTERN = /([A-Za-z0-9+/_=-]{24,})/g;

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticLogEntry {
  entryId: string;
  level: DiagnosticLevel;
  category: string;
  message: string;
  context: Record<string, unknown>;
  createdAt: string;
}

interface RuntimeExtraConfig {
  backendUrl?: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildEntryId(): string {
  return `diag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function getBackendUrl(): string | undefined {
  const extra = (Constants.expoConfig?.extra ?? {}) as RuntimeExtraConfig;
  return extra.backendUrl;
}

function sanitizeMessage(message: string): string {
  return message.replace(SENSITIVE_TOKEN_PATTERN, "[redacted]");
}

function sanitizeUnknown(value: unknown, parentKey?: string): unknown {
  if (parentKey && SENSITIVE_KEY_PATTERN.test(parentKey)) {
    return "[redacted]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        sanitizeUnknown(nestedValue, key),
      ]),
    );
  }

  if (typeof value === "string") {
    return sanitizeMessage(value);
  }

  return value;
}

function sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> {
  if (!context) {
    return {};
  }

  try {
    return sanitizeUnknown(JSON.parse(JSON.stringify(context))) as Record<string, unknown>;
  } catch {
    return {
      serializationError: "Context could not be serialized.",
    };
  }
}

function normalizeCancelledMessage(message: string): string {
  if (!message.toLowerCase().includes("operation was cancelled")) {
    return sanitizeMessage(message);
  }

  return sanitizeMessage(
    "Operation was cancelled. The NFC/BLE session was interrupted, the receiver stopped advertising, the app lost focus, or Android aborted the transport request.",
  );
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return normalizeCancelledMessage(error.message);
  }
  return normalizeCancelledMessage(String(error));
}

async function loadEntries(): Promise<DiagnosticLogEntry[]> {
  const raw = await AsyncStorage.getItem(DIAGNOSTICS_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as DiagnosticLogEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveEntries(entries: DiagnosticLogEntry[]): Promise<void> {
  await AsyncStorage.setItem(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_DIAGNOSTIC_ENTRIES)));
}

export async function rememberDiagnosticDeviceId(deviceId: string): Promise<void> {
  const normalized = deviceId.trim();
  if (!normalized) {
    return;
  }
  await AsyncStorage.setItem(DIAGNOSTICS_DEVICE_ID_STORAGE_KEY, normalized);
}

export async function loadRememberedDiagnosticDeviceId(): Promise<string | null> {
  const stored = await AsyncStorage.getItem(DIAGNOSTICS_DEVICE_ID_STORAGE_KEY);
  if (!stored) {
    return null;
  }
  const normalized = stored.trim();
  return normalized ? normalized : null;
}

export async function recordDiagnostic(input: {
  level: DiagnosticLevel;
  category: string;
  message: string;
  context?: Record<string, unknown>;
  createdAt?: string;
}): Promise<DiagnosticLogEntry> {
  const entry: DiagnosticLogEntry = {
    entryId: buildEntryId(),
    level: input.level,
    category: input.category,
    message: normalizeCancelledMessage(input.message),
    context: sanitizeContext(input.context),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  const existing = await loadEntries();
  await saveEntries([entry, ...existing]);
  return entry;
}

export async function recordDiagnosticError(
  category: string,
  error: unknown,
  context?: Record<string, unknown>,
): Promise<DiagnosticLogEntry> {
  return recordDiagnostic({
    level: "error",
    category,
    message: normalizeErrorMessage(error),
    context: {
      ...sanitizeContext(context),
      rawError: sanitizeMessage(error instanceof Error ? error.message : String(error)),
    },
  });
}

export async function listDiagnosticEntries(): Promise<DiagnosticLogEntry[]> {
  return loadEntries();
}

export async function flushDiagnosticEntries(deviceId: string): Promise<number> {
  const backendUrl = getBackendUrl();
  if (!backendUrl) {
    return 0;
  }

  const entries = await loadEntries();
  if (entries.length === 0) {
    return 0;
  }

  await rememberDiagnosticDeviceId(deviceId);

  const payload = await postMaybeSecureJson<{
    accepted_entry_ids?: string[];
  }>({
    url: `${trimTrailingSlash(backendUrl)}/logs/device`,
    context: "logs.device.ingest",
    payload: {
      device_id: deviceId,
      entries: entries.map((entry) => ({
        entry_id: entry.entryId,
        level: entry.level,
        category: entry.category,
        message: entry.message,
        context: entry.context,
        created_at: entry.createdAt,
      })),
    },
  });
  const acceptedIds = new Set(payload.accepted_entry_ids ?? []);

  if (acceptedIds.size === 0) {
    return 0;
  }

  await saveEntries(entries.filter((entry) => !acceptedIds.has(entry.entryId)));
  return acceptedIds.size;
}

export async function flushRememberedDiagnosticEntries(): Promise<number> {
  const rememberedDeviceId = await loadRememberedDiagnosticDeviceId();
  if (!rememberedDeviceId) {
    return 0;
  }

  return flushDiagnosticEntries(rememberedDeviceId);
}
