import { AppState } from "react-native";
import { useEffect, useRef, useState } from "react";

import {
  canUseBiometricLogin,
  ensureLocalAccountStorageCompatibility,
  loadLocalAccountProfile,
  loginLocalAccountWithBiometrics,
  loginLocalAccountWithPassword,
  registerLocalAccount,
  type LocalAccountProfile,
} from "../services/localAuth";

const AUTH_BACKGROUND_LOGOUT_DELAY_MS = 12 * 60 * 60 * 1000;

function canResumeLocalShell(profile: LocalAccountProfile | null): boolean {
  return Boolean(profile);
}

export function useLocalAccountAuth() {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<LocalAccountProfile | null>(null);
  const backgroundLogoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    ensureLocalAccountStorageCompatibility()
      .then(() => loadLocalAccountProfile())
      .then((storedProfile) => {
        setProfile(storedProfile);
        setAuthenticated(canResumeLocalShell(storedProfile));
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        setReady(true);
      });
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "background" && profile && authenticated) {
        if (!backgroundLogoutTimerRef.current) {
          backgroundLogoutTimerRef.current = setTimeout(() => {
            setAuthenticated(false);
            backgroundLogoutTimerRef.current = null;
          }, AUTH_BACKGROUND_LOGOUT_DELAY_MS);
        }
        return;
      }

      if (backgroundLogoutTimerRef.current) {
        clearTimeout(backgroundLogoutTimerRef.current);
        backgroundLogoutTimerRef.current = null;
      }
    });

    return () => {
      if (backgroundLogoutTimerRef.current) {
        clearTimeout(backgroundLogoutTimerRef.current);
        backgroundLogoutTimerRef.current = null;
      }
      subscription.remove();
    };
  }, [authenticated, profile]);

  async function runAction(action: () => Promise<LocalAccountProfile>) {
    setBusy(true);
    setError(null);
    try {
      const nextProfile = await action();
      setProfile(nextProfile);
      setAuthenticated(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }

  return {
    ready,
    busy,
    error,
    authenticated,
    profile,
    biometricAvailable: canUseBiometricLogin(),
    biometricEnabled: canUseBiometricLogin() && Boolean(profile?.biometricEnabled),
    async register(input: {
      fullName: string;
      email: string;
      password: string;
      confirmPassword: string;
      enableBiometric: boolean;
    }) {
      await runAction(() => registerLocalAccount(input));
    },
    async loginWithPassword(input: { email: string; password: string }) {
      await runAction(() => loginLocalAccountWithPassword(input));
    },
    async loginWithBiometrics() {
      await runAction(() => loginLocalAccountWithBiometrics());
    },
    logout() {
      setAuthenticated(false);
      setError(null);
    },
  };
}

export type LocalAccountAuthController = ReturnType<typeof useLocalAccountAuth>;
