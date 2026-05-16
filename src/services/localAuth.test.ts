import { beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorageState = new Map<string, string>();
const secureStorageState = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStorageState.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      asyncStorageState.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      asyncStorageState.delete(key);
    }),
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => secureStorageState.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStorageState.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStorageState.delete(key);
  }),
  canUseBiometricAuthentication: vi.fn(() => true),
}));

vi.mock("../i18n", () => ({
  translate: (key: string) => key,
}));

import {
  canUseBiometricLogin,
  ensureLocalAccountStorageCompatibility,
  loadLocalAccountProfile,
  registerLocalAccount,
} from "./localAuth";

describe("localAuth compatibility", () => {
  beforeEach(() => {
    asyncStorageState.clear();
    secureStorageState.clear();
  });

  it("returns null when the stored profile JSON is malformed", async () => {
    asyncStorageState.set("airpay.auth.profile", "{broken-json");

    await expect(loadLocalAccountProfile()).resolves.toBeNull();
  });

  it("clears malformed legacy auth material even on the current storage version", async () => {
    asyncStorageState.set("airpay.auth.storage.resetVersion", "2");
    asyncStorageState.set("airpay.auth.profile", JSON.stringify({ email: "legacy@example.com" }));
    secureStorageState.set("airpay.auth.secret", "{broken-json");
    secureStorageState.set("airpay.auth.biometric.token", "token");

    await expect(ensureLocalAccountStorageCompatibility()).resolves.toBe(true);

    expect(asyncStorageState.has("airpay.auth.profile")).toBe(false);
    expect(secureStorageState.has("airpay.auth.secret")).toBe(false);
    expect(secureStorageState.has("airpay.auth.biometric.token")).toBe(false);
  });

  it("resets old auth storage versions before bootstrap", async () => {
    asyncStorageState.set("airpay.auth.storage.resetVersion", "1");
    asyncStorageState.set(
      "airpay.auth.profile",
      JSON.stringify({
        accountId: "old-account",
        fullName: "Legacy User",
        email: "legacy@example.com",
        biometricEnabled: false,
        createdAt: "2026-04-01T00:00:00.000Z",
      }),
    );
    secureStorageState.set(
      "airpay.auth.secret",
      JSON.stringify({
        salt: "salt",
        verifier: "verifier",
      }),
    );

    await expect(ensureLocalAccountStorageCompatibility()).resolves.toBe(true);

    expect(asyncStorageState.get("airpay.auth.storage.resetVersion")).toBe("2");
    expect(asyncStorageState.has("airpay.auth.profile")).toBe(false);
    expect(secureStorageState.has("airpay.auth.secret")).toBe(false);
  });

  it("keeps biometric login disabled for the MVP even when the device supports it", async () => {
    expect(canUseBiometricLogin()).toBe(false);

    const profile = await registerLocalAccount({
      fullName: "AirPay Tester",
      email: "tester@airpay.local",
      password: "airpaysmoke",
      confirmPassword: "airpaysmoke",
      enableBiometric: true,
    });

    expect(profile.biometricEnabled).toBe(false);
    expect(secureStorageState.has("airpay.auth.biometric.token")).toBe(false);
  });
});
