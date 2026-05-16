import { describe, expect, it } from "vitest";

import { quoteGatewayAssetConversion } from "./assetConversion";

const rates = {
  solUsd: 150,
  solBrl: 810,
  fetchedAt: "2026-05-16T12:00:00.000Z",
  source: "coingecko" as const,
};

describe("assetConversion", () => {
  it("keeps direct SOL compatible with the existing gross amount flow", () => {
    const quote = quoteGatewayAssetConversion({
      receiveAmount: "1",
      receiveAsset: "SOL",
      payAsset: "SOL",
      rates: null,
      gatewayFeeBps: 70,
    });

    expect(quote?.payAmount).toBe("1");
    expect(quote?.solAmount).toBe("1");
    expect(quote?.route).toBe("direct_sol");
  });

  it("adds conversion protection when payer and merchant assets differ", () => {
    const quote = quoteGatewayAssetConversion({
      receiveAmount: "10",
      receiveAsset: "BRZ",
      payAsset: "USDC",
      rates,
      gatewayFeeBps: 70,
      conversionFeeBps: 180,
    });

    expect(quote?.route).toBe("quoted_conversion");
    expect(quote?.receiveAsset).toBe("BRZ");
    expect(quote?.payAsset).toBe("USDC");
    expect(quote?.totalFeeBps).toBe(250);
    expect(Number(quote?.solAmount)).toBeGreaterThan(10 / 810);
  });

  it("routes OffAir through SOL-equivalent conversion", () => {
    const quote = quoteGatewayAssetConversion({
      receiveAmount: "0.2",
      receiveAsset: "OFFAIR",
      payAsset: "SOL",
      rates: null,
      gatewayFeeBps: 70,
      conversionFeeBps: 180,
    });

    expect(quote?.route).toBe("offair_via_sol");
    expect(quote?.solAmount).toBe("0.205");
  });
});
