import { Keypair, PublicKey } from "@solana/web3.js";

import {
  DEFAULT_CONVERSION_PROTECTION_FEE_BPS,
  DEFAULT_GATEWAY_FEE_BPS,
  normalizeGatewayPaymentAsset,
  type GatewayPaymentAsset,
} from "./assetConversion";

export type OnlinePaymentRequestSource = "solana-pay" | "airpay-gateway" | "json";
export type OnlinePaymentSettlementMode = "gateway_online" | "gateway_deferred_online";

export interface OnlinePaymentRequest {
  source: OnlinePaymentRequestSource;
  raw: string;
  wallet: string;
  amount: string;
  currency: GatewayPaymentAsset;
  solAmount?: string;
  reference?: string;
  label?: string;
  message?: string;
  memo?: string;
  intentId?: string;
  merchantWallet?: string;
  gatewayFeeBps?: number;
  conversionFeeBps?: number;
  totalFeeBps?: number;
  receiveAmount?: string;
  receiveCurrency?: GatewayPaymentAsset;
  payCurrency?: GatewayPaymentAsset;
  allowedPayCurrencies?: GatewayPaymentAsset[];
  createdAt?: string;
  expiresAt?: string;
  settlementMode?: OnlinePaymentSettlementMode;
  displayAmount?: string;
  displayCurrency?: string;
  displayRateFetchedAt?: string;
}

export interface LocalGatewayPaymentLinkInput {
  merchantWallet: string;
  amount: string | number;
  receiveCurrency?: GatewayPaymentAsset;
  payCurrency?: GatewayPaymentAsset;
  solAmount?: string;
  label?: string;
  message?: string;
  gatewayFeeBps?: number;
  conversionFeeBps?: number;
  totalFeeBps?: number;
  allowedPayCurrencies?: GatewayPaymentAsset[];
  displayAmount?: string;
  displayCurrency?: string;
  displayRateFetchedAt?: string;
  now?: Date;
}

function canonicalPublicKey(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    throw new Error(`${field} is not a valid Solana address.`);
  }
}

function optionalPublicKey(value: unknown, field: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return canonicalPublicKey(value, field);
}

function normalizeAmount(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Amount is required.");
  }

  const normalized = String(value).trim().replace(",", ".");
  if (!/^\d+(\.\d{1,9})?$/.test(normalized)) {
    throw new Error("Amount must be a positive SOL decimal with up to 9 decimals.");
  }
  if (Number(normalized) <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  return normalized.replace(/^0+(?=\d)/, "") || "0";
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function optionalAsset(value: unknown): GatewayPaymentAsset | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return normalizeGatewayPaymentAsset(value);
}

function parseAllowedPayCurrencies(value: unknown): GatewayPaymentAsset[] | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const assets = value
    .split(",")
    .map((item) => normalizeGatewayPaymentAsset(item))
    .filter((item, index, all) => all.indexOf(item) === index);
  return assets.length ? assets : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inferIntentId(params: { memo?: string; message?: string; intentId?: string }): string | undefined {
  if (params.intentId) {
    return params.intentId;
  }
  if (params.memo?.startsWith("pay_")) {
    return params.memo;
  }
  const match = params.message?.match(/\bpay_[A-Za-z0-9]+\b/);
  return match?.[0];
}

function parseSolanaPayUrl(raw: string): OnlinePaymentRequest {
  const payload = raw.trim().slice("solana:".length);
  const [recipientPart, queryPart = ""] = payload.split("?");
  const params = new URLSearchParams(queryPart);
  const wallet = canonicalPublicKey(decodeURIComponent(recipientPart.replace(/^\/+/, "")), "Wallet");
  const amount = normalizeAmount(params.get("amount"));
  const reference = optionalPublicKey(params.get("reference"), "Reference");
  const memo = textValue(params.get("memo"));
  const message = textValue(params.get("message"));
  const label = textValue(params.get("label"));
  const intentId = inferIntentId({ memo, message });

  return {
    source: "solana-pay",
    raw,
    wallet,
    amount,
    currency: "SOL",
    reference,
    label,
    message,
    memo,
    intentId,
  };
}

