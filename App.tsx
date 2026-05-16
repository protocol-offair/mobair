import "./src/polyfills";

import { Manrope_400Regular } from "@expo-google-fonts/manrope/400Regular";
import { Manrope_700Bold } from "@expo-google-fonts/manrope/700Bold";
import { useFonts } from "@expo-google-fonts/manrope/useFonts";
import { DarkTheme, DefaultTheme, NavigationContainer, TabActions, createNavigationContainerRef } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Linking, StyleSheet, View } from "react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { enableScreens } from "react-native-screens";

import { useLocalAccountAuth } from "./src/hooks/useLocalAccountAuth";
import { useAirPayWallet } from "./src/hooks/useAirPayWallet";
import { I18nProvider } from "./src/i18n/I18nProvider";
import { AppTabs, type RootTabParamList } from "./src/navigation/AppTabs";
import { AuthScreen } from "./src/screens/AuthScreen";
import { AppSettingsProvider } from "./src/settings/AppSettingsProvider";
import { getAdbAutomationEnabled } from "./src/services/native/AirPayNative";
import type { WalletState } from "./src/services/wallet";
import { isDarkTheme, palette } from "./src/theme/palette";

enableScreens();

const navigationRef = createNavigationContainerRef<RootTabParamList>();

type PendingRoute = {
  route: keyof RootTabParamList;
  params?: RootTabParamList[keyof RootTabParamList];
};

type AutomationLoadedWallet = WalletState & {
  profile: NonNullable<WalletState["profile"]>;
};

type AdbAutomationCommand = {
  id: number;
} & (
  | {
      kind: "offlineSend";
      amount: number;
    }
  | {
      kind: "syncProtocol";
    }
  | {
      kind: "enableBackgroundRuntime";
    }
  | {
      kind: "prepareReceiver";
    }
  | {
      kind: "fundReserve";
      amount: number;
    }
);

