import { describe, expect, it, vi } from "vitest";

vi.mock("./custody", () => ({
  signWalletMessage: vi.fn(async (message: string, walletId?: string) => ({
    publicKey: "wallet-public-key",
    signature: `signature:${walletId}:${message.length}`,
  })),
}));

import { buildClientSignatureHeaders, buildClientSignatureMessage } from "./clientSignature";
import { signWalletMessage } from "./custody";

describe("client request signatures", () => {
  it("builds deterministic wallet-bound headers for protected backend calls", async () => {
    const headers = await buildClientSignatureHeaders({
      method: "POST",
      url: "https://api.offair.digital-directive.com/wallet/register",
      context: "wallet.register",
      deviceId: "device-1",
      walletId: "wallet-1",
      payload: {
        wallet_id: "wallet-1",
        wallet_public_key: "wallet-public-key",
        ignored: undefined,
      },
    });

    expect(headers["X-AirPay-Signature-Version"]).toBe("1");
    expect(headers["X-AirPay-Request-Context"]).toBe("wallet.register.request");
    expect(headers["X-AirPay-Wallet-Public-Key"]).toBe("wallet-public-key");
    expect(headers["X-AirPay-Device-Id"]).toBe("device-1");
    expect(headers["X-AirPay-Wallet-Id"]).toBe("wallet-1");
    expect(headers["X-AirPay-Request-Hash"]).toMatch(/^[a-f0-9]{64}$/);
    expect(signWalletMessage).toHaveBeenCalledWith(expect.stringContaining("/wallet/register"), "wallet-1");
  });

  it("uses a canonical signed message shape shared with the backend", () => {
    const message = buildClientSignatureMessage({
      method: "post",
      pathAndQuery: "/wallet/tx/submit?x=1",
      context: "wallet.tx.submit.request",
      bodyHash: "abc",
      timestamp: "2026-05-13T10:00:00.000Z",
      deviceId: "device-1",
      walletId: "wallet-1",
    });

    expect(message).toBe(
      '{"bodyHash":"abc","context":"wallet.tx.submit.request","deviceId":"device-1","method":"POST","path":"/wallet/tx/submit?x=1","timestamp":"2026-05-13T10:00:00.000Z","version":1,"walletId":"wallet-1"}',
    );
  });
});
