import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import Feather from "@expo/vector-icons/Feather";
import { useIsFocused } from "@react-navigation/native";

import { airPayTestIds } from "../testing/testIds";
import { formatAssetAmount } from "../i18n";
import { useI18n } from "../i18n/I18nProvider";
import { useAppSettings } from "../settings/AppSettingsProvider";
import { formatApproximateAssetAmount } from "../services/valueApproximation";
import {
  GATEWAY_PAYMENT_ASSETS,
  quoteGatewayAssetConversion,
  type GatewayPaymentAsset,
} from "../services/assetConversion";
import {
  parseOnlinePaymentRequest,
  paymentRequestMemo,
  type OnlinePaymentRequest,
} from "../services/paymentRequest";
import { palette, radii, typeRamp } from "../theme/palette";
import { ActionRail } from "./ui/ActionRail";
import { ActionButton } from "./ui/ActionButton";
import { AlertBanner } from "./ui/AlertBanner";
import { StatusChip } from "./ui/StatusChip";
import { SurfaceCard } from "./ui/SurfaceCard";

type GatewayPaymentMode = "paste" | "scan";

function trimMiddle(value?: string, size = 8) {
  if (!value) {
    return "—";
  }
  if (value.length <= size * 2 + 3) {
    return value;
  }
  return `${value.slice(0, size)}...${value.slice(-size)}`;
}

function detailRows(request: OnlinePaymentRequest) {
  const rows = [
    { label: "gatewayPay.detail.wallet", value: trimMiddle(request.wallet), raw: request.wallet },
    { label: "gatewayPay.detail.reference", value: trimMiddle(request.reference), raw: request.reference },
    { label: "gatewayPay.detail.intent", value: request.intentId ?? paymentRequestMemo(request) ?? "—" },
    { label: "gatewayPay.detail.label", value: request.label ?? request.message ?? "—" },
  ] as Array<{ label: string; value: string; raw?: string; localized?: boolean }>;

  if (typeof request.gatewayFeeBps === "number") {
    rows.push({
      label: "gatewayPay.detail.fee",
      value: `${(request.gatewayFeeBps / 100).toFixed(2)}%`,
    });
  }

  if (request.settlementMode === "gateway_deferred_online") {
    rows.push({
      label: "gatewayPay.detail.mode",
      value: "gatewayPay.detail.modeDeferred",
      localized: true,
    });
  }

  return rows;
}

function paymentCompletionKey(request: OnlinePaymentRequest) {
  return request.intentId ?? request.reference ?? `${request.wallet}:${request.amount}:${paymentRequestMemo(request) ?? request.raw}`;
}

