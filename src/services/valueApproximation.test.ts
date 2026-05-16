import { describe, expect, it, vi } from "vitest";

import {
  convertReferenceAmountToSol,
  formatApproximateAssetAmount,
  type ValueApproximationDisplayState,
} from "./valueApproximation";

vi.mock("../i18n", () => ({
  formatDateTime: (value: string) => value,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat("pt-BR", options).format(value),
}));

const enabledState: ValueApproximationDisplayState = {
  preferences: {
    enabled: true,
    asset: "USDC",
  },
  rates: {
    solUsd: 150,
    solBrl: 810,
    fetchedAt: "2026-05-16T12:00:00.000Z",
    source: "coingecko",
  },
};

describe("formatApproximateAssetAmount", () => {
  it("formats SOL-like values as approximate visual references", () => {
    expect(formatApproximateAssetAmount(0.001, "SOL", enabledState)).toBe("≈ 0,15 USDC");
  });

  it("uses the selected BRZ reference without changing the original asset", () => {
    expect(
      formatApproximateAssetAmount("0.01", "OFFAIR", {
        ...enabledState,
        preferences: {
          enabled: true,
          asset: "BRZ",
        },
      }),
    ).toBe("≈ 8,10 BRZ");
  });

  it("does not show approximation when disabled or unavailable", () => {
    expect(
      formatApproximateAssetAmount(1, "SOL", {
        preferences: {
          enabled: false,
          asset: "USDC",
        },
        rates: enabledState.rates,
      }),
    ).toBeNull();
    expect(formatApproximateAssetAmount(1, "USDC", enabledState)).toBeNull();
  });

  it("converts a selected visual reference amount back to fixed SOL for payment links", () => {
    expect(convertReferenceAmountToSol("15", enabledState)).toBe("0.1");
    expect(
      convertReferenceAmountToSol("81", {
        ...enabledState,
        preferences: {
          enabled: true,
          asset: "BRZ",
        },
      }),
    ).toBe("0.1");
  });
});
