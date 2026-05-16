import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Buffer } from "buffer";

import { createNonce } from "@airpay/shared";

import { translate } from "../i18n";

const AUTH_PROFILE_KEY = "airpay.auth.profile";
const AUTH_SECRET_KEY = "airpay.auth.secret";
const AUTH_BIOMETRIC_TOKEN_KEY = "airpay.auth.biometric.token";
const AUTH_STORAGE_RESET_VERSION_KEY = "airpay.auth.storage.resetVersion";
const AUTH_STORAGE_RESET_VERSION = 2;
const PASSWORD_ROUNDS = 120_000;
const BIOMETRIC_LOGIN_ENABLED = false;

export interface LocalAccountProfile {
  accountId: string;
  fullName: string;
  email: string;
  biometricEnabled: boolean;
  createdAt: string;
  lastLoginAt?: string | null;
}

interface StoredPasswordSecret {
  salt: string;
  verifier: string;
}

function isValidLocalAccountProfile(value: unknown): value is LocalAccountProfile {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.accountId === "string" &&
    typeof candidate.fullName === "string" &&
    typeof candidate.email === "string" &&
    typeof candidate.biometricEnabled === "boolean" &&
    typeof candidate.createdAt === "string" &&
    (candidate.lastLoginAt === undefined || candidate.lastLoginAt === null || typeof candidate.lastLoginAt === "string")
  );
}

function isValidStoredPasswordSecret(value: unknown): value is StoredPasswordSecret {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.salt === "string" && typeof candidate.verifier === "string";
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function getBiometricOptions(prompt: string): SecureStore.SecureStoreOptions {
  return {
    keychainService: AUTH_BIOMETRIC_TOKEN_KEY,
    requireAuthentication: true,
    authenticationPrompt: prompt,
  };
}

async function derivePasswordVerifier(password: string, salt: string): Promise<string> {
  const derived = await pbkdf2Async(
    sha256,
    new TextEncoder().encode(password),
    new TextEncoder().encode(salt),
    {
      c: PASSWORD_ROUNDS,
      dkLen: 32,
    },
  );
  return Buffer.from(derived).toString("base64");
}

function validateRegistrationInput(input: {
  fullName: string;
  email: string;
  password: string;
  confirmPassword: string;
}) {
  if (!input.fullName.trim()) {
    throw new Error(translate("auth.error.fullNameRequired"));
  }
  if (!normalizeEmail(input.email) || !normalizeEmail(input.email).includes("@")) {
    throw new Error(translate("auth.error.emailInvalid"));
  }
  if (input.password.length < 8) {
    throw new Error(translate("auth.error.passwordLength"));
  }
  if (input.password !== input.confirmPassword) {
    throw new Error(translate("auth.error.passwordMismatch"));
  }
}

function validatePasswordLoginInput(input: { email: string; password: string }) {
  if (!normalizeEmail(input.email) || !normalizeEmail(input.email).includes("@")) {
    throw new Error(translate("auth.error.emailInvalid"));
  }
  if (!input.password) {
    throw new Error(translate("auth.error.passwordRequired"));
  }
}

export async function loadLocalAccountProfile(): Promise<LocalAccountProfile | null> {
  const raw = await AsyncStorage.getItem(AUTH_PROFILE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidLocalAccountProfile(parsed)) {
      return null;
    }
    return {
      ...parsed,
      email: normalizeEmail(parsed.email),
    };
  } catch {
    return null;
  }
}

async function saveLocalAccountProfile(profile: LocalAccountProfile): Promise<void> {
  await AsyncStorage.setItem(AUTH_PROFILE_KEY, JSON.stringify(profile));
}