function getAirPaySegments(url: string): string[] {
  const target = url
    .replace(/^airpay:\/\//i, "")
    .replace(/^airpay:/i, "")
    .replace(/^\/+/, "")
    .split(/[?#]/)[0];

  return target
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
}

function getAirPayQueryParam(url: string, name: string): string | null {
  const query = url.split("?")[1]?.split("#")[0];
  if (!query) {
    return null;
  }

  for (const pair of query.split("&")) {
    const [rawKey, rawValue = ""] = pair.split("=");
    if (decodeURIComponent(rawKey) === name) {
      return decodeURIComponent(rawValue.replace(/\+/g, " "));
    }
  }

  return null;
}

function routeFromAirPayUrl(url: string): PendingRoute | null {
  const [target] = getAirPaySegments(url);

  switch (target) {
    case "home":
      return { route: "Home" };
    case "send":
    case "transfer":
    case "offline-send":
      return { route: "Send" };
    case "pay":
      return { route: "Send", params: { gatewayPayload: url } };
    case "receive":
      return { route: "Receive" };
    case "history":
      return { route: "History" };
    default:
      return null;
  }
}

function automationFromAirPayUrl(url: string): AdbAutomationCommand | null {
  const segments = getAirPaySegments(url);
  const isSyncCommand = segments.includes("sync") || getAirPayQueryParam(url, "airpayAdb") === "sync";
  if (isSyncCommand && getAirPayQueryParam(url, "driver") === "adb") {
    return {
      id: Date.now(),
      kind: "syncProtocol",
    };
  }

  const isBackgroundRuntimeCommand =
    segments.includes("background-runtime") ||
    segments.includes("enable-background") ||
    getAirPayQueryParam(url, "airpayAdb") === "background-runtime";
  if (isBackgroundRuntimeCommand && getAirPayQueryParam(url, "driver") === "adb") {
    return {
      id: Date.now(),
      kind: "enableBackgroundRuntime",
    };
  }

  const isPrepareReceiverCommand =
    segments.includes("receive") ||
    segments.includes("prepare-receiver") ||
    getAirPayQueryParam(url, "airpayAdb") === "prepare-receiver";
  if (isPrepareReceiverCommand && getAirPayQueryParam(url, "driver") === "adb") {
    return {
      id: Date.now(),
      kind: "prepareReceiver",
    };
  }

  const isFundReserveCommand =
    segments.includes("fund-reserve") || getAirPayQueryParam(url, "airpayAdb") === "fund-reserve";
  if (isFundReserveCommand && getAirPayQueryParam(url, "driver") === "adb") {
    const parsedAmount = Number(getAirPayQueryParam(url, "amount") ?? "0.05");
    const amount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0.05;
    return {
      id: Date.now(),
      kind: "fundReserve",
      amount,
    };
  }

  const isOfflineSendCommand = segments.includes("offline-send") || getAirPayQueryParam(url, "airpayAdb") === "offline-send";
  if (!isOfflineSendCommand || getAirPayQueryParam(url, "driver") !== "adb") {
    return null;
  }

  const parsedAmount = Number(getAirPayQueryParam(url, "amount") ?? "0.01");
  const amount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0.01;

  return {
    id: Date.now(),
    kind: "offlineSend",
    amount,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAutomationWalletLoaded(wallet: WalletState | null | undefined): wallet is AutomationLoadedWallet {
  return Boolean(wallet?.manifest && wallet.profile);
}

function isAutomationWalletOfflineReady(controller: ReturnType<typeof useAirPayWallet>): boolean {
  return isAutomationWalletLoaded(controller.wallet) && controller.offlineReady;
}

const navigationTheme = {
  ...(isDarkTheme ? DarkTheme : DefaultTheme),
  colors: {
    ...(isDarkTheme ? DarkTheme.colors : DefaultTheme.colors),
    background: palette.background,
    card: palette.overlay,
    text: palette.ink,
    border: palette.line,
    primary: palette.sky,
    notification: palette.cyan,
  },
};

export default function App() {
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_700Bold,
  });

  if (!fontsLoaded) {
    return (
      <View style={styles.loadingScreen}>
        <StatusBar style={isDarkTheme ? "light" : "dark"} />
        <ActivityIndicator size="large" color={palette.cyan} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <I18nProvider>
        <RootShell />
      </I18nProvider>
    </SafeAreaProvider>
  );
}

function RootShell() {
  const controller = useAirPayWallet();
  const auth = useLocalAccountAuth();
  const [navigationReady, setNavigationReady] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<PendingRoute | null>(null);
  const [pendingAutomation, setPendingAutomation] = useState<AdbAutomationCommand | null>(null);
  const [automationRetryTick, setAutomationRetryTick] = useState(0);
  const [adbAutomationEnabled, setAdbAutomationEnabled] = useState(false);
  const controllerRef = useRef(controller);
  const automationRunningRef = useRef(false);

  useEffect(() => {
    controllerRef.current = controller;
  }, [controller]);

  useEffect(() => {
    let mounted = true;
    void getAdbAutomationEnabled()
      .then((enabled) => {
        if (mounted) {
          setAdbAutomationEnabled(enabled);
        }
      })
      .catch(() => {
        if (mounted) {
          setAdbAutomationEnabled(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const jumpToRoute = useCallback((target: keyof RootTabParamList | PendingRoute) => {
    const route = typeof target === "string" ? { route: target } : target;
    navigationRef.dispatch(TabActions.jumpTo(route.route, route.params));
  }, []);

  const queueRouteFromUrl = useCallback((url: string | null) => {
    if (!url) {
      return;
    }

    const route = routeFromAirPayUrl(url);
    if (route) {
      setPendingRoute(route);
    }

    const automation = automationFromAirPayUrl(url);
    if (automation) {
      setPendingAutomation(automation);
    }
  }, []);

  useEffect(() => {
    void Linking.getInitialURL().then(queueRouteFromUrl);
    const subscription = Linking.addEventListener("url", (event) => queueRouteFromUrl(event.url));

    return () => subscription.remove();
  }, [queueRouteFromUrl]);

  useEffect(() => {
    if (!auth.authenticated || !navigationReady || !pendingRoute || !navigationRef.isReady()) {
      return;
    }

    jumpToRoute(pendingRoute);
    setPendingRoute(null);
  }, [auth.authenticated, jumpToRoute, navigationReady, pendingRoute]);

  useEffect(() => {
    if (
      !auth.authenticated ||
      !navigationReady ||
      !pendingAutomation ||
      !navigationRef.isReady() ||
      automationRunningRef.current ||
      !adbAutomationEnabled
    ) {
      return;
    }

    automationRunningRef.current = true;
    setPendingAutomation(null);

    void (async () => {
      try {
        console.warn("[AirPay ADB automation]", `start ${pendingAutomation.kind}`);
        if (pendingAutomation.kind === "syncProtocol") {
          jumpToRoute("Home");
          await waitForAutomationValue(() => {
            const currentWallet = controllerRef.current.wallet;
            return isAutomationWalletLoaded(currentWallet) ? currentWallet : null;
          }, 90000);
          await controllerRef.current.refreshProtocolState();
          await waitForAutomationValue(() => !controllerRef.current.busy, 90000);
          if (controllerRef.current.error) {
            throw new Error(controllerRef.current.error);
          }
          jumpToRoute("Home");
          return;
        }

        if (pendingAutomation.kind === "prepareReceiver") {
          jumpToRoute("Receive");
          await waitForAutomationValue(() => {
            const currentWallet = controllerRef.current.wallet;
            return isAutomationWalletLoaded(currentWallet) ? currentWallet : null;
          }, 90000);
          await controllerRef.current.prepareReceiver();
          await waitForAutomationValue(() => {
            const current = controllerRef.current;
            return (
              current.error ||
              current.receiverState.status === "ready" ||
              current.receiverState.status === "connected"
            );
          }, 90000);
          if (controllerRef.current.error) {
            throw new Error(controllerRef.current.error);
          }
          return;
        }

        if (pendingAutomation.kind === "enableBackgroundRuntime") {
          jumpToRoute("Home");
          await delay(500);
          await controllerRef.current.enableBackgroundRuntime();
          await waitForAutomationValue(() => !controllerRef.current.busy, 90000);
          if (controllerRef.current.error) {
            throw new Error(controllerRef.current.error);
          }
          jumpToRoute("Home");
          return;
        }

        if (pendingAutomation.kind === "fundReserve") {
          jumpToRoute("Send");
          await waitForAutomationValue(() => {
            const currentWallet = controllerRef.current.wallet;
            return isAutomationWalletLoaded(currentWallet) ? currentWallet : null;
          }, 90000);
          await controllerRef.current.fundReserve(pendingAutomation.amount.toString());
          await waitForAutomationValue(() => !controllerRef.current.busy, 90000);
          if (controllerRef.current.error) {
            throw new Error(controllerRef.current.error);
          }
          jumpToRoute("Home");
          return;
        }

        jumpToRoute("Send");
        console.warn("[AirPay ADB automation]", "wait wallet loaded");
        const loadedWallet = await waitForAutomationValue(() => {
          const currentWallet = controllerRef.current.wallet;
          return isAutomationWalletLoaded(currentWallet) ? currentWallet : null;
        }, 90000);
        if (!loadedWallet.profile.backupConfirmedAt) {
          console.warn("[AirPay ADB automation]", "confirm wallet backup");
          await controllerRef.current.confirmBackup();
          await waitForAutomationValue(() => !controllerRef.current.busy, 90000);
          if (controllerRef.current.error) {
            throw new Error(controllerRef.current.error);
          }
        }
        console.warn("[AirPay ADB automation]", "wait offline readiness");
        await waitForAutomationValue(() => isAutomationWalletOfflineReady(controllerRef.current), 90000);
        console.warn("[AirPay ADB automation]", "start sender discovery");
        await controllerRef.current.startSenderDiscovery();

        const receiver = await waitForAutomationValue(() => controllerRef.current.senderDiscovery.receivers[0] ?? null, 45000);
        console.warn("[AirPay ADB automation]", `receiver found ${receiver.candidateId}`);
        await controllerRef.current.selectNearbyReceiver(receiver.candidateId);
        await waitForAutomationValue(
          () =>
            controllerRef.current.senderDiscovery.selectedReceiverId === receiver.candidateId ||
            controllerRef.current.selectedNearbyReceiver?.candidateId === receiver.candidateId,
          15000,
        );

        console.warn("[AirPay ADB automation]", "send transfer");
        await controllerRef.current.send(pendingAutomation.amount, "");
        await waitForAutomationValue(() => !controllerRef.current.busy, 30000);

        if (controllerRef.current.sendTrustPrompt) {
          console.warn("[AirPay ADB automation]", "confirm trust warning");
          await controllerRef.current.confirmSendTrustWarning();
          await waitForAutomationValue(() => !controllerRef.current.busy, 30000);
        }

        if (controllerRef.current.error) {
          throw new Error(controllerRef.current.error);
        }

        jumpToRoute("History");
      } catch (error) {
        console.warn("[AirPay ADB automation]", error instanceof Error ? error.message : String(error));
      } finally {
        automationRunningRef.current = false;
        setAutomationRetryTick((tick) => tick + 1);
      }
    })();
  }, [adbAutomationEnabled, automationRetryTick, auth.authenticated, jumpToRoute, navigationReady, pendingAutomation]);

  if (!auth.ready) {
    return (
      <View style={styles.loadingScreen}>
        <StatusBar style={isDarkTheme ? "light" : "dark"} />
        <ActivityIndicator size="large" color={palette.cyan} />
      </View>
    );
  }

  return (
    <AppSettingsProvider
      walletControls={{
        networkOnline: controller.backgroundRuntime.networkConnected !== false,
        busy: controller.busy,
        activeWalletId: controller.wallet?.activeWalletId,
        wallets: controller.wallet?.walletRegistry ?? [],
        onCreateWallet: controller.createWallet,
        onSelectWallet: controller.selectWallet,
        onRefreshBalances: controller.refreshBalances,
      }}
    >
      <NavigationContainer ref={navigationRef} onReady={() => setNavigationReady(true)} theme={navigationTheme}>
        <StatusBar style={isDarkTheme ? "light" : "dark"} />
        {auth.authenticated ? <AppTabs controller={controller} onLogout={auth.logout} /> : <AuthScreen controller={auth} />}
      </NavigationContainer>
    </AppSettingsProvider>
  );
}

async function waitForAutomationValue<T>(readValue: () => T | null | false, timeoutMs: number): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = readValue();
    if (value) {
      return value;
    }
    await delay(250);
  }

  throw new Error("AirPay ADB automation timed out.");
}

const styles = StyleSheet.create({
  loadingScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.background,
  },
});
