import Constants from "expo-constants";
import { sha256Hex } from "@protocol-offair/shared";
import type {
  AssetBalance,
  PendingChainTransaction,
} from "@protocol-offair/shared";

import { recordDiagnostic, recordDiagnosticError } from "./diagnostics";
import { buildClientSignatureHeaders } from "./clientSignature";
import { postMaybeSecureJson } from "./transportSecurity";
import { translate } from "../i18n";

interface RuntimeExtraConfig {
  backendUrl?: string;
  backendTransportPublicKey?: string;
  airMintAddress?: string;
  offairMintAddress?: string;
  airTokenDecimals?: number;
  offairTokenDecimals?: number;
  solanaCluster?: string;
  solanaRpcUrl?: string;
  airpayProgramId?: string;
  mainAuthorityAddress?: string;
}

export interface WalletRuntimeConfig {
  backendUrl?: string;
  backendTransportPublicKey?: string;
  offairMintAddress?: string;
  offairTokenDecimals: number;
  solanaCluster: string;
  solanaRpcUrl: string;
  airpayProgramId?: string;
  mainAuthorityAddress?: string;
}

interface BalancePayload {
  balances?: Array<{
    asset_id?: string;
    assetId?: string;
    amount?: string;
    decimals?: number;
    last_updated_at?: string;
    lastUpdatedAt?: string;
    source?: "cached" | "backend" | "simulated";
  }>;
}

interface BackendSubmitSignedTransactionResponse {
  intent_id: string;
  status: PendingChainTransaction["status"];
  tx_signature?: string | null;
  metadata_anchor_tx?: string | null;
  metadata_payload_hash?: string | null;
  submitted_at?: string | null;
  confirmed_at?: string | null;
  error?: string | null;
}

export interface ChainSubmissionResult {
  status: PendingChainTransaction["status"];
  txSignature?: string;
  metadataAnchorTx?: string;
  metadataPayloadHash?: string;
  submittedAt?: string;
  confirmedAt?: string;
  lastError?: string;
}

export function getWalletRuntimeConfig(): WalletRuntimeConfig {
  const extra = (Constants.expoConfig?.extra ?? {}) as RuntimeExtraConfig;
  return {
    backendUrl: extra.backendUrl,
    backendTransportPublicKey: extra.backendTransportPublicKey,
    offairMintAddress: extra.offairMintAddress ?? extra.airMintAddress,
    offairTokenDecimals: extra.offairTokenDecimals ?? extra.airTokenDecimals ?? 9,
    solanaCluster: extra.solanaCluster ?? "solana-devnet",
    solanaRpcUrl: extra.solanaRpcUrl ?? "https://devnet.rpcpool.com",
    airpayProgramId: extra.airpayProgramId,
    mainAuthorityAddress: extra.mainAuthorityAddress,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRateLimitErrorMessage(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("429") || normalized.includes("too many requests") || normalized.includes("rate limit");
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new Error(
      `Unable to read HTTP response body (${response.status}). ${error instanceof Error ? error.message : "Unknown read error."}`,
    );
  }
}

function previewBody(body: string, maxLength = 220): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}

function parseJsonText<T>(body: string, context: string, response: Response): T {
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    console.error(`[AirPay] ${context} JSON parse failed`, {
      status: response.status,
      contentType: response.headers.get("content-type"),
      bodyPreview: previewBody(body),
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `${context} returned an invalid JSON payload (${response.status}). Body preview: ${previewBody(body) || "<empty>"}`,
    );
  }
}

export async function readJsonResponse<T>(response: Response, context: string): Promise<T> {
  const body = await readResponseText(response);
  if (!body.trim()) {
    console.error(`[AirPay] ${context} returned an empty body`, {
      status: response.status,
      contentType: response.headers.get("content-type"),
    });
    throw new Error(`${context} returned an empty response body (${response.status}).`);
  }

  return parseJsonText<T>(body, context, response);
}

