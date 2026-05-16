import { beforeEach, describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
  secureStorage: new Map<string, string>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => stores.asyncStorage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      stores.asyncStorage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      stores.asyncStorage.delete(key);
    }),
  },
}));

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock("expo-file-system/legacy", () => ({
  EncodingType: {
    Base64: "base64",
  },
  readAsStringAsync: vi.fn(),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => stores.secureStorage.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    stores.secureStorage.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    stores.secureStorage.delete(key);
  }),
  canUseBiometricAuthentication: vi.fn(() => true),
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: vi.fn(() => ({
      remove: vi.fn(),
    })),
  },
}));

vi.mock("../i18n", () => ({
  translate: (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

import {
  importMnemonicWallet,
  loadWalletMetadata,
  loadWalletRegistry,
  revealMnemonic,
} from "./custody";

const VALID_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MIXED_CASE_MNEMONIC = "  ABANDON\nabandon   abandon abandon abandon abandon abandon abandon abandon abandon abandon ABOUT  ";

describe("custody wallet import", () => {
  beforeEach(() => {
    stores.asyncStorage.clear();
    stores.secureStorage.clear();
    vi.clearAllMocks();
  });

  it("normalizes, imports, persists, and reveals a valid mnemonic wallet", async () => {
    const imported = await importMnemonicWallet({
      mnemonic: MIXED_CASE_MNEMONIC,
      passphrase: " airpay-passphrase ",
      displayName: "  Main Recovery  ",
    });

    expect(imported.mnemonic).toBe(VALID_MNEMONIC);
    expect(imported.profile.displayName).toBe("Main Recovery");
    expect(imported.profile.walletType).toBe("global");
    expect(imported.profile.derivationPath).toBe("m/44'/501'/0'/0'");
    expect(imported.profile.backupConfirmedAt).toBe(imported.security.lastImportAt);
    expect(imported.profile.mnemonicWordCount).toBe(12);
    expect(imported.profile.hasPassphrase).toBe(true);
    expect(imported.profile.exportable).toBe(true);
    expect(imported.security.biometryAvailable).toBe(true);
    expect(imported.security.biometricProtected).toBe(false);

    const metadata = await loadWalletMetadata();
    expect(metadata?.profile.walletId).toBe(imported.profile.walletId);
    expect(metadata?.security.lastImportAt).toBe(imported.security.lastImportAt);
    expect(metadata?.balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assetId: "SOL", amount: "0" }),
        expect.objectContaining({ assetId: "OFFAIR", amount: "0" }),
      ]),
    );

    const registry = await loadWalletRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      walletId: imported.profile.walletId,
      displayName: "Main Recovery",
      isActiveOnDevice: true,
    });

    const revealed = await revealMnemonic();
    expect(revealed.mnemonic).toBe(VALID_MNEMONIC);

    const metadataAfterReveal = await loadWalletMetadata();
    expect(metadataAfterReveal?.security.lastMnemonicRevealAt).toEqual(expect.any(String));
  });

  it("rejects invalid mnemonic input without creating a wallet", async () => {
    await expect(
      importMnemonicWallet({
        mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon",
        passphrase: "",
      }),
    ).rejects.toThrow("service.custody.error.mnemonic");

    await expect(loadWalletRegistry()).resolves.toEqual([]);
    await expect(loadWalletMetadata()).resolves.toBeNull();
    expect(stores.secureStorage.size).toBe(0);
  });

  it("updates the existing imported wallet instead of duplicating it", async () => {
    const firstImport = await importMnemonicWallet({
      mnemonic: VALID_MNEMONIC,
      passphrase: "",
      displayName: "First Label",
    });
    const secondImport = await importMnemonicWallet({
      mnemonic: VALID_MNEMONIC,
      passphrase: "",
      displayName: "Second Label",
    });

    expect(secondImport.profile.walletId).toBe(firstImport.profile.walletId);

    const registry = await loadWalletRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      walletId: firstImport.profile.walletId,
      displayName: "Second Label",
      isActiveOnDevice: true,
    });

    const metadata = await loadWalletMetadata(firstImport.profile.walletId);
    expect(metadata?.profile.displayName).toBe("Second Label");
    expect(metadata?.security.lastImportAt).toBe(secondImport.security.lastImportAt);
  });
});