export function GatewayPaymentComposer(props: {
  initialPayload?: string;
  busy: boolean;
  disabled?: boolean;
  mode?: GatewayPaymentMode;
  onModeChange?: (mode: GatewayPaymentMode) => void;
  showModeRail?: boolean;
  networkOnline?: boolean;
  onPay: (request: OnlinePaymentRequest) => Promise<boolean | void>;
}) {
  const { t } = useI18n();
  const { approximation } = useAppSettings();
  const isFocused = useIsFocused();
  const [localMode, setLocalMode] = useState<GatewayPaymentMode>("paste");
  const [payload, setPayload] = useState("");
  const [consumedInitialPayload, setConsumedInitialPayload] = useState<string | null>(null);
  const [clipboardStatus, setClipboardStatus] = useState<"idle" | "checking" | "matched" | "empty" | "invalid">("idle");
  const [scannerLocked, setScannerLocked] = useState(false);
  const [completedPaymentKeys, setCompletedPaymentKeys] = useState<Set<string>>(() => new Set());
  const [selectedPayAsset, setSelectedPayAsset] = useState<GatewayPaymentAsset>("SOL");
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const mode = props.mode ?? localMode;

  function setMode(nextMode: GatewayPaymentMode) {
    setLocalMode(nextMode);
    props.onModeChange?.(nextMode);
  }

  useEffect(() => {
    if (!props.initialPayload || props.initialPayload === consumedInitialPayload) {
      return;
    }

    setPayload(props.initialPayload);
    setClipboardStatus("matched");
    setMode("paste");
    setConsumedInitialPayload(props.initialPayload);
  }, [consumedInitialPayload, props.initialPayload]);

  const parsed = useMemo(() => {
    if (!payload.trim()) {
      return { request: null, error: null };
    }
    try {
      return { request: parseOnlinePaymentRequest(payload), error: null };
    } catch (error) {
      return { request: null, error };
    }
  }, [payload]);

  async function readClipboard(options?: { force?: boolean }) {
    setClipboardStatus("checking");
    const text = await Clipboard.getStringAsync();
    const cleanText = text.trim();

    if (!cleanText) {
      setClipboardStatus("empty");
      if (options?.force) {
        setPayload("");
      }
      return;
    }

    try {
      parseOnlinePaymentRequest(cleanText);
      setPayload(cleanText);
      setClipboardStatus("matched");
    } catch {
      setClipboardStatus("invalid");
      if (options?.force) {
        setPayload(cleanText);
      }
    }
  }

  async function openScanner() {
    setMode("scan");
    setScannerLocked(false);
    if (!cameraPermission?.granted) {
      await requestCameraPermission();
    }
  }

  async function handlePay(requestToPay: OnlinePaymentRequest) {
    const completionKey = paymentCompletionKey(requestToPay);
    if (completedPaymentKeys.has(completionKey)) {
      return;
    }

    const submitted = await props.onPay(requestToPay);
    if (submitted === false) {
      return;
    }

    setCompletedPaymentKeys((currentKeys) => {
      const nextKeys = new Set(currentKeys);
      nextKeys.add(completionKey);
      return nextKeys;
    });
  }

  useEffect(() => {
    if (!isFocused || mode !== "scan") {
      return;
    }

    setScannerLocked(false);
    if (!cameraPermission?.granted) {
      void requestCameraPermission();
    }
  }, [cameraPermission?.granted, isFocused, mode, requestCameraPermission]);

  useEffect(() => {
    let mounted = true;

    if (!isFocused || mode !== "paste") {
      return () => {
        mounted = false;
      };
    }

    setClipboardStatus("checking");
    void Clipboard.getStringAsync()
      .then((text) => {
        if (!mounted) {
          return;
        }

        const cleanText = text.trim();
        if (!cleanText) {
          setClipboardStatus("empty");
          return;
        }

        try {
          parseOnlinePaymentRequest(cleanText);
          setPayload(cleanText);
          setClipboardStatus("matched");
        } catch {
          setClipboardStatus("invalid");
        }
      })
      .catch(() => {
        if (mounted) {
          setClipboardStatus("invalid");
        }
      });

    return () => {
      mounted = false;
    };
  }, [isFocused, mode]);

  const request = parsed.request;
  const availablePayAssets = useMemo<GatewayPaymentAsset[]>(() => {
    const assets = request?.allowedPayCurrencies?.length
      ? request.allowedPayCurrencies
      : request
        ? [request.payCurrency ?? request.currency, ...GATEWAY_PAYMENT_ASSETS]
        : GATEWAY_PAYMENT_ASSETS;
    return assets.filter((asset, index, all) => all.indexOf(asset) === index);
  }, [request]);
  const requestQuote = useMemo(() => {
    if (!request) {
      return null;
    }
    return quoteGatewayAssetConversion({
      receiveAmount: request.receiveAmount ?? request.amount,
      receiveAsset: request.receiveCurrency ?? request.currency,
      payAsset: selectedPayAsset,
      rates: approximation.rates,
      gatewayFeeBps: request.gatewayFeeBps,
      conversionFeeBps: request.conversionFeeBps,
    });
  }, [approximation.rates, request, selectedPayAsset]);
  const payableSolAmount = requestQuote?.solAmount ?? request?.solAmount ?? request?.amount ?? null;
  const requestApproximation = payableSolAmount ? formatApproximateAssetAmount(payableSolAmount, "SOL", approximation) : null;
  const paymentCompleted = request ? completedPaymentKeys.has(paymentCompletionKey(request)) : false;
  const networkOnline = props.networkOnline !== false;
  const quoteRequiredForPayment = request
    ? selectedPayAsset !== "SOL" || (request.receiveCurrency ?? request.currency) !== "SOL"
    : false;

  useEffect(() => {
    if (!request) {
      return;
    }
    const preferredAsset = request.payCurrency ?? request.currency;
    setSelectedPayAsset((current) => (availablePayAssets.includes(current) ? current : preferredAsset));
  }, [availablePayAssets, request]);

  function buildRequestForPayment(requestToPay: OnlinePaymentRequest): OnlinePaymentRequest {
    const quote = requestQuote;
    return {
      ...requestToPay,
      amount: quote?.solAmount ?? requestToPay.solAmount ?? requestToPay.amount,
      currency: "SOL",
      solAmount: quote?.solAmount ?? requestToPay.solAmount,
      payCurrency: selectedPayAsset,
      receiveAmount: quote?.receiveAmount ?? requestToPay.receiveAmount,
      receiveCurrency: quote?.receiveAsset ?? requestToPay.receiveCurrency,
      conversionFeeBps: quote?.conversionFeeBps ?? requestToPay.conversionFeeBps,
      totalFeeBps: quote?.totalFeeBps ?? requestToPay.totalFeeBps,
    };
  }

  return (
    <SurfaceCard variant="raised" testID={airPayTestIds.gatewayPay.card}>
        <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.kicker}>{t("gatewayPay.kicker")}</Text>
          <Text style={styles.title}>{t("gatewayPay.title")}</Text>
          <Text style={styles.body}>{t("gatewayPay.body")}</Text>
        </View>
        <StatusChip label={t("gatewayPay.asset.multi")} tone="info" />
      </View>

      {(props.showModeRail ?? true) ? (
        <ActionRail
          activeId={mode}
          items={[
            { id: "paste", label: t("gatewayPay.action.copyPaste"), icon: "clipboard" },
            { id: "scan", label: t("gatewayPay.action.scanQr"), icon: "camera" },
          ]}
          onSelect={(nextMode) => {
            if (nextMode === "scan") {
              void openScanner();
            } else {
              setMode("paste");
              void readClipboard({ force: true });
            }
          }}
        />
      ) : null}

      {mode === "scan" ? (
        <View style={styles.scannerShell}>
          {cameraPermission?.granted ? (
            <>
              <CameraView
                testID={airPayTestIds.gatewayPay.camera}
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={(event) => {
                  if (scannerLocked) {
                    return;
                  }
                  setScannerLocked(true);
                  setPayload(event.data);
                  setMode("paste");
                }}
              />
              <View pointerEvents="none" style={styles.scanOverlay}>
              <View style={styles.scanFrame}>
                <Feather name="maximize" color="#FFFFFF" size={34} />
              </View>
              </View>
            </>
          ) : (
            <View style={styles.permissionBox}>
              <Feather name="camera" size={24} color={palette.cyan} />
              <Text style={styles.body}>{t("gatewayPay.camera.permission")}</Text>
              <ActionButton label={t("gatewayPay.camera.allow")} onPress={requestCameraPermission} />
            </View>
          )}
        </View>
      ) : null}

      {mode === "paste" ? (
        <View style={styles.pasteBlock}>
          <View style={styles.pasteHeader}>
            <Text style={styles.inputLabel}>{t("gatewayPay.input.copyPaste")}</Text>
            <Text style={styles.clipboardStatus}>{t(`gatewayPay.clipboard.${clipboardStatus}`)}</Text>
          </View>
          <TextInput
            testID={airPayTestIds.gatewayPay.payloadInput}
            value={payload}
            onChangeText={(value) => {
              setPayload(value);
              setClipboardStatus("idle");
            }}
            style={styles.payloadInput}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("gatewayPay.input.placeholder")}
            placeholderTextColor={palette.mutedStrong}
          />
        </View>
      ) : null}

      {payload.trim() && parsed.error ? (
        <AlertBanner tone="warning" message={t("gatewayPay.parse.invalid")} />
      ) : null}

      {request ? (
        <View testID={airPayTestIds.gatewayPay.previewCard} style={styles.previewCard}>
          <View style={styles.amountRow}>
            <View>
              <Text style={styles.amountLabel}>{t("gatewayPay.preview.amount")}</Text>
              <Text style={styles.amount}>
                {formatAssetAmount(payableSolAmount ?? request.amount, "SOL")} SOL
              </Text>
              {requestApproximation ? <Text style={styles.amountApproximation}>{requestApproximation}</Text> : null}
            </View>
            <StatusChip
              label={request.reference ? t("gatewayPay.reference.ready") : t("gatewayPay.reference.missing")}
              tone={request.reference ? "success" : "warning"}
            />
          </View>

          <View style={styles.payAssetBlock}>
            <Text style={styles.inputLabel}>{t("gatewayPay.payAsset")}</Text>
            <ActionRail
              activeId={selectedPayAsset}
              items={availablePayAssets.map((asset) => ({
                id: asset,
                label: asset,
                icon: asset === "OFFAIR" ? "radio" : asset === "SOL" ? "activity" : "dollar-sign",
                disabled: asset !== "SOL" && !networkOnline,
              }))}
              onSelect={(asset) => setSelectedPayAsset(asset)}
            />
          </View>

          {requestQuote ? (
            <AlertBanner
              tone={requestQuote.route === "direct_sol" ? "info" : "warning"}
              message={t("gatewayPay.quote", {
                payAmount: requestQuote.payAmount,
                payAsset: requestQuote.payAsset,
                receiveAmount: requestQuote.receiveAmount,
                receiveAsset: requestQuote.receiveAsset,
                fee: (requestQuote.totalFeeBps / 100).toFixed(2),
              })}
            />
          ) : quoteRequiredForPayment ? (
            <AlertBanner tone="warning" message={t("gatewayPay.quote.unavailable")} />
          ) : null}

          <View style={styles.detailGrid}>
            {detailRows(request).map((row) => (
              <View key={row.label} style={styles.detailBox}>
                <Text style={styles.detailLabel}>{t(row.label)}</Text>
                <Text style={styles.detailValue}>{row.localized ? t(row.value) : row.value}</Text>
              </View>
            ))}
          </View>

          {paymentCompleted ? (
            <AlertBanner tone="success" message={t("gatewayPay.review.alreadyPaid")} />
          ) : (
            <AlertBanner
              tone={networkOnline ? "info" : "warning"}
              message={
                !networkOnline
                  ? t("gatewayPay.review.deferredOfflineBody")
                  : request.settlementMode === "gateway_deferred_online"
                    ? t("gatewayPay.review.deferredOnlineBody")
                    : request.reference
                      ? t("gatewayPay.review.referenceBody")
                      : t("gatewayPay.review.noReferenceBody")
              }
            />
          )}

          <ActionButton
            testID={airPayTestIds.gatewayPay.payButton}
            label={
              paymentCompleted
                ? t("gatewayPay.action.paid")
                : props.busy
                  ? t("gatewayPay.action.paying")
                  : networkOnline
                    ? t("gatewayPay.action.pay")
                    : t("gatewayPay.action.queue")
            }
            disabled={paymentCompleted || props.busy || props.disabled || (quoteRequiredForPayment && !requestQuote)}
            onPress={() => {
              void handlePay(buildRequestForPayment(request));
            }}
          />
        </View>
      ) : null}
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
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
  scannerShell: {
    height: 260,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    overflow: "hidden",
    backgroundColor: "#0B130E",
  },
  camera: {
    flex: 1,
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  scanFrame: {
    width: 180,
    height: 180,
    borderRadius: radii.lg,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.76)",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  permissionBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 18,
  },
  pasteBlock: {
    gap: 8,
  },
  pasteHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  inputLabel: {
    ...typeRamp.label,
    flex: 1,
  },
  clipboardStatus: {
    ...typeRamp.caption,
    color: palette.cyan,
    flexShrink: 1,
    textAlign: "right",
  },
  payloadInput: {
    minHeight: 92,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    backgroundColor: palette.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: palette.ink,
    textAlignVertical: "top",
    ...typeRamp.bodyStrong,
  },
  previewCard: {
    gap: 14,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    backgroundColor: palette.surfaceAlt,
    padding: 14,
  },
  amountRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  amountLabel: {
    ...typeRamp.label,
  },
  amount: {
    ...typeRamp.display,
    color: palette.sky,
  },
  amountApproximation: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  detailGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  payAssetBlock: {
    gap: 8,
  },
  detailBox: {
    width: "48%",
    minHeight: 70,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
    padding: 10,
    gap: 4,
  },
  detailLabel: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  detailValue: {
    ...typeRamp.mono,
    color: palette.ink,
  },
});
