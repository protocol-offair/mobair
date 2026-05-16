import { useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { AssetBalance, WalletProfile, WalletRegistryEntry, WalletSecurityState } from "@protocol-offair/shared";

import type { OnboardingState } from "../services/wallet";
import { airPayTestIds } from "../testing/testIds";
import { palette, radii, typeRamp } from "../theme/palette";
import { formatDateTime } from "../i18n";
import { useI18n } from "../i18n/I18nProvider";
import { ActionRail } from "./ui/ActionRail";
import { ActionButton } from "./ui/ActionButton";
import { StatusChip } from "./ui/StatusChip";
import { SurfaceCard } from "./ui/SurfaceCard";

export function WalletSetupPanel(props: {
  busy: boolean;
  profile: WalletProfile | null;
  walletRegistry: WalletRegistryEntry[];
  security: WalletSecurityState | null;
  balances?: Record<"OFFAIR" | "SOL", AssetBalance>;
  onboarding: OnboardingState | null;
  offlineReady: boolean;
  mnemonicPreview: string | null;
  onCreate: (input: { passphrase: string; displayName?: string }) => Promise<void>;
  onImport: (input: { mnemonic: string; passphrase: string; displayName?: string }) => Promise<void>;
  onSelectWallet: (walletId: string) => Promise<void>;
  onReveal: () => Promise<void>;
  onConfirmBackup: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onRefreshProtocolState: () => Promise<void>;
  onDismissMnemonic: () => void;
}) {
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const lastAddressTapRef = useRef(0);
  const hasWallet = Boolean(props.profile);
  const solBalanceAmount = props.balances?.SOL?.amount ?? "0";
  const offairBalanceAmount = props.balances?.OFFAIR?.amount ?? "0";

  async function handleAddressPress() {
    if (!props.profile?.solanaAddress) {
      return;
    }

    const now = Date.now();
    if (now - lastAddressTapRef.current < 320) {
      await Clipboard.setStringAsync(props.profile.solanaAddress);
      Alert.alert(t("wallet.addressCopied.title"), t("wallet.addressCopied.body"));
      lastAddressTapRef.current = 0;
      return;
    }

    lastAddressTapRef.current = now;
  }

  return (
    <SurfaceCard variant="raised">
      <View testID={airPayTestIds.wallet.card} style={styles.content}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.kicker}>{t("wallet.kicker")}</Text>
            <Text style={styles.title}>{hasWallet ? t("wallet.title.globalReady") : t("wallet.title.globalEmpty")}</Text>
          </View>
          <StatusChip
            label={props.offlineReady ? t("wallet.status.offlineReady") : hasWallet ? t("wallet.status.setupPending") : t("wallet.status.noWallet")}
            tone={props.offlineReady ? "success" : hasWallet ? "warning" : "muted"}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("wallet.identity.section")}</Text>
          <Text style={styles.helperText}>{t("wallet.identity.helperGlobal")}</Text>
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            style={styles.input}
            autoCapitalize="words"
            autoCorrect={false}
            textContentType="name"
            returnKeyType="next"
            placeholder={t("wallet.input.displayName")}
            placeholderTextColor={palette.mutedStrong}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("wallet.registry.section")}</Text>
          {props.walletRegistry.length === 0 ? (
            <Text style={styles.helperText}>{t("wallet.registry.empty")}</Text>
          ) : (
            props.walletRegistry.map((entry) => (
              <View key={entry.walletId} style={styles.registryRow}>
                <View style={styles.registryCopy}>
                  <Text style={styles.registryName}>{entry.displayName}</Text>
                  <Text style={styles.registryMeta}>{entry.solanaAddress}</Text>
                </View>
                <View style={styles.registryActions}>
                  <StatusChip
                    label={entry.isActiveOnDevice ? t("wallet.registry.active") : t("wallet.registry.switch")}
                    tone={entry.isActiveOnDevice ? "success" : "muted"}
                  />
                  {!entry.isActiveOnDevice ? (
                    <ActionButton
                      label={t("wallet.registry.switch")}
                      variant="secondary"
                      disabled={props.busy}
                      onPress={() => props.onSelectWallet(entry.walletId)}
                    />
                  ) : null}
                </View>
              </View>
            ))
          )}
        </View>

        {props.profile ? (
          <View style={styles.summary}>
            <Pressable testID={airPayTestIds.wallet.addressCopyArea} onPress={() => void handleAddressPress()} style={styles.addressPressable}>
              <Text testID={airPayTestIds.wallet.addressMeta} style={styles.address}>
                {props.profile.solanaAddress}
              </Text>
              <Text style={styles.addressHint}>{t("wallet.addressCopied.hint")}</Text>
            </Pressable>
            <View style={styles.metaGrid}>
              <Text style={styles.metaLine}>{t("wallet.meta.derivation", { path: props.profile.derivationPath })}</Text>
              <Text style={styles.metaLine}>
                {props.profile.backupConfirmedAt
                  ? t("wallet.meta.backupConfirmed", { date: formatDateTime(props.profile.backupConfirmedAt) })
                  : t("wallet.meta.backupPending")}
              </Text>
              <Text style={styles.metaLine}>
                {props.security?.biometricProtected ? t("wallet.meta.security.biometric") : t("wallet.meta.security.secureStore")}
              </Text>
              <Text style={styles.metaLine}>
                {t("wallet.meta.registrationGlobal", {
                  device: props.onboarding?.deviceKeyReady ? t("common.state.registered") : t("common.state.pending"),
                  wallet: props.onboarding?.onChainProfileReady ? t("common.state.registered") : t("common.state.pending"),
                })}
              </Text>
              <Text style={styles.metaLine}>
                {t("wallet.meta.pqKey", {
                  key: `${props.profile.postQuantumPublicKey.slice(0, 16)}...`,
                })}
              </Text>
              <Text testID={airPayTestIds.wallet.readinessMeta} style={[styles.metaLine, props.offlineReady ? styles.ready : styles.pending]}>
                {props.onboarding?.quarantined
                  ? t("wallet.meta.readiness.quarantined")
                  : props.offlineReady
                    ? t("wallet.meta.readiness.ready")
                    : t("wallet.meta.readiness.pending")}
              </Text>
            </View>
            <View style={styles.balanceRow}>
              <View style={styles.balancePill}>
                <Text style={styles.balanceLabel}>{t("wallet.balance.sol")}</Text>
                <Text testID={airPayTestIds.wallet.solBalance} style={styles.balanceValue}>
                  {solBalanceAmount}
                </Text>
              </View>
              <View style={styles.balancePill}>
                <Text style={styles.balanceLabel}>{t("wallet.balance.offair")}</Text>
                <Text style={styles.balanceValue}>{offairBalanceAmount}</Text>
              </View>
            </View>
          </View>
        ) : null}

        <TextInput
          testID={airPayTestIds.wallet.passphraseInput}
          value={passphrase}
          onChangeText={setPassphrase}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("wallet.input.passphrase")}
          secureTextEntry
          placeholderTextColor={palette.mutedStrong}
        />

        {!hasWallet ? (
          <>
            <TextInput
              testID={airPayTestIds.wallet.mnemonicInput}
              value={mnemonic}
              onChangeText={setMnemonic}
              style={[styles.input, styles.multiline]}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t("wallet.input.mnemonic")}
              placeholderTextColor={palette.mutedStrong}
            />
            <ActionButton
              testID={airPayTestIds.wallet.createButton}
              label={props.busy ? t("common.working") : t("wallet.create")}
              disabled={props.busy}
              onPress={() => props.onCreate({ passphrase, displayName: displayName.trim() || undefined })}
            />
            <ActionRail
              items={[
                { id: "import", label: t("wallet.import"), icon: "download", disabled: props.busy },
              ]}
              onSelect={(id) => {
                if (id === "import") {
                  void props.onImport({ mnemonic, passphrase, displayName: displayName.trim() || undefined });
                }
              }}
            />
          </>
        ) : (
          <>
            <ActionButton
              testID={airPayTestIds.wallet.syncProvisioningButton}
              label={t("wallet.syncProtocol")}
              disabled={props.busy || props.onboarding?.quarantined}
              onPress={() => props.onRefreshProtocolState()}
            />
            <ActionRail
              items={[
                { id: "reveal", label: t("wallet.reveal"), icon: "eye", disabled: props.busy },
                { id: "refresh", label: t("wallet.refreshBalances"), icon: "refresh-cw", disabled: props.busy },
              ]}
              onSelect={(id) => {
                if (id === "reveal") {
                  void props.onReveal();
                } else {
                  void props.onRefresh();
                }
              }}
            />
          </>
        )}

        {props.profile && !props.profile.backupConfirmedAt ? (
          <ActionButton
            testID={airPayTestIds.wallet.confirmBackupButton}
            label={t("wallet.confirmBackup")}
            disabled={props.busy}
            onPress={() => props.onConfirmBackup()}
          />
        ) : null}

        {props.mnemonicPreview ? (
          <SurfaceCard style={styles.mnemonicCard}>
            <Text testID={airPayTestIds.wallet.mnemonicCard} style={styles.mnemonicLabel}>
              {t("wallet.mnemonic.title")}
            </Text>
            <Text style={styles.mnemonicValue}>{props.mnemonicPreview}</Text>
            <ActionButton
              testID={airPayTestIds.wallet.mnemonicDismissButton}
              label={t("wallet.mnemonic.hide")}
              variant="ghost"
              onPress={props.onDismissMnemonic}
            />
          </SurfaceCard>
        ) : null}
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
  },
  header: {
    gap: 12,
  },
  headerCopy: {
    gap: 6,
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    ...typeRamp.label,
    color: palette.cyan,
  },
  helperText: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  kicker: {
    ...typeRamp.label,
    color: palette.sky,
  },
  title: {
    ...typeRamp.title,
  },
  summary: {
    gap: 14,
    backgroundColor: palette.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.line,
    padding: 18,
  },
  addressPressable: {
    gap: 6,
  },
  registryRow: {
    gap: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    padding: 14,
    backgroundColor: palette.surface,
  },
  registryCopy: {
    gap: 4,
  },
  registryName: {
    ...typeRamp.bodyStrong,
  },
  registryMeta: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  registryActions: {
    gap: 10,
  },
  address: {
    ...typeRamp.bodyStrong,
    color: palette.sky,
  },
  addressHint: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  metaGrid: {
    gap: 6,
  },
  metaLine: {
    ...typeRamp.body,
  },
  ready: {
    color: palette.mint,
  },
  pending: {
    color: palette.amber,
  },
  balanceRow: {
    flexDirection: "row",
    gap: 12,
  },
  balancePill: {
    flex: 1,
    gap: 4,
    borderRadius: radii.md,
    backgroundColor: palette.surfaceAlt,
    padding: 14,
  },
  balanceLabel: {
    ...typeRamp.label,
  },
  balanceValue: {
    ...typeRamp.titleCompact,
    color: palette.cyan,
  },
  input: {
    minHeight: 56,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: palette.ink,
    fontFamily: typeRamp.body.fontFamily,
    fontSize: 15,
  },
  multiline: {
    minHeight: 120,
    textAlignVertical: "top",
  },
  actions: {
    flexDirection: "row",
    gap: 12,
  },
  primaryAction: {
    flex: 1,
  },
  secondaryAction: {
    flex: 1,
  },
  mnemonicCard: {
    padding: 18,
    gap: 12,
  },
  mnemonicLabel: {
    ...typeRamp.label,
    color: palette.cyan,
  },
  mnemonicValue: {
    ...typeRamp.mono,
    color: palette.ink,
  },
});