function parseAirPayUrl(raw: string): OnlinePaymentRequest {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("AirPay payment link is invalid.");
  }

  const params = url.searchParams;
  const currency = normalizeGatewayPaymentAsset(params.get("currency") ?? "SOL");

  const memo = textValue(params.get("memo")) ?? textValue(params.get("intentId"));
  const message = textValue(params.get("message"));
  const intentId = inferIntentId({ memo, message, intentId: textValue(params.get("intentId")) });
  const settlementMode = textValue(params.get("settlementMode")) === "gateway_deferred_online"
    ? "gateway_deferred_online"
    : "gateway_online";
  const merchantWallet = optionalPublicKey(params.get("merchantWallet") ?? params.get("merchant"), "Merchant wallet");

  return {
    source: "airpay-gateway",
    raw,
    wallet: canonicalPublicKey(params.get("wallet") ?? params.get("recipient"), "Wallet"),
    amount: normalizeAmount(params.get("amount")),
    currency,
    solAmount: textValue(params.get("solAmount")),
    reference: optionalPublicKey(params.get("reference"), "Reference"),
    label: textValue(params.get("label")),
    message,
    memo,
    intentId,
    merchantWallet,
    gatewayFeeBps: optionalNumber(params.get("gatewayFeeBps")),
    conversionFeeBps: optionalNumber(params.get("conversionFeeBps")),
    totalFeeBps: optionalNumber(params.get("totalFeeBps")),
    receiveAmount: textValue(params.get("receiveAmount")),
    receiveCurrency: optionalAsset(params.get("receiveCurrency")),
    payCurrency: optionalAsset(params.get("payCurrency")),
    allowedPayCurrencies: parseAllowedPayCurrencies(params.get("allowedPayCurrencies")),
    createdAt: textValue(params.get("createdAt")),
    expiresAt: textValue(params.get("expiresAt")),
    settlementMode,
    displayAmount: textValue(params.get("displayAmount")),
    displayCurrency: textValue(params.get("displayCurrency")),
    displayRateFetchedAt: textValue(params.get("displayRateFetchedAt")),
  };
}

function parseJsonPayload(raw: string): OnlinePaymentRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Payment request is not a supported QR or copied code.");
  }

  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const intent = record?.intent && typeof record.intent === "object" ? (record.intent as Record<string, unknown>) : record;
  if (!intent) {
    throw new Error("Payment request JSON is empty.");
  }

  const solanaPayUrl = textValue(intent.solanaPayUrl) ?? textValue(intent.solana_pay_url) ?? textValue(intent.qrCode) ?? textValue(intent.qr_code);
  if (solanaPayUrl?.startsWith("solana:")) {
    const request = parseSolanaPayUrl(solanaPayUrl);
    const intentId = textValue(intent.intentId) ?? textValue(intent.intent_id) ?? request.intentId;
    return {
      ...request,
      source: "json",
      raw,
      intentId,
      memo: request.memo ?? intentId,
      label: request.label ?? textValue(intent.label),
    };
  }

  const currency = normalizeGatewayPaymentAsset(intent.currency ?? "SOL");

  const intentId = textValue(intent.intentId) ?? textValue(intent.intent_id);
  const memo = textValue(intent.memo) ?? intentId;
  const message = textValue(intent.message);
  const merchantWallet = optionalPublicKey(intent.merchantWallet ?? intent.merchant_wallet ?? intent.merchant, "Merchant wallet");

  return {
    source: "json",
    raw,
    wallet: canonicalPublicKey(intent.wallet ?? intent.recipient ?? intent.toAddress ?? intent.to_address, "Wallet"),
    amount: normalizeAmount(intent.amount),
    currency,
    solAmount: textValue(intent.solAmount) ?? textValue(intent.sol_amount),
    reference: optionalPublicKey(intent.reference, "Reference"),
    label: textValue(intent.label),
    message,
    memo,
    intentId: inferIntentId({ memo, message, intentId }),
    merchantWallet,
    gatewayFeeBps: optionalNumber(intent.gatewayFeeBps ?? intent.gateway_fee_bps),
    conversionFeeBps: optionalNumber(intent.conversionFeeBps ?? intent.conversion_fee_bps),
    totalFeeBps: optionalNumber(intent.totalFeeBps ?? intent.total_fee_bps),
    receiveAmount: textValue(intent.receiveAmount) ?? textValue(intent.receive_amount),
    receiveCurrency: optionalAsset(intent.receiveCurrency ?? intent.receive_currency),
    payCurrency: optionalAsset(intent.payCurrency ?? intent.pay_currency),
    allowedPayCurrencies:
      Array.isArray(intent.allowedPayCurrencies)
        ? intent.allowedPayCurrencies.map((asset) => normalizeGatewayPaymentAsset(asset)).filter((asset, index, all) => all.indexOf(asset) === index)
        : parseAllowedPayCurrencies(intent.allowedPayCurrencies ?? intent.allowed_pay_currencies),
    createdAt: textValue(intent.createdAt) ?? textValue(intent.created_at),
    expiresAt: textValue(intent.expiresAt) ?? textValue(intent.expires_at),
    settlementMode:
      textValue(intent.settlementMode) === "gateway_deferred_online" ||
      textValue(intent.settlement_mode) === "gateway_deferred_online"
        ? "gateway_deferred_online"
        : undefined,
    displayAmount: textValue(intent.displayAmount) ?? textValue(intent.display_amount),
    displayCurrency: textValue(intent.displayCurrency) ?? textValue(intent.display_currency),
    displayRateFetchedAt: textValue(intent.displayRateFetchedAt) ?? textValue(intent.display_rate_fetched_at),
  };
}

