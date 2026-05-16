import { canonicalStringify, sha256Hex } from "@airpay/shared";

import { signWalletMessage } from "./custody";

const CLIENT_SIGNATURE_VERSION = "1";

export interface ClientRequestSignatureInput {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  context: string;
  payload: unknown;
  deviceId?: string;
  walletId?: string;
}

function normalizePayload(payload: unknown): unknown {
  if (payload === undefined) {
    return null;
  }

  const serialized = JSON.stringify(payload);
  return serialized ? JSON.parse(serialized) : null;
}

function pathAndQueryFromUrl(url: string): string {
  const match = url.match(/^https?:\/\/[^/]+(\/.*)?$/i);
  return match?.[1] ?? "/";
}

export function buildClientSignatureMessage(input: {
  method: string;
  pathAndQuery: string;
  context: string;
  bodyHash: string;
  timestamp: string;
  deviceId?: string;
  walletId?: string;
}): string {
  return canonicalStringify({
    bodyHash: input.bodyHash,
    context: input.context,
    deviceId: input.deviceId ?? null,
    method: input.method.toUpperCase(),
    path: input.pathAndQuery,
    timestamp: input.timestamp,
    version: Number(CLIENT_SIGNATURE_VERSION),
    walletId: input.walletId ?? null,
  });
}

export async function buildClientSignatureHeaders(input: ClientRequestSignatureInput): Promise<Record<string, string>> {
  const timestamp = new Date().toISOString();
  const normalizedPayload = normalizePayload(input.payload);
  const bodyHash = sha256Hex(canonicalStringify(normalizedPayload));
  const pathAndQuery = pathAndQueryFromUrl(input.url);
  const signedMessage = buildClientSignatureMessage({
    method: input.method,
    pathAndQuery,
    context: `${input.context}.request`,
    bodyHash,
    timestamp,
    deviceId: input.deviceId,
    walletId: input.walletId,
  });
  const walletSignature = await signWalletMessage(signedMessage, input.walletId);

  return {
    "X-AirPay-Signature-Version": CLIENT_SIGNATURE_VERSION,
    "X-AirPay-Timestamp": timestamp,
    "X-AirPay-Request-Context": `${input.context}.request`,
    "X-AirPay-Request-Hash": bodyHash,
    "X-AirPay-Wallet-Public-Key": walletSignature.publicKey,
    "X-AirPay-Request-Signature": walletSignature.signature,
    ...(input.deviceId ? { "X-AirPay-Device-Id": input.deviceId } : {}),
    ...(input.walletId ? { "X-AirPay-Wallet-Id": input.walletId } : {}),
  };
}
