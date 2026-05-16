import { describe, expect, it } from "vitest";

import { buildLocalGatewayPaymentLink, parseOnlinePaymentRequest, paymentRequestMemo } from "./paymentRequest";

const wallet = "HZCaZLE1coSGSSat2NqDkorkH9cyT3MizkVQ1TPAKNxE";
const reference = "4KY1PdgYXNts1hPRV6KiUgqW87TVDi4G9gsAp7JbZW3i";

describe("paymentRequest", () => {
  it("parses Solana Pay gateway URLs with temporary wallet details", () => {
    const request = parseOnlinePaymentRequest(
      `solana:${wallet}?amount=0.010000000&reference=${reference}&label=AirPay+Demo+Merchant&message=AirPay+Gateway+payment+pay_123&memo=pay_123`,
    );

    expect(request.wallet).toBe(wallet);
    expect(request.amount).toBe("0.010000000");
    expect(request.currency).toBe("SOL");
    expect(request.reference).toBe(reference);
    expect(request.label).toBe("AirPay Demo Merchant");
    expect(request.intentId).toBe("pay_123");
    expect(paymentRequestMemo(request)).toBe("pay_123");
  });

  it("parses AirPay copied payment links", () => {
    const request = parseOnlinePaymentRequest(
      `airpay://pay?intentId=pay_abc&wallet=${wallet}&amount=1.5&currency=SOL&reference=${reference}`,
    );

    expect(request.source).toBe("airpay-gateway");
    expect(request.wallet).toBe(wallet);
    expect(request.amount).toBe("1.5");
    expect(request.reference).toBe(reference);
    expect(request.memo).toBe("pay_abc");
  });

  it("builds offline-created Gateway links as deferred online SOL requests", () => {
    const request = buildLocalGatewayPaymentLink({
      merchantWallet: wallet,
      amount: "0.025",
      label: "AirPay Demo",
      gatewayFeeBps: 70,
      displayAmount: "10",
      displayCurrency: "BRZ",
      displayRateFetchedAt: "2026-05-16T12:00:00.000Z",
      now: new Date("2026-05-16T12:30:00.000Z"),
    });
    const parsed = parseOnlinePaymentRequest(request.raw);

    expect(parsed.source).toBe("airpay-gateway");
    expect(parsed.wallet).toBe(wallet);
    expect(parsed.merchantWallet).toBe(wallet);
    expect(parsed.amount).toBe("0.025");
    expect(parsed.currency).toBe("SOL");
    expect(parsed.settlementMode).toBe("gateway_deferred_online");
    expect(parsed.gatewayFeeBps).toBe(70);
    expect(parsed.displayAmount).toBe("10");
    expect(parsed.displayCurrency).toBe("BRZ");
    expect(parsed.reference).toBeTruthy();
    expect(parsed.intentId?.startsWith("pay_local_")).toBe(true);
  });

  it("preserves multi-asset Gateway route metadata", () => {
    const request = buildLocalGatewayPaymentLink({
      merchantWallet: wallet,
      amount: "10",
      receiveCurrency: "BRZ",
      payCurrency: "USDC",
      solAmount: "0.012654321",
      gatewayFeeBps: 70,
      conversionFeeBps: 180,
      totalFeeBps: 250,
      now: new Date("2026-05-16T12:30:00.000Z"),
    });
    const parsed = parseOnlinePaymentRequest(request.raw);

    expect(parsed.amount).toBe("10");
    expect(parsed.currency).toBe("USDC");
    expect(parsed.solAmount).toBe("0.012654321");
    expect(parsed.receiveAmount).toBe("10");
    expect(parsed.receiveCurrency).toBe("BRZ");
    expect(parsed.payCurrency).toBe("USDC");
    expect(parsed.conversionFeeBps).toBe(180);
    expect(parsed.totalFeeBps).toBe(250);
    expect(parsed.allowedPayCurrencies).toContain("OFFAIR");
  });

  it("rejects unsupported copied payloads", () => {
    expect(() =>
      parseOnlinePaymentRequest(JSON.stringify({ wallet, amount: "1", currency: "XYZ", reference })),
    ).toThrow("Unsupported");
  });
});