export function parseOnlinePaymentRequest(raw: string): OnlinePaymentRequest {
  const normalized = raw.trim();
  if (!normalized) {
    throw new Error("Paste or scan a payment request first.");
  }

  if (normalized.startsWith("solana:")) {
    return parseSolanaPayUrl(normalized);
  }
  if (normalized.startsWith("airpay://pay")) {
    return parseAirPayUrl(normalized);
  }
  return parseJsonPayload(normalized);
}

export function paymentRequestMemo(request: OnlinePaymentRequest): string | undefined {
  return request.memo ?? request.intentId ?? request.reference;
}

function createLocalIntentId(now: Date): string {
  const timestamp = now.getTime().toString(36);
  const random = Keypair.generate().publicKey.toBase58().replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
  return `pay_local_${timestamp}_${random}`;
}

export function buildLocalGatewayPaymentLink(input: LocalGatewayPaymentLinkInput): OnlinePaymentRequest {
  const now = input.now ?? new Date();
  const merchantWallet = canonicalPublicKey(input.merchantWallet, "Merchant wallet");
  const amount = normalizeAmount(input.amount);
  const receiveCurrency = input.receiveCurrency ?? "SOL";
  const payCurrency = input.payCurrency ?? "SOL";
  const solAmount = input.solAmount ? normalizeAmount(input.solAmount) : receiveCurrency === "SOL" ? amount : amount;
  const intentId = createLocalIntentId(now);
  const reference = Keypair.generate().publicKey.toBase58();
  const gatewayFeeBps = input.gatewayFeeBps ?? DEFAULT_GATEWAY_FEE_BPS;
  const conversionFeeBps = input.conversionFeeBps ?? DEFAULT_CONVERSION_PROTECTION_FEE_BPS;
  const allowedPayCurrencies = input.allowedPayCurrencies ?? ["SOL", "USDC", "USDT", "BRZ", "OFFAIR"];
  const label = textValue(input.label) ?? "AirPay merchant";
  const message = textValue(input.message) ?? `AirPay Gateway deferred payment ${intentId}`;

  const params = new URLSearchParams({
    intentId,
    wallet: merchantWallet,
    merchantWallet,
    amount,
    currency: payCurrency,
    solAmount,
    receiveAmount: amount,
    receiveCurrency,
    payCurrency,
    reference,
    label,
    message,
    memo: intentId,
    settlementMode: "gateway_deferred_online",
    gatewayFeeBps: String(gatewayFeeBps),
    conversionFeeBps: String(conversionFeeBps),
    totalFeeBps: String(gatewayFeeBps + (payCurrency === receiveCurrency && payCurrency === "SOL" ? 0 : conversionFeeBps)),
    allowedPayCurrencies: allowedPayCurrencies.join(","),
    createdAt: now.toISOString(),
  });

  if (input.displayAmount) {
    params.set("displayAmount", input.displayAmount);
  }
  if (input.displayCurrency) {
    params.set("displayCurrency", input.displayCurrency);
  }
  if (input.displayRateFetchedAt) {
    params.set("displayRateFetchedAt", input.displayRateFetchedAt);
  }

  const raw = `airpay://pay?${params.toString()}`;
  return {
    source: "airpay-gateway",
    raw,
    wallet: merchantWallet,
    amount,
    currency: payCurrency,
    solAmount,
    reference,
    label,
    message,
    memo: intentId,
    intentId,
    merchantWallet,
    gatewayFeeBps,
    conversionFeeBps,
    totalFeeBps: gatewayFeeBps + (payCurrency === receiveCurrency && payCurrency === "SOL" ? 0 : conversionFeeBps),
    receiveAmount: amount,
    receiveCurrency,
    payCurrency,
    allowedPayCurrencies,
    createdAt: now.toISOString(),
    settlementMode: "gateway_deferred_online",
    displayAmount: input.displayAmount,
    displayCurrency: input.displayCurrency,
    displayRateFetchedAt: input.displayRateFetchedAt,
  };
}
