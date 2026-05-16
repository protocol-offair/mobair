import Feather from "@expo/vector-icons/Feather";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { formatAssetAmount } from "../i18n";
import { useI18n } from "../i18n/I18nProvider";
import { ActionButton } from "../components/ui/ActionButton";
import { ActionRail } from "../components/ui/ActionRail";
import { AlertBanner } from "../components/ui/AlertBanner";
import { StatusChip } from "../components/ui/StatusChip";
import { SurfaceCard } from "../components/ui/SurfaceCard";
import { GATEWAY_PAYMENT_ASSETS, quoteGatewayAssetConversion, type GatewayPaymentAsset } from "../services/assetConversion";
import { normalizeDecimalInput } from "../services/inputFormatters";
import { palette, radii, shadows, typeRamp } from "../theme/palette";
import {
  APPROXIMATION_ASSETS,
  DEFAULT_VALUE_APPROXIMATION_PREFERENCES,
  fetchSolReferenceRates,
  formatApproximationUpdatedAt,
  loadSolReferenceRates,
  loadValueApproximationPreferences,
  saveSolReferenceRates,
  saveValueApproximationPreferences,
  type ApproximationAsset,
  type SolReferenceRates,
  type ValueApproximationDisplayState,
  type ValueApproximationPreferences,
} from "../services/valueApproximation";

interface AppSettingsContextValue {
  approximation: ValueApproximationDisplayState;
  approximationLoading: boolean;
  approximationError: string | null;
  openSettings: () => void;
  closeSettings: () => void;
  updateApproximationPreferences: (patch: Partial<ValueApproximationPreferences>) => Promise<void>;
  refreshApproximationRates: () => Promise<void>;
}

export interface SettingsWalletControls {
  networkOnline: boolean;
  busy: boolean;
  activeWalletId?: string | null;
  wallets: Array<{
    walletId: string;
    displayName: string;
    solanaAddress: string;
    isActiveOnDevice?: boolean;
  }>;
  onCreateWallet: (input: { passphrase: string; displayName?: string }) => Promise<void>;
  onSelectWallet: (walletId: string) => Promise<void>;
  onRefreshBalances: () => Promise<void>;
}

const defaultContext: AppSettingsContextValue = {
  approximation: {
    preferences: DEFAULT_VALUE_APPROXIMATION_PREFERENCES,
    rates: null,
  },
  approximationLoading: false,
  approximationError: null,
  openSettings: () => undefined,
  closeSettings: () => undefined,
  updateApproximationPreferences: async () => undefined,
  refreshApproximationRates: async () => undefined,
};

const AppSettingsContext = createContext<AppSettingsContextValue>(defaultContext);

