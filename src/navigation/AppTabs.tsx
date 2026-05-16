import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { lazy, Suspense, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import type { AirPayWalletController } from "../hooks/useAirPayWallet";
import { useI18n } from "../i18n/I18nProvider";
import { CustomTabBar } from "../components/ui/CustomTabBar";
import { palette } from "../theme/palette";

const HomeScreen = lazy(() => import("../screens/HomeScreen").then((module) => ({ default: module.HomeScreen })));
const SendScreen = lazy(() => import("../screens/SendScreen").then((module) => ({ default: module.SendScreen })));
const ReceiveScreen = lazy(() => import("../screens/ReceiveScreen").then((module) => ({ default: module.ReceiveScreen })));
const HistoryScreen = lazy(() => import("../screens/HistoryScreen").then((module) => ({ default: module.HistoryScreen })));

export type RootTabParamList = {
  Home: undefined;
  Send: { gatewayPayload?: string } | undefined;
  Receive: undefined;
  History: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

function LazyScreenBoundary(props: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <View style={styles.loadingScreen}>
          <ActivityIndicator size="small" color={palette.cyan} />
        </View>
      }
    >
      {props.children}
    </Suspense>
  );
}

export function AppTabs(props: { controller: AirPayWalletController; onLogout: () => void }) {
  const { t } = useI18n();

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        lazy: true,
      }}
      tabBar={(tabProps) => <CustomTabBar {...tabProps} />}
    >
      <Tab.Screen name="Home" options={{ tabBarLabel: t("tabs.home") }}>
        {({ navigation }) => (
          <LazyScreenBoundary>
            <HomeScreen
              controller={props.controller}
              onLogout={props.onLogout}
              onOpenSend={() => navigation.navigate("Send")}
              onOpenReceive={() => navigation.navigate("Receive")}
              onOpenHistory={() => navigation.navigate("History")}
            />
          </LazyScreenBoundary>
        )}
      </Tab.Screen>
      <Tab.Screen name="Send" options={{ tabBarLabel: t("tabs.send") }}>
        {({ route }) => (
          <LazyScreenBoundary>
            <SendScreen controller={props.controller} gatewayPayload={route.params?.gatewayPayload} />
          </LazyScreenBoundary>
        )}
      </Tab.Screen>
      <Tab.Screen name="Receive" options={{ tabBarLabel: t("tabs.receive") }}>
        {() => (
          <LazyScreenBoundary>
            <ReceiveScreen controller={props.controller} />
          </LazyScreenBoundary>
        )}
      </Tab.Screen>
      <Tab.Screen name="History" options={{ tabBarLabel: t("tabs.history") }}>
        {() => (
          <LazyScreenBoundary>
            <HistoryScreen controller={props.controller} />
          </LazyScreenBoundary>
        )}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  loadingScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.background,
  },
});
