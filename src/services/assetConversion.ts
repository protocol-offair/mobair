import type { SolReferenceRates } from "./valueApproximation";

export type GatewayPaymentAsset = "SOL" | "USDC" | "USDT" | "BRZ" | "OFFAIR";

export const GATEWAY_PAYMENT_ASSETS: GatewayPaymentAsset[] = ["SOL", "USDC", "USDT", "BRZ", "OFFAIR"];
export const DEFAULT_GATEWAY_FEE_BPS = 70;
export const DEFAULT_CONVERSION_PROTECTION_FEE_BPS = 180;

export interface AssetConversionQuote {
  receiveAmount: string;
  receiveAsset: GatewayPaymentAsset;
  payAsset: GatewayPaymentAsset;
  payAmount: string;
  solAmount: string;
  gatewayFeeBps: number;
  conversionFeeBps: number;
  totalFeeBps: number;
  route: "direct_sol" | "quoted_conversion" | "offair_via_sol";
  rateFetchedAt?: string;
}

function normalizeAmount(value: string | number): number | null {
  const normalized = String(value).trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function formatDecimal(value: number, decimals = 9): string {
  const fixed = value.toFixed(decimals);
  return fixed.replace(/\.?0+$/, "") || "0";
}

function assetToSol(amount: number, asset: GatewayPaymentAsset, rates: SolReferenceRates): number {
  switch (asset) {
    case "SOL":
    case "OFFAIR":
      return amount;
    case "USDC":
    case "USDT":
      return amount / rates.solUsd;
    case "BRZ":
      return amount / rates.solBrl;
  }
}

function solToAsset(amountSol: number, asset: GatewayPaymentAsset, rates: SolReferenceRates): number {
  switch (asset) {
    case "SOL":
    case "OFFAIR":
      return amountSol;
    case "USDC":
    case "USDT":
      return amountSol * rates.solUsd;
    case "BRZ":
      return amountSol * rates.solBrl;
  }
}

function canQuoteWithoutMarketRates(receiveAsset: GatewayPaymentAsset, payAsset: GatewayPaymentAsset): boolean {
  const solEquivalentAssets: GatewayPaymentAsset[] = ["SOL", "OFFAIR"];
  return solEquivalentAssets.includes(receiveAsset) && solEquivalentAssets.includes(payAsset);
}

export function normalizeGatewayPaymentAsset(value: unknown): GatewayPaymentAsset {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!normalized) {
    return "SOL";
  }
  if (!GATEWAY_PAYMENT_ASSETS.includes(normalized as GatewayPaymentAsset)) {
    throw new Error(`Unsupported gateway payment asset: ${normalized}.`);
  }
  return normalized as GatewayPaymentAsset;
}

export function quoteGatewayAssetConversion(input: {
  receiveAmount: string | number;
  receiveAsset: GatewayPaymentAsset;
  payAsset: GatewayPaymentAsset;
  rates: SolReferenceRates | null;
  gatewayFeeBps?: number;
  conversionFeeBps?: number;
}): AssetConversionQuote | null {
  if (!input.rates && !canQuoteWithoutMarketRates(input.receiveAsset, input.payAsset)) {
    return null;
  }

  const receiveAmount = normalizeAmount(input.receiveAmount);
  if (!receiveAmount) {
    return null;
  }

  const gatewayFeeBps = input.gatewayFeeBps ?? DEFAULT_GATEWAY_FEE_BPS;
  const route =
    input.receiveAsset === "OFFAIR" || input.payAsset === "OFFAIR"
      ? "offair_via_sol"
      : input.receiveAsset === "SOL" && input.payAsset === "SOL"
        ? "direct_sol"
        : "quoted_conversion";
  const conversionFeeBps =
    route === "direct_sol" ? 0 : input.conversionFeeBps ?? DEFAULT_CONVERSION_PROTECTION_FEE_BPS;
  const totalFeeBps = gatewayFeeBps + conversionFeeBps;
  const rates = input.rates ?? {
    solUsd: 1,
    solBrl: 1,
    fetchedAt: new Date(0).toISOString(),
    source: "coingecko" as const,
  };
  const merchantSolEquivalent = assetToSol(receiveAmount, input.receiveAsset, rates);
  const payerSolEquivalent =
    route === "direct_sol" ? merchantSolEquivalent : merchantSolEquivalent * (1 + totalFeeBps / 10_000);
  const payAmount = solToAsset(payerSolEquivalent, input.payAsset, rates);

  return {
    receiveAmount: formatDecimal(receiveAmount),
    receiveAsset: input.receiveAsset,
    payAsset: input.payAsset,
    payAmount: formatDecimal(payAmount, input.payAsset === "BRZ" ? 2 : 9),
    solAmount: formatDecimal(payerSolEquivalent),
    gatewayFeeBps,
    conversionFeeBps,
    totalFeeBps,
    route,
    rateFetchedAt: input.rates?.fetchedAt,
  };
}