export async function readErrorResponse(response: Response, context: string): Promise<string> {
  const body = await readResponseText(response);
  if (!body.trim()) {
    return `${context} failed with HTTP ${response.status} and an empty response body.`;
  }

  try {
    const parsed = JSON.parse(body) as { detail?: string; error?: string; message?: string };
    return parsed.detail ?? parsed.error ?? parsed.message ?? `${context} failed with HTTP ${response.status}.`;
  } catch {
    return `${context} failed with HTTP ${response.status}. Body: ${previewBody(body)}`;
  }
}

async function callSolanaRpc<T>(runtime: WalletRuntimeConfig, method: string, params: unknown[]): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(runtime.solanaRpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `airpay-${method}`,
          method,
          params,
        }),
      });

      if (response.status === 429) {
        throw new Error(`${method} failed with HTTP 429.`);
      }
      if (!response.ok) {
        throw new Error(await readErrorResponse(response, method));
      }

      const payload = await readJsonResponse<{ result?: T; error?: { message?: string } }>(response, method);
      if (payload.error?.message) {
        throw new Error(payload.error.message);
      }

      return (payload.result ?? null) as T;
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      lastError = normalizedError;
      if (attempt === 4 || !isRateLimitErrorMessage(normalizedError.message)) {
        throw normalizedError;
      }

      await sleep(350 * 2 ** attempt);
    }
  }

  throw lastError ?? new Error(`${method} failed without a concrete error.`);
}

function buildSimulatedBalance(address: string, assetId: "OFFAIR" | "SOL"): AssetBalance {
  const hash = sha256Hex(`${assetId}:${address}`);
  if (assetId === "SOL") {
    const value = ((parseInt(hash.slice(0, 6), 16) % 2500) + 250) / 1000;
    return {
      assetId,
      amount: value.toFixed(3),
      decimals: 9,
      lastUpdatedAt: new Date().toISOString(),
      source: "simulated",
    };
  }

  return {
    assetId,
    amount: "0",
    decimals: 9,
    lastUpdatedAt: new Date().toISOString(),
    source: "cached",
  };
}

function defaultBalances(address: string) {
  return {
    OFFAIR: buildSimulatedBalance(address, "OFFAIR"),
    SOL: buildSimulatedBalance(address, "SOL"),
  } satisfies Record<"OFFAIR" | "SOL", AssetBalance>;
}

function mapBalancePayload(address: string, payload: BalancePayload | null | undefined) {
  const fallback = defaultBalances(address);
  const entries = payload?.balances ?? [];
  if (entries.length === 0) {
    return fallback;
  }

  for (const entry of entries) {
    const assetId = (entry.assetId ?? entry.asset_id) as "OFFAIR" | "AIR" | "SOL" | undefined;
    const normalizedAssetId = assetId === "AIR" ? "OFFAIR" : assetId;
    if (!normalizedAssetId || (normalizedAssetId !== "OFFAIR" && normalizedAssetId !== "SOL")) {
      continue;
    }

    fallback[normalizedAssetId] = {
      assetId: normalizedAssetId,
      amount: entry.amount ?? fallback[normalizedAssetId].amount,
      decimals: entry.decimals ?? fallback[normalizedAssetId].decimals,
      lastUpdatedAt: entry.lastUpdatedAt ?? entry.last_updated_at ?? new Date().toISOString(),
      source: entry.source ?? "backend",
    };
  }

  return fallback;
}