export function AppSettingsProvider(props: { children: ReactNode; walletControls?: SettingsWalletControls }) {
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [preferences, setPreferences] = useState<ValueApproximationPreferences>(DEFAULT_VALUE_APPROXIMATION_PREFERENCES);
  const [rates, setRates] = useState<SolReferenceRates | null>(null);
  const [ready, setReady] = useState(false);
  const [approximationLoading, setApproximationLoading] = useState(false);
  const [approximationError, setApproximationError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    void Promise.all([loadValueApproximationPreferences(), loadSolReferenceRates()]).then(([storedPreferences, storedRates]) => {
      if (!mounted) {
        return;
      }
      setPreferences(storedPreferences);
      setRates(storedRates);
      setReady(true);
    });

    return () => {
      mounted = false;
    };
  }, []);

  const refreshApproximationRates = useCallback(async () => {
    setApproximationLoading(true);
    setApproximationError(null);
    try {
      const nextRates = await fetchSolReferenceRates();
      setRates(nextRates);
      await saveSolReferenceRates(nextRates);
    } catch (error) {
      setApproximationError(error instanceof Error ? error.message : String(error));
    } finally {
      setApproximationLoading(false);
    }
  }, []);

  const updateApproximationPreferences = useCallback(
    async (patch: Partial<ValueApproximationPreferences>) => {
      const nextPreferences: ValueApproximationPreferences = {
        enabled: patch.enabled ?? preferences.enabled,
        asset: patch.asset ?? preferences.asset,
      };
      setPreferences(nextPreferences);
      await saveValueApproximationPreferences(nextPreferences);
      if (nextPreferences.enabled && !rates) {
        await refreshApproximationRates();
      }
    },
    [preferences, rates, refreshApproximationRates],
  );

  useEffect(() => {
    if (!ready || !preferences.enabled || rates || approximationLoading) {
      return;
    }
    void refreshApproximationRates();
  }, [approximationLoading, preferences.enabled, rates, ready, refreshApproximationRates]);

  const value = useMemo<AppSettingsContextValue>(
    () => ({
      approximation: {
        preferences,
        rates,
      },
      approximationLoading,
      approximationError,
      openSettings: () => setSettingsVisible(true),
      closeSettings: () => setSettingsVisible(false),
      updateApproximationPreferences,
      refreshApproximationRates,
    }),
    [approximationError, approximationLoading, preferences, rates, refreshApproximationRates, updateApproximationPreferences],
  );

  return (
    <AppSettingsContext.Provider value={value}>
      {props.children}
      <SettingsModal visible={settingsVisible} walletControls={props.walletControls} />
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings() {
  return useContext(AppSettingsContext);
}

function SettingsModal(props: { visible: boolean; walletControls?: SettingsWalletControls }) {
  const { t } = useI18n();
  const {
    approximation,
    approximationError,
    approximationLoading,
    closeSettings,
    refreshApproximationRates,
    updateApproximationPreferences,
  } = useAppSettings();
  const { preferences, rates } = approximation;

  return (
    <Modal animationType="slide" visible={props.visible} onRequestClose={closeSettings}>
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.kicker}>{t("settings.kicker")}</Text>
            <Text style={styles.title}>{t("settings.title")}</Text>
          </View>
          <Pressable accessibilityLabel={t("common.close")} style={styles.closeButton} onPress={closeSettings}>
            <Feather name="x" size={20} color={palette.ink} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <SurfaceCard variant="danger" style={styles.warningCard}>
            <View style={styles.warningHeader}>
              <StatusChip label={t("settings.approx.warningChip")} tone="danger" />
              <Feather name="alert-triangle" size={18} color={palette.coral} />
            </View>
            <Text style={styles.warningTitle}>{t("settings.approx.warningTitle")}</Text>
            <Text style={styles.warningBody}>{t("settings.approx.warningBody")}</Text>
            <Text style={styles.warningBody}>{t("settings.approx.offlineWarning")}</Text>
          </SurfaceCard>

          <SurfaceCard style={styles.card}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleCopy}>
                <Text style={styles.cardTitle}>{t("settings.approx.enableTitle")}</Text>
                <Text style={styles.cardBody}>{t("settings.approx.enableBody")}</Text>
              </View>
              <Switch
                value={preferences.enabled}
                onValueChange={(enabled) => {
                  void updateApproximationPreferences({ enabled });
                }}
                thumbColor={preferences.enabled ? palette.cyan : palette.mutedStrong}
                trackColor={{ false: palette.lineStrong, true: palette.skySoft }}
              />
            </View>

            <View style={styles.optionList}>
              {APPROXIMATION_ASSETS.map((asset) => (
                <ApproximationAssetOption
                  key={asset}
                  asset={asset}
                  active={preferences.asset === asset}
                  disabled={!preferences.enabled}
                  onPress={() => {
                    void updateApproximationPreferences({ asset });
                  }}
                />
              ))}
            </View>
          </SurfaceCard>

          <SurfaceCard style={styles.card}>
            <View style={styles.sourceHeader}>
              <View style={styles.sourceIcon}>
                <Feather name="activity" size={18} color={palette.sky} />
              </View>
              <View style={styles.sourceCopy}>
                <Text style={styles.cardTitle}>{t("settings.approx.referenceTitle")}</Text>
                <Text style={styles.cardBody}>{t("settings.approx.referenceBody")}</Text>
              </View>
            </View>
            <View style={styles.referenceGrid}>
              <ReferenceItem label={t("settings.approx.referenceSource")} value={rates ? "CoinGecko" : t("settings.approx.noCache")} />
              <ReferenceItem label={t("settings.approx.updatedAt")} value={formatApproximationUpdatedAt(rates)} />
            </View>
            {approximationError ? (
              <AlertBanner tone="warning" message={t("settings.approx.refreshError", { error: approximationError })} />
            ) : null}
            <ActionButton
              label={approximationLoading ? t("common.working") : t("settings.approx.refresh")}
              icon="refresh-cw"
              variant="secondary"
              disabled={approximationLoading}
              onPress={() => {
                void refreshApproximationRates();
              }}
            />
          </SurfaceCard>

          {props.walletControls ? <SettingsWalletCard controls={props.walletControls} /> : null}
          <SettingsSwapQuoteCard networkOnline={props.walletControls?.networkOnline ?? true} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function SettingsWalletCard(props: { controls: SettingsWalletControls }) {
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const online = props.controls.networkOnline;

  async function createWallet() {
    setStatus(null);
    await props.controls.onCreateWallet({
      displayName: displayName.trim() || undefined,
      passphrase,
    });
    setPassphrase("");
    setDisplayName("");
    setStatus(t("settings.wallet.created"));
  }

  return (
    <SurfaceCard style={styles.card}>
      <View style={styles.sourceHeader}>
        <View style={styles.sourceIcon}>
          <Feather name="credit-card" size={18} color={palette.sky} />
        </View>
        <View style={styles.sourceCopy}>
          <Text style={styles.cardTitle}>{t("settings.wallet.title")}</Text>
          <Text style={styles.cardBody}>{t("settings.wallet.body")}</Text>
        </View>
      </View>
      {!online ? <AlertBanner tone="warning" message={t("settings.wallet.offline")} /> : null}

      <View style={styles.walletList}>
        {props.controls.wallets.map((wallet) => (
          <View key={wallet.walletId} style={styles.walletRow}>
            <View style={styles.walletCopy}>
              <Text style={styles.walletTitle}>{wallet.displayName}</Text>
              <Text style={styles.walletAddress} numberOfLines={1}>
                {wallet.solanaAddress}
              </Text>
            </View>
            {wallet.walletId === props.controls.activeWalletId || wallet.isActiveOnDevice ? (
              <StatusChip label={t("settings.wallet.active")} tone="success" />
            ) : (
              <ActionButton
                label={t("settings.wallet.select")}
                icon="check"
                variant="secondary"
                disabled={!online || props.controls.busy}
                onPress={() => {
                  void props.controls.onSelectWallet(wallet.walletId);
                }}
              />
            )}
          </View>
        ))}
      </View>

      <View style={styles.formGrid}>
        <TextInput
          value={displayName}
          onChangeText={setDisplayName}
          style={styles.input}
          placeholder={t("settings.wallet.displayName")}
          placeholderTextColor={palette.mutedStrong}
        />
        <TextInput
          value={passphrase}
          onChangeText={setPassphrase}
          style={styles.input}
          placeholder={t("settings.wallet.passphrase")}
          placeholderTextColor={palette.mutedStrong}
          secureTextEntry
        />
      </View>
      {status ? <AlertBanner tone="success" message={status} /> : null}
      <ActionButton
        label={props.controls.busy ? t("common.working") : t("settings.wallet.create")}
        icon="plus"
        disabled={!online || props.controls.busy || passphrase.length < 8}
        onPress={() => {
          void createWallet();
        }}
      />
    </SurfaceCard>
  );
}

function SettingsSwapQuoteCard(props: { networkOnline: boolean }) {
  const { t } = useI18n();
  const { approximation } = useAppSettings();
  const [amount, setAmount] = useState("0.05");
  const [fromAsset, setFromAsset] = useState<GatewayPaymentAsset>("SOL");
  const [toAsset, setToAsset] = useState<GatewayPaymentAsset>("OFFAIR");
  const quote = useMemo(
    () =>
      quoteGatewayAssetConversion({
        receiveAmount: amount,
        receiveAsset: toAsset,
        payAsset: fromAsset,
        rates: approximation.rates,
        gatewayFeeBps: 0,
      }),
    [amount, approximation.rates, fromAsset, toAsset],
  );

  return (
    <SurfaceCard style={styles.card}>
      <View style={styles.sourceHeader}>
        <View style={styles.sourceIcon}>
          <Feather name="repeat" size={18} color={palette.sky} />
        </View>
        <View style={styles.sourceCopy}>
          <Text style={styles.cardTitle}>{t("settings.swap.title")}</Text>
          <Text style={styles.cardBody}>{t("settings.swap.body")}</Text>
        </View>
      </View>
      {!props.networkOnline ? <AlertBanner tone="warning" message={t("settings.swap.offline")} /> : null}

      <View style={styles.inputGroup}>
        <Text style={styles.referenceLabel}>{t("settings.swap.from")}</Text>
        <ActionRail
          activeId={fromAsset}
          items={GATEWAY_PAYMENT_ASSETS.map((asset) => ({
            id: asset,
            label: asset,
            icon: asset === "OFFAIR" ? "radio" : asset === "SOL" ? "activity" : "dollar-sign",
            disabled: !props.networkOnline,
          }))}
          onSelect={setFromAsset}
        />
      </View>
      <View style={styles.inputGroup}>
        <Text style={styles.referenceLabel}>{t("settings.swap.to")}</Text>
        <ActionRail
          activeId={toAsset}
          items={GATEWAY_PAYMENT_ASSETS.map((asset) => ({
            id: asset,
            label: asset,
            icon: asset === "OFFAIR" ? "radio" : asset === "SOL" ? "activity" : "dollar-sign",
            disabled: !props.networkOnline,
          }))}
          onSelect={setToAsset}
        />
      </View>
      <TextInput
        value={amount}
        onChangeText={(value) => setAmount(normalizeDecimalInput(value))}
        style={styles.input}
        keyboardType="decimal-pad"
        placeholder={t("settings.swap.amount")}
        placeholderTextColor={palette.mutedStrong}
      />
      {quote ? (
        <AlertBanner
          tone={quote.route === "offair_via_sol" ? "warning" : "info"}
          message={t("settings.swap.quote", {
            payAmount: quote.payAmount,
            payAsset: quote.payAsset,
            receiveAmount: formatAssetAmount(quote.receiveAmount, quote.receiveAsset),
            receiveAsset: quote.receiveAsset,
            fee: (quote.conversionFeeBps / 100).toFixed(2),
          })}
        />
      ) : (
        <AlertBanner tone="warning" message={t("settings.swap.needsRates")} />
      )}
    </SurfaceCard>
  );
}

function ApproximationAssetOption(props: {
  asset: ApproximationAsset;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useI18n();

  return (
    <Pressable
      disabled={props.disabled}
      style={({ pressed }) => [
        styles.assetOption,
        props.active && styles.assetOptionActive,
        props.disabled && styles.assetOptionDisabled,
        pressed && !props.disabled ? styles.pressed : null,
      ]}
      onPress={props.onPress}
    >
      <View style={styles.assetOptionHeader}>
        <Text style={[styles.assetOptionTitle, props.active && styles.assetOptionTitleActive]}>{props.asset}</Text>
        {props.active ? <Feather name="check" size={16} color={palette.cyan} /> : null}
      </View>
      <Text style={styles.assetOptionBody}>{t(`settings.approx.asset.${props.asset}`)}</Text>
    </Pressable>
  );
}

function ReferenceItem(props: { label: string; value: string }) {
  return (
    <View style={styles.referenceItem}>
      <Text style={styles.referenceLabel}>{props.label}</Text>
      <Text style={styles.referenceValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
        {props.value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
    backgroundColor: palette.overlay,
  },
  headerCopy: {
    flex: 1,
    gap: 2,
  },
  kicker: {
    ...typeRamp.label,
    color: palette.cyan,
  },
  title: {
    ...typeRamp.title,
    color: palette.ink,
  },
  closeButton: {
    width: 42,
    height: 42,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.line,
    ...shadows.floating,
  },
  content: {
    gap: 16,
    padding: 18,
    paddingBottom: 28,
  },
  card: {
    gap: 16,
  },
  warningCard: {
    gap: 10,
  },
  warningHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  warningTitle: {
    ...typeRamp.titleCompact,
    color: palette.coral,
  },
  warningBody: {
    ...typeRamp.body,
    color: palette.ink,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  toggleCopy: {
    flex: 1,
    gap: 4,
  },
  cardTitle: {
    ...typeRamp.bodyStrong,
    color: palette.ink,
  },
  cardBody: {
    ...typeRamp.body,
  },
  optionList: {
    gap: 10,
  },
  assetOption: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surfaceAlt,
    padding: 14,
    gap: 5,
  },
  assetOptionActive: {
    borderColor: palette.cyan,
    backgroundColor: palette.skySoft,
  },
  assetOptionDisabled: {
    opacity: 0.55,
  },
  assetOptionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  assetOptionTitle: {
    ...typeRamp.bodyStrong,
    color: palette.ink,
  },
  assetOptionTitleActive: {
    color: palette.sky,
  },
  assetOptionBody: {
    ...typeRamp.caption,
  },
  sourceHeader: {
    flexDirection: "row",
    gap: 12,
  },
  sourceIcon: {
    width: 38,
    height: 38,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surfaceAlt,
  },
  sourceCopy: {
    flex: 1,
    gap: 4,
  },
  referenceGrid: {
    flexDirection: "row",
    gap: 10,
  },
  inputGroup: {
    gap: 8,
  },
  input: {
    minHeight: 54,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: palette.ink,
    ...typeRamp.bodyStrong,
  },
  formGrid: {
    gap: 10,
  },
  walletList: {
    gap: 10,
  },
  walletRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surfaceAlt,
    padding: 12,
  },
  walletCopy: {
    flex: 1,
    gap: 4,
  },
  walletTitle: {
    ...typeRamp.bodyStrong,
    color: palette.ink,
  },
  walletAddress: {
    ...typeRamp.mono,
    color: palette.muted,
  },
  referenceItem: {
    flex: 1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surfaceAlt,
    padding: 12,
    gap: 4,
  },
  referenceLabel: {
    ...typeRamp.label,
  },
  referenceValue: {
    ...typeRamp.bodyStrong,
    color: palette.ink,
  },
  pressed: {
    opacity: 0.88,
    transform: [{ scale: 0.99 }],
  },
});
