import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLocales } from "expo-localization";

import { messages, type SupportedLocale, type TranslationKey } from "./messages";
export type { SupportedLocale, TranslationKey } from "./messages";

const LOCALE_STORAGE_KEY = "airpay.locale";
const defaultLocale: SupportedLocale = "pt-BR";

let currentLocale: SupportedLocale = resolveDeviceLocale();
const listeners = new Set<(locale: SupportedLocale) => void>();

function resolveDeviceLocale(): SupportedLocale {
  const preferred = getLocales()[0]?.languageTag ?? defaultLocale;
  return normalizeLocale(preferred);
}

function resolveDeviceFormatLocale(): string {
  return getLocales()[0]?.languageTag ?? defaultLocale;
}

export function normalizeLocale(locale?: string | null): SupportedLocale {
  if (!locale) {
    return defaultLocale;
  }

  return locale.toLowerCase().startsWith("pt") ? "pt-BR" : "en";
}

function getTemplate(key: string, locale = currentLocale): string {
  const scoped = messages[locale] as Record<string, string>;
  const fallback = messages.en as Record<string, string>;
  return scoped[key] ?? fallback[key] ?? key;
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) {
    return template;
  }

  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === null || value === undefined) {
      return "";
    }
    return String(value);
  });
}

export function t(key: TranslationKey | string, params?: Record<string, unknown>): string {
  return interpolate(getTemplate(key), params);
}

export function translate(key: TranslationKey | string, params?: Record<string, unknown>): string {
  return t(key, params);
}

export function getCurrentLocale(): SupportedLocale {
  return currentLocale;
}

export async function initializeLocale(): Promise<SupportedLocale> {
  const stored = await AsyncStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored) {
    currentLocale = normalizeLocale(stored);
  }
  return currentLocale;
}

export async function setCurrentLocale(locale: SupportedLocale): Promise<void> {
  currentLocale = normalizeLocale(locale);
  await AsyncStorage.setItem(LOCALE_STORAGE_KEY, currentLocale);
  listeners.forEach((listener) => listener(currentLocale));
}

export function subscribeLocale(listener: (locale: SupportedLocale) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function formatDateTime(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(resolveDeviceFormatLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
    ...options,
  }).format(date);
}

export function formatDateOnly(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(resolveDeviceFormatLocale(), {
    dateStyle: "medium",
    ...options,
  }).format(date);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentLocale, options).format(value);
}

function assetMaxFractionDigits(assetId?: string): number {
  switch (assetId?.toUpperCase()) {
    case "SOL":
      return 9;
    case "OFFAIR":
    case "AIR":
      return 6;
    default:
      return 8;
  }
}

export function formatAssetAmount(value: number | string, assetId?: string): string {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }

  const absoluteValue = Math.abs(numeric);
  const maximumFractionDigits = assetMaxFractionDigits(assetId);
  if (absoluteValue === 0) {
    return formatNumber(0, { maximumFractionDigits: 0 });
  }

  const minimumVisibleUnit = 10 ** -maximumFractionDigits;
  if (absoluteValue < minimumVisibleUnit) {
    return formatNumber(numeric, {
      notation: "scientific",
      maximumFractionDigits: 3,
    });
  }

  if (absoluteValue >= 100) {
    return formatNumber(numeric, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  if (absoluteValue >= 1) {
    return formatNumber(numeric, {
      minimumFractionDigits: 2,
      maximumFractionDigits: Math.min(maximumFractionDigits, 4),
    });
  }

  return formatNumber(numeric, {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}

export function formatDecimalString(value: string, options?: Intl.NumberFormatOptions): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value;
  }
  return formatNumber(numeric, options);
}
