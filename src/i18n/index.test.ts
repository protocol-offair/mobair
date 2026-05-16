import { beforeEach, describe, expect, it, vi } from "vitest";

const getItem = vi.fn(async () => null);
const setItem = vi.fn(async () => undefined);
const getLocales = vi.fn(() => [{ languageTag: "pt-BR" }]);

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem,
    setItem,
  },
}));

vi.mock("expo-localization", () => ({
  getLocales,
}));

describe("i18n date/time formatting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLocales.mockReturnValue([{ languageTag: "pt-BR" }]);
  });

  it("formats visible date and time with the device locale instead of the selected app language", async () => {
    vi.resetModules();
    const { formatDateTime, setCurrentLocale } = await import("./index");
    const value = "2026-05-15T12:34:00.000Z";

    await setCurrentLocale("en");

    expect(formatDateTime(value)).toBe(
      new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value)),
    );
  });

  it("formats visible dates with the device locale instead of the selected app language", async () => {
    vi.resetModules();
    const { formatDateOnly, setCurrentLocale } = await import("./index");
    const value = "2026-05-15T12:34:00.000Z";

    await setCurrentLocale("en");

    expect(formatDateOnly(value)).toBe(
      new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "medium",
      }).format(new Date(value)),
    );
  });

  it("keeps sub-cent SOL values visible in the selected app locale", async () => {
    vi.resetModules();
    const { formatAssetAmount, setCurrentLocale } = await import("./index");

    await setCurrentLocale("pt-BR");

    expect(formatAssetAmount(0.001, "SOL")).toBe("0,001");
    expect(formatAssetAmount(0.000000001, "SOL")).toBe("0,000000001");
  });

  it("uses scientific notation when a value is smaller than the visual asset unit", async () => {
    vi.resetModules();
    const { formatAssetAmount, setCurrentLocale } = await import("./index");

    await setCurrentLocale("en");

    expect(formatAssetAmount(0.0000000001, "SOL")).toBe("1E-10");
  });
});
