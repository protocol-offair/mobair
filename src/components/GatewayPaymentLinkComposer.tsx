import { useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";

import { formatAssetAmount } from "../i18n";
import { useI18n } from "../i18n/I18nProvider";
import { buildLocalGatewayPaymentLink, type OnlinePaymentRequest } from "../services/paymentRequest";
import { normalizeDecimalInput } from "../services/inputFormatters";
import {
  formatApproximateAssetAmount,
  formatApproximationUpdatedAt,
} from "../services/valueApproximation";
import {
  GATEWAY_PAYMENT_ASSETS,
  quoteGatewayAssetConversion,
  type GatewayPaymentAsset,
} from "../services/assetConversion";
import { useAppSettings } from "../settings/AppSettingsProvider";
import { palette, radii, typeRamp } from "../theme/palette";
import { ActionButton } from "./ui/ActionButton";
import { ActionRail } from "./ui/ActionRail";
import { AlertBanner } from "./ui/AlertBanner";
import { StatusChip } from "./ui/StatusChip";
import { SurfaceCard } from "./ui/SurfaceCard";

type AmountMode = "sol" | "reference";

function normalizeSolAmount(value: string): string | null {
  const normalized = value.endsWith(".") ? value.slice(0, -1) : value;
  if (!/^\d+(\.\d{1,9})?$/.test(normalized)) {
    return null;
  }
  return Number(normalized) > 0 ? normalized.replace(/^0+(?=\d)/, "") : null;
}

export function GatewayPaymentLinkComposer(props: {
  merchantWallet?: string | null;
  networkOnline: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const { approximation } = useAppSettings();
  const [amountMode, setAmountMode] = useState<AmountMode>("sol");
  const [amount, setAmount] = useState("0.05");
  const [receiveAsset, setReceiveAsset] = useState<GatewayPaymentAsset>("SOL");
  const [payAsset, setPayAsset] = useState<GatewayPaymentAsset>("SOL");
  const [label, setLabel] = useState("AirPay merchant");
  const [message, setMessage] = useState("");
  const [generatedRequest, setGeneratedRequest] = useState<OnlinePaymentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const referenceAsset = approximation.preferences.asset;
  const referenceModeAvailable = approximation.preferences.enabled && Boolean(approximation.rates);
  const receiveAmount = normalizeSolAmount(amount);
  const quote = useMemo(
    () =>
      receiveAmount
        ? quoteGatewayAssetConversion({
            receiveAmount,
            receiveAsset,
            payAsset,
            rates: approximation.rates,
          })
        : null,
    [approximation.rates, payAsset, receiveAmount, receiveAsset],
  );
  const solAmount = quote?.solAmount ?? (receiveAsset === "SOL" ? receiveAmount : null);
  const solApproximation = solAmount ? formatApproximateAssetAmount(solAmount, "SOL", approximation) : null;
  const requiresQuote = receiveAsset !== "SOL" || payAsset !== "SOL";
  const generateDisabled = props.disabled || !props.merchantWallet || !solAmount || !receiveAmount || (requiresQuote && !quote);

  async function generateLink() {
    setError(null);
    setCopied(false);

    if (!props.merchantWallet) {
      setError(t("gatewayLink.error.walletRequired"));
      return;
    }
    if (!solAmount || !receiveAmount) {
      setError(t("gatewayLink.error.amount"));
      return;
    }

    try {
      const request = buildLocalGatewayPaymentLink({
        merchantWallet: props.merchantWallet,
        amount: receiveAmount,
        receiveCurrency: receiveAsset,
        payCurrency: payAsset,
        solAmount,
        label: label.trim() || undefined,
        message: message.trim() || undefined,
        gatewayFeeBps: quote?.gatewayFeeBps ?? 70,
        conversionFeeBps: quote?.conversionFeeBps,
        totalFeeBps: quote?.totalFeeBps,
        allowedPayCurrencies: GATEWAY_PAYMENT_ASSETS,
        displayAmount: amountMode === "reference" ? amount : undefined,
        displayCurrency: amountMode === "reference" ? receiveAsset : undefined,
        displayRateFetchedAt: amountMode === "reference" ? approximation.rates?.fetchedAt : undefined,
      });
      setGeneratedRequest(request);
      await Clipboard.setStringAsync(request.raw);
      setCopied(true);
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : String(buildError));
    }
  }

  return (
    <SurfaceCard variant="raised" style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.kicker}>{t("gatewayLink.kicker")}</Text>
          <Text style={styles.title}>{t("gatewayLink.title")}</Text>
          <Text style={styles.body}>{t("gatewayLink.body")}</Text>
        </View>
        <StatusChip label={t("gatewayLink.fee")} tone="info" />
      </View>

      {!props.networkOnline ? (
        <AlertBanner tone="warning" message={t("gatewayLink.offlineBody")} />
      ) : (
        <AlertBanner tone="info" message={t("gatewayLink.onlineBody")} />
      )}

      {approximation.preferences.enabled && !props.networkOnline ? (
        <AlertBanner tone="danger" message={t("gatewayLink.reference.offlineWarning")} />
      ) : null}

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>{t("gatewayLink.receiveAsset")}</Text>
        <ActionRail
          activeId={receiveAsset}
          items={GATEWAY_PAYMENT_ASSETS.map((asset) => ({
            id: asset,
            label: asset,
            icon: asset === "OFFAIR" ? "radio" : asset === "SOL" ? "activity" : "dollar-sign",
          }))}
          onSelect={(asset) => {
            setReceiveAsset(asset);
            setAmountMode(asset === "SOL" ? "sol" : "reference");
            setGeneratedRequest(null);
            setCopied(false);
          }}
        />
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>{t("gatewayLink.payAsset")}</Text>
        <ActionRail
          activeId={payAsset}
          items={GATEWAY_PAYMENT_ASSETS.map((asset) => ({
            id: asset,
            label: asset,
            icon: asset === "OFFAIR" ? "radio" : asset === "SOL" ? "activity" : "dollar-sign",
          }))}
          onSelect={(asset) => {
            setPayAsset(asset);
            setGeneratedRequest(null);
            setCopied(false);
          }}
        />
      </View>

      <ActionRail
        activeId={amountMode}
        items={[
          { id: "sol", label: t("gatewayLink.mode.sol"), icon: "activity" },
          {
            id: "reference",
            label: t("gatewayLink.mode.reference", { asset: referenceAsset }),
            icon: "dollar-sign",
            disabled: !referenceModeAvailable,
          },
        ]}
        onSelect={(nextMode) => {
          setAmountMode(nextMode);
          setGeneratedRequest(null);
          setCopied(false);
          setError(null);
        }}
      />

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>
          {amountMode === "reference"
            ? t("gatewayLink.input.reference", { asset: receiveAsset === "SOL" ? referenceAsset : receiveAsset })
            : t("gatewayLink.input.sol")}
        </Text>
        <TextInput
          value={amount}
          onChangeText={(value) => {
            setAmount(normalizeDecimalInput(value));
            setGeneratedRequest(null);
            setCopied(false);
          }}
          style={styles.input}
          keyboardType="decimal-pad"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={amountMode === "reference" ? `10 ${receiveAsset === "SOL" ? referenceAsset : receiveAsset}` : "0.05 SOL"}
          placeholderTextColor={palette.mutedStrong}
        />
        {solAmount ? (
          <Text style={styles.helper}>
            {t("gatewayLink.calculatedSol", { amount: formatAssetAmount(solAmount, "SOL") })}
            {solApproximation ? ` · ${solApproximation}` : ""}
          </Text>
        ) : (
          <Text style={styles.helper}>{t("gatewayLink.helper")}</Text>
        )}
      </View>

      <View style={styles.row}>
        <TextInput
          value={label}
          onChangeText={setLabel}
          style={[styles.input, styles.rowInput]}
          autoCapitalize="sentences"
          autoCorrect={false}
          placeholder={t("gatewayLink.input.label")}
          placeholderTextColor={palette.mutedStrong}
        />
        <TextInput
          value={message}
          onChangeText={setMessage}
          style={[styles.input, styles.rowInput]}
          autoCapitalize="sentences"
          autoCorrect={false}
          placeholder={t("gatewayLink.input.message")}
          placeholderTextColor={palette.mutedStrong}
        />
      </View>

      {amountMode === "reference" && approximation.rates ? (
        <Text style={styles.referenceMeta}>
          {t("gatewayLink.reference.cache", {
            asset: receiveAsset === "SOL" ? referenceAsset : receiveAsset,
            updatedAt: formatApproximationUpdatedAt(approximation.rates),
          })}
        </Text>
      ) : null}

      {quote ? (
        <AlertBanner
          tone={quote.route === "direct_sol" ? "info" : "warning"}
          message={t("gatewayLink.quote", {
            payAmount: quote.payAmount,
            payAsset: quote.payAsset,
            receiveAmount: quote.receiveAmount,
            receiveAsset: quote.receiveAsset,
            fee: (quote.totalFeeBps / 100).toFixed(2),
          })}
        />
      ) : null}

      {error ? <AlertBanner tone="danger" message={error} /> : null}
      {copied ? <AlertBanner tone="success" message={t("gatewayLink.copied")} /> : null}

      {generatedRequest ? (
        <View style={styles.linkBox}>
          <Text style={styles.linkLabel}>{t("gatewayLink.output")}</Text>
          <Text selectable style={styles.linkText}>
            {generatedRequest.raw}
          </Text>
        </View>
      ) : null}

      <ActionButton
        label={t("gatewayLink.action.generate")}
        icon="link"
        disabled={generateDisabled}
        onPress={() => {
          void generateLink();
        }}
      />
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 16,
  },
  header: {
    gap: 12,
  },
  headerCopy: {
    gap: 6,
  },
  kicker: {
    ...typeRamp.label,
    color: palette.cyan,
  },
  title: {
    ...typeRamp.title,
  },
  body: {
    ...typeRamp.body,
  },
  inputGroup: {
    gap: 8,
  },
  inputLabel: {
    ...typeRamp.label,
    color: palette.ink,
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
  row: {
    flexDirection: "row",
    gap: 12,
  },
  rowInput: {
    flex: 1,
  },
  helper: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  referenceMeta: {
    ...typeRamp.caption,
    color: palette.amber,
  },
  linkBox: {
    gap: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    backgroundColor: palette.surfaceAlt,
    padding: 12,
  },
  linkLabel: {
    ...typeRamp.label,
    color: palette.muted,
  },
  linkText: {
    ...typeRamp.mono,
    color: palette.ink,
  },
});