async function loadPasswordSecret(): Promise<StoredPasswordSecret | null> {
  const raw = await SecureStore.getItemAsync(AUTH_SECRET_KEY, {
    keychainService: AUTH_SECRET_KEY,
  });
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isValidStoredPasswordSecret(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function savePasswordSecret(secret: StoredPasswordSecret): Promise<void> {
  await SecureStore.setItemAsync(AUTH_SECRET_KEY, JSON.stringify(secret), {
    keychainService: AUTH_SECRET_KEY,
  });
}

async function setBiometricState(enabled: boolean): Promise<boolean> {
  if (!BIOMETRIC_LOGIN_ENABLED) {
    await SecureStore.deleteItemAsync(AUTH_BIOMETRIC_TOKEN_KEY, {
      keychainService: AUTH_BIOMETRIC_TOKEN_KEY,
    }).catch(() => undefined);
    return false;
  }

  if (!enabled) {
    await SecureStore.deleteItemAsync(AUTH_BIOMETRIC_TOKEN_KEY, {
      keychainService: AUTH_BIOMETRIC_TOKEN_KEY,
    }).catch(() => undefined);
    return false;
  }

  if (!SecureStore.canUseBiometricAuthentication()) {
    return false;
  }

  await SecureStore.setItemAsync(
    AUTH_BIOMETRIC_TOKEN_KEY,
    createNonce("local-auth"),
    getBiometricOptions(translate("auth.biometric.prompt")),
  );
  return true;
}

export async function registerLocalAccount(input: {
  fullName: string;
  email: string;
  password: string;
  confirmPassword: string;
  enableBiometric: boolean;
}): Promise<LocalAccountProfile> {
  validateRegistrationInput(input);

  if (await loadLocalAccountProfile()) {
    throw new Error(translate("auth.error.accountAlreadyExists"));
  }

  const salt = createNonce("salt");
  const verifier = await derivePasswordVerifier(input.password, salt);
  await savePasswordSecret({ salt, verifier });

  const biometricEnabled = await setBiometricState(input.enableBiometric);
  const profile: LocalAccountProfile = {
    accountId: createNonce("account"),
    fullName: input.fullName.trim(),
    email: normalizeEmail(input.email),
    biometricEnabled,
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  };

  await saveLocalAccountProfile(profile);
  return profile;
}

export async function loginLocalAccountWithPassword(input: {
  email: string;
  password: string;
}): Promise<LocalAccountProfile> {
  validatePasswordLoginInput(input);

  const profile = await loadLocalAccountProfile();
  if (!profile || profile.email !== normalizeEmail(input.email)) {
    throw new Error(translate("auth.error.credentialsInvalid"));
  }

  const storedSecret = await loadPasswordSecret();
  if (!storedSecret) {
    throw new Error(translate("auth.error.accountCorrupted"));
  }

  const computed = await derivePasswordVerifier(input.password, storedSecret.salt);
  if (computed !== storedSecret.verifier) {
    throw new Error(translate("auth.error.credentialsInvalid"));
  }

  const nextProfile = {
    ...profile,
    lastLoginAt: new Date().toISOString(),
  };
  await saveLocalAccountProfile(nextProfile);
  return nextProfile;
}

export async function loginLocalAccountWithBiometrics(): Promise<LocalAccountProfile> {
  if (!BIOMETRIC_LOGIN_ENABLED) {
    throw new Error(translate("auth.error.biometricUnavailable"));
  }

  const profile = await loadLocalAccountProfile();
  if (!profile) {
    throw new Error(translate("auth.error.accountMissing"));
  }
  if (!profile.biometricEnabled) {
    throw new Error(translate("auth.error.biometricUnavailable"));
  }

  const unlockedToken = await SecureStore.getItemAsync(
    AUTH_BIOMETRIC_TOKEN_KEY,
    getBiometricOptions(translate("auth.biometric.prompt")),
  );
  if (!unlockedToken) {
    throw new Error(translate("auth.error.biometricFailed"));
  }

  const nextProfile = {
    ...profile,
    lastLoginAt: new Date().toISOString(),
  };
  await saveLocalAccountProfile(nextProfile);
  return nextProfile;
}

export async function enableBiometricLogin(): Promise<LocalAccountProfile> {
  if (!BIOMETRIC_LOGIN_ENABLED) {
    throw new Error(translate("auth.error.biometricUnavailable"));
  }

  const profile = await loadLocalAccountProfile();
  if (!profile) {
    throw new Error(translate("auth.error.accountMissing"));
  }

  const biometricEnabled = await setBiometricState(true);
  if (!biometricEnabled) {
    throw new Error(translate("auth.error.biometricUnavailable"));
  }

  const nextProfile = {
    ...profile,
    biometricEnabled: true,
  };
  await saveLocalAccountProfile(nextProfile);
  return nextProfile;
}

export async function clearLocalAccountSessionMaterial(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(AUTH_PROFILE_KEY),
    SecureStore.deleteItemAsync(AUTH_SECRET_KEY, { keychainService: AUTH_SECRET_KEY }).catch(() => undefined),
    SecureStore.deleteItemAsync(AUTH_BIOMETRIC_TOKEN_KEY, { keychainService: AUTH_BIOMETRIC_TOKEN_KEY }).catch(() => undefined),
  ]);
}

export function canUseBiometricLogin(): boolean {
  return BIOMETRIC_LOGIN_ENABLED && SecureStore.canUseBiometricAuthentication();
}

export async function ensureLocalAccountStorageCompatibility(): Promise<boolean> {
  const currentVersion = await AsyncStorage.getItem(AUTH_STORAGE_RESET_VERSION_KEY);
  if (currentVersion === String(AUTH_STORAGE_RESET_VERSION)) {
    const [profileRaw, profile, secret] = await Promise.all([
      AsyncStorage.getItem(AUTH_PROFILE_KEY),
      loadLocalAccountProfile(),
      loadPasswordSecret(),
    ]);
    if (!profileRaw) {
      return false;
    }
    if (!profile || !secret) {
      await clearLocalAccountSessionMaterial();
      return true;
    }
    return false;
  }

  await clearLocalAccountSessionMaterial();
  await AsyncStorage.setItem(AUTH_STORAGE_RESET_VERSION_KEY, String(AUTH_STORAGE_RESET_VERSION));
  return true;
}
