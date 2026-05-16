import AsyncStorage from "@react-native-async-storage/async-storage";

import { formatDateTime, formatNumber } from "../i18n";

export type ApproximationAsset = "USDC" | "USDT" | "BRZ";

export interface ValueApproximationPreferences {
  enabled: boolean;
  asset: ApproximationAsset;
}

export interface SolReferenceRates {
  solUsd: number;
  solBrl: number;
  fetchedAt: string;
  source: "coingecko";
}

export interface ValueApproximationDisplayState {
  preferences: ValueApproximationPreferences;
  rates: SolReferenceRates | null;
}

const PREFERENCES_STORAGE_KEY = "airpay.valueApproximation.preferences.v1";
const RATES_STORAGE_KEY = "airpay.valueApproximation.solRates.v1";

export const DEFAULT_VALUE_APPROXIMATION_PREFERENCES: ValueApproximationPreferences = {
  enabled: false,
  asset: "USDC",
};

export const APPROXIMATION_ASSETS: ApproximationAsset[] = ["USDC", "USDT", "BRZ"];

function normalizeAsset(asset: unknown): ApproximationAsset {
  return APPROXIMATION_ASSETS.includes(asset as ApproximationAsset) ? (asset as ApproximationAsset) : "USDC";
}

function normalizePreferences(input: unknown): ValueApproximationPreferences {
  if (!input || typeof input !== "object") {
    return DEFAULT_VALUE_APPROXIMATION_PREFERENCES;
  }

  const record = input as Partial<ValueApproximationPreferences>;
  return {
    enabled: record.enabled === true,
    asset: normalizeAsset(record.asset),
  };
}

function normalizeRates(input: unknown): SolReferenceRates | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Partial<SolReferenceRates>;
  const solUsd = Number(record.solUsd);
  const solBrl = Number(record.solBrl);
  const fetchedAt = typeof record.fetchedAt === "string" ? record.fetchedAt : "";

  if (!Number.isFinite(solUsd) || solUsd <= 0 || !Number.isFinite(solBrl) || solBrl <= 0 || !fetchedAt) {
    return null;
  }

  return {
    solUsd,
    solBrl,
    fetchedAt,
    source: "coingecko",
  };
}

export async function loadValueApproximationPreferences(): Promise<ValueApproximationPreferences> {
  const raw = await AsyncStorage.getItem(PREFERENCES_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_VALUE_APPROXIMATION_PREFERENCES;
  }

  try {
    return normalizePreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_VALUE_APPROXIMATION_PREFERENCES;
  }
}

export async function saveValueApproximationPreferences(preferences: ValueApproximationPreferences): Promise<void> {
  await AsyncStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(normalizePreferences(preferences)));
}

export async function loadSolReferenceRates(): Promise<SolReferenceRates | null> {
  const raw = await AsyncStorage.getItem(RATES_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return normalizeRates(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveSolReferenceRates(rates: SolReferenceRates): Promise<void> {
  await AsyncStorage.setItem(RATES_STORAGE_KEY, JSON.stringify(rates));
}

export async function fetchSolReferenceRates(): Promise<SolReferenceRates> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,brl", {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = (await response.json()) as { solana?: { usd?: unknown; brl?: unknown } };
    const solUsd = Number(body.solana?.usd);
    const solBrl = Number(body.solana?.brl);
    if (!Number.isFinite(solUsd) || solUsd <= 0 || !Number.isFinite(solBrl) || solBrl <= 0) {
      throw new Error("invalid SOL reference response");
    }

    return {
      solUsd,
      solBrl,
      fetchedAt: new Date().toISOString(),
      source: "coingecko",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isSolLikeAsset(assetId?: string): boolean {
  const normalized = assetId?.toUpperCase();
  return normalized === "SOL" || normalized === "OFFAIR" || normalized === "AIR";
}

function resolveRate(asset: ApproximationAsset, rates: SolReferenceRates): number {
  return asset === "BRZ" ? rates.solBrl : rates.solUsd;
}

function normalizePositiveDecimal(value: string | number): number | null {
  const normalized = String(value).trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function trimSolDecimal(value: number): string | null {
  const fixed = value.toFixed(9);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed === "0" ? null : trimmed;
}

function formatApproximationNumber(value: number): string {
  const absoluteValue = Math.abs(value);

  if (absoluteValue > 0 && absoluteValue < 0.000001) {
    return formatNumber(value, {
      notation: "scientific",
      maximumFractionDigits: 3,
    });
  }

  if (absoluteValue < 1) {
    return formatNumber(value, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    });
  }

  if (absoluteValue < 100) {
    return formatNumber(value, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }

  return formatNumber(value, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatApproximateAssetAmount(
  amount: number | string,
  assetId: string | undefined,
  state: ValueApproximationDisplayState,
): string | null {
  if (!state.preferences.enabled || !state.rates || !isSolLikeAsset(assetId)) {
    return null;
  }

  const numericAmount = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(numericAmount)) {
    return null;
  }

  const asset = state.preferences.asset;
  const estimate = numericAmount * resolveRate(asset, state.rates);
  if (!Number.isFinite(estimate)) {
    return null;
  }

  return `≈ ${formatApproximationNumber(estimate)} ${asset}`;
}

export function convertReferenceAmountToSol(
  amount: number | string,
  state: ValueApproximationDisplayState,
): string | null {
  if (!state.preferences.enabled || !state.rates) {
    return null;
  }

  const referenceAmount = normalizePositiveDecimal(amount);
  if (!referenceAmount) {
    return null;
  }

  const rate = resolveRate(state.preferences.asset, state.rates);
  const solAmount = referenceAmount / rate;
  if (!Number.isFinite(solAmount) || solAmount <= 0) {
    return null;
  }

  return trimSolDecimal(solAmount);
}

export function formatApproximationUpdatedAt(rates: SolReferenceRates | null): string {
  return rates ? formatDateTime(rates.fetchedAt) : "--";
}