export async function fetchWalletBalances(
  address: string,
  options: {
    fallbackBalances?: Record<"OFFAIR" | "SOL", AssetBalance>;
  } = {},
) {
  const runtime = getWalletRuntimeConfig();
  const fallbackBalances = options.fallbackBalances ?? defaultBalances(address);

  try {
    const [solResponse, tokenResponse] = await Promise.all([
      fetch(runtime.solanaRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "airpay-balance-sol",
          method: "getBalance",
          params: [address, { commitment: "confirmed" }],
        }),
      }),
      runtime.offairMintAddress
        ? fetch(runtime.solanaRpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "airpay-balance-offair",
              method: "getTokenAccountsByOwner",
              params: [
                address,
                { mint: runtime.offairMintAddress },
                {
                  commitment: "confirmed",
                  encoding: "jsonParsed",
                },
              ],
            }),
          })
        : Promise.resolve(null),
    ]);

    const now = new Date().toISOString();
    const nextBalances = {
      ...fallbackBalances,
      SOL: {
        assetId: "SOL" as const,
        amount: fallbackBalances.SOL.amount,
        decimals: 9,
        lastUpdatedAt: now,
        source: "rpc" as const,
      },
      OFFAIR: {
        assetId: "OFFAIR" as const,
        amount: fallbackBalances.OFFAIR.amount,
        decimals: runtime.offairTokenDecimals,
        lastUpdatedAt: now,
        source: "rpc" as const,
      },
    };

    if (solResponse.ok) {
      const payload = await readJsonResponse<{ result?: { value?: number } }>(solResponse, "Solana getBalance");
      const lamports = payload.result?.value ?? 0;
      nextBalances.SOL.amount = `${lamports / 1_000_000_000}`.replace(/\.?0+$/, "") || "0";
    }

    if (tokenResponse?.ok) {
      const payload = await readJsonResponse<{
        result?: {
          value?: Array<{
            account?: {
              data?: {
                parsed?: {
                  info?: {
                    tokenAmount?: {
                      uiAmountString?: string;
                      decimals?: number;
                    };
                  };
                };
              };
            };
          }>;
        };
      }>(tokenResponse, "Solana getTokenAccountsByOwner");
      const account = payload.result?.value?.[0];
      const tokenAmount = account?.account?.data?.parsed?.info?.tokenAmount;
      if (tokenAmount) {
        nextBalances.OFFAIR.amount = tokenAmount.uiAmountString ?? "0";
        nextBalances.OFFAIR.decimals = tokenAmount.decimals ?? runtime.offairTokenDecimals;
      }
    }

    return nextBalances;
  } catch (error) {
    console.warn("[AirPay] fetchWalletBalances failed", error instanceof Error ? error.message : String(error));
    void recordDiagnosticError("solana.balance_fetch", error, { address, rpc: runtime.solanaRpcUrl });
    return fallbackBalances;
  }
}

export async function submitPendingChainTransaction(input: {
  deviceId: string;
  walletId?: string;
  transaction: PendingChainTransaction;
}): Promise<ChainSubmissionResult> {
  const runtime = getWalletRuntimeConfig();
  try {
    const serializedTransaction = input.transaction.envelope.serializedTransaction;
    if (!serializedTransaction) {
      return {
        status: "failed" as const,
        submittedAt: new Date().toISOString(),
        lastError: translate("service.chain.error.submitSigned"),
      };
    }

    if (runtime.backendUrl) {
      try {
        const backendUrl = `${runtime.backendUrl.replace(/\/+$/, "")}/wallet/tx/submit`;
        const requestPayload = {
          device_id: input.deviceId,
          wallet_id: input.walletId,
          intent: {
            intent_id: input.transaction.intent.intentId,
            wallet_id: input.transaction.intent.walletId,
            wallet_type: input.transaction.intent.walletType,
            asset_id: input.transaction.intent.assetId,
            from_address: input.transaction.intent.fromAddress,
            to_address: input.transaction.intent.toAddress,
            amount: input.transaction.intent.amount,
            decimals: input.transaction.intent.decimals,
            created_at: input.transaction.intent.createdAt,
            memo: input.transaction.intent.memo,
            reference: input.transaction.intent.reference,
            recent_blockhash: input.transaction.intent.recentBlockhash,
            token_mint: input.transaction.intent.tokenMint,
            requires_online_assembly: input.transaction.intent.requiresOnlineAssembly,
          },
          signed_envelope: {
            intent_id: input.transaction.envelope.intentId,
            public_key: input.transaction.envelope.publicKey,
            signed_message: input.transaction.envelope.signedMessage,
            signature: input.transaction.envelope.signature,
            signed_at: input.transaction.envelope.signedAt,
            serialized_transaction: serializedTransaction,
          },
        };
        const backendSubmission = await postMaybeSecureJson<BackendSubmitSignedTransactionResponse>({
          url: backendUrl,
          context: "wallet.tx.submit",
          payload: requestPayload,
          headers: input.walletId
            ? await buildClientSignatureHeaders({
                method: "POST",
                url: backendUrl,
                context: "wallet.tx.submit",
                payload: requestPayload,
                deviceId: input.deviceId,
                walletId: input.walletId,
              })
            : undefined,
        });

        return {
          status: backendSubmission.status,
          txSignature: backendSubmission.tx_signature ?? undefined,
          metadataAnchorTx: backendSubmission.metadata_anchor_tx ?? undefined,
          metadataPayloadHash: backendSubmission.metadata_payload_hash ?? undefined,
          submittedAt: backendSubmission.submitted_at ?? new Date().toISOString(),
          confirmedAt: backendSubmission.confirmed_at ?? undefined,
          lastError: backendSubmission.error ?? undefined,
        };
      } catch (backendError) {
        void recordDiagnosticError("backend.chain_submit", backendError, {
          intentId: input.transaction.intent.intentId,
          assetId: input.transaction.intent.assetId,
          backendUrl: runtime.backendUrl,
        });
      }
    }

    const txSignature = await callSolanaRpc<string>(runtime, "sendTransaction", [
      serializedTransaction,
      {
        encoding: "base64",
        preflightCommitment: "confirmed",
      },
    ]);
    return {
      status: "submitted" as const,
      txSignature,
      submittedAt: new Date().toISOString(),
    };
  } catch (error) {
    void recordDiagnosticError("solana.chain_submit", error, {
      intentId: input.transaction.intent.intentId,
      assetId: input.transaction.intent.assetId,
      rpc: runtime.solanaRpcUrl,
    });
    return {
      status: "failed" as const,
      submittedAt: new Date().toISOString(),
      lastError:
        error instanceof Error ? error.message : translate("service.chain.error.submitSigned"),
    };
  }
}

