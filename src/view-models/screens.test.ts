import { describe, expect, it, vi } from "vitest";

import type { WalletState } from "../services/wallet";
import { buildActivityItems } from "./screens";

vi.mock("../i18n", () => ({
  formatDateTime: (value: string) => value,
  formatAssetAmount: (value: number | string) => String(value),
  formatNumber: (value: number | string) => String(value),
  translate: (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

function walletWithActivity(): WalletState {
  return {
    manifest: {
      deviceId: "receiver-device",
    },
    journal: [
      {
        localTxId: "old-journal",
        sessionId: "session-old",
        senderPseudoId: "sender-old",
        receiverPseudoId: "receiver-device",
        assetId: "SOL",
        amount: 0.01,
        voucherIds: [],
        prevTxHash: "prev-old",
        counter: 1,
        epoch: 1,
        policyHash: "policy",
        peerProofDigest: "proof",
        createdAt: "2026-05-15T10:00:00.000Z",
        encryptedPayload: "payload",
        settlementStatus: "pending",
        risk: {
          score: 0,
          band: "trusted",
          reasons: [],
          computedAt: "2026-05-15T10:00:00.000Z",
        },
        signature: "signature",
        txHash: "hash-old",
      },
      {
        localTxId: "new-journal",
        sessionId: "session-new",
        senderPseudoId: "sender-new",
        receiverPseudoId: "receiver-device",
        assetId: "SOL",
        amount: 0.02,
        voucherIds: [],
        prevTxHash: "prev-new",
        counter: 2,
        epoch: 1,
        policyHash: "policy",
        peerProofDigest: "proof",
        createdAt: "2026-05-15T12:00:00.000Z",
        encryptedPayload: "payload",
        settlementStatus: "pending",
        risk: {
          score: 0,
          band: "trusted",
          reasons: [],
          computedAt: "2026-05-15T12:00:00.000Z",
        },
        signature: "signature",
        txHash: "hash-new",
      },
    ],
    pendingChainTransactions: [
      {
        intent: {
          intentId: "middle-chain",
          fromAddress: "from",
          toAddress: "to",
          amount: "0.03",
          assetId: "SOL",
          decimals: 9,
          createdAt: "2026-05-15T11:00:00.000Z",
          requiresOnlineAssembly: false,
        },
        envelope: {
          intentId: "middle-chain",
          publicKey: "public-key",
          signedMessage: "message",
          signature: "signature",
          signedAt: "2026-05-15T11:00:00.000Z",
        },
        status: "queued",
      },
    ],
  } as unknown as WalletState;
}

describe("buildActivityItems", () => {
  it("orders recent activity newest first across journal and chain items", () => {
    expect(buildActivityItems(walletWithActivity()).map((item) => item.id)).toEqual([
      "new-journal",
      "middle-chain",
      "old-journal",
    ]);
  });
});