export async function fetchSignatureStatuses(signatures: string[]): Promise<Record<string, "submitted" | "confirmed" | "failed">> {
  const runtime = getWalletRuntimeConfig();
  if (signatures.length === 0) {
    return {};
  }

  try {
    const payload = await callSolanaRpc<{
      value?: Array<{
        err?: unknown;
        confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
      } | null>;
    }>(runtime, "getSignatureStatuses", [signatures, { searchTransactionHistory: true }]);

    return signatures.reduce<Record<string, "submitted" | "confirmed" | "failed">>((accumulator, signature, index) => {
      const status = payload.value?.[index];
      if (!status) {
        accumulator[signature] = "submitted";
      } else if (status.err) {
        accumulator[signature] = "failed";
      } else if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        accumulator[signature] = "confirmed";
      } else {
        accumulator[signature] = "submitted";
      }
      return accumulator;
    }, {});
  } catch (error) {
    void recordDiagnosticError("solana.signature_status", error, {
      count: signatures.length,
      rpc: runtime.solanaRpcUrl,
    });
    return {};
  }
}

export async function fetchLatestBlockhash(): Promise<string | undefined> {
  const runtime = getWalletRuntimeConfig();

  try {
    const response = await fetch(runtime.solanaRpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "airpay-blockhash",
        method: "getLatestBlockhash",
        params: [
          {
            commitment: "confirmed",
          },
        ],
      }),
    });
    if (!response.ok) {
      console.warn("[AirPay] fetchLatestBlockhash returned non-OK status", { status: response.status, rpc: runtime.solanaRpcUrl });
      void recordDiagnostic({
        level: "warn",
        category: "solana.blockhash",
        message: "Solana blockhash fetch returned a non-OK status.",
        context: {
          status: response.status,
          rpc: runtime.solanaRpcUrl,
        },
      });
      return undefined;
    }

    const payload = await readJsonResponse<{
      result?: {
        value?: {
          blockhash?: string;
        };
      };
    }>(response, "Solana getLatestBlockhash");
    return payload.result?.value?.blockhash;
  } catch (error) {
    console.warn("[AirPay] fetchLatestBlockhash failed", error instanceof Error ? error.message : String(error));
    void recordDiagnosticError("solana.blockhash", error, { rpc: runtime.solanaRpcUrl });
    return undefined;
  }
}

export async function probeRpcReachability(): Promise<boolean> {
  return Boolean(await fetchLatestBlockhash());
}
