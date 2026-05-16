import { StyleSheet, Text, View } from "react-native";

import type { PendingChainTransaction } from "@protocol-offair/shared";

import { airPayTestIds } from "../testing/testIds";
import { useI18n } from "../i18n/I18nProvider";
import { formatAssetAmount } from "../i18n";
import { useAppSettings } from "../settings/AppSettingsProvider";
import { formatApproximateAssetAmount } from "../services/valueApproximation";
import { palette, typeRamp } from "../theme/palette";
import { StatusChip } from "./ui/StatusChip";
import { SurfaceCard } from "./ui/SurfaceCard";

export function PendingChainCard(props: { transaction: PendingChainTransaction }) {
  const { t } = useI18n();
  const { approximation } = useAppSettings();
  const approxLabel = formatApproximateAssetAmount(
    props.transaction.intent.amount,
    props.transaction.intent.assetId,
    approximation,
  );
  const tone =
    props.transaction.status === "confirmed"
      ? "success"
      : props.transaction.status === "failed"
        ? "danger"
        : props.transaction.status === "submitted"
          ? "info"
          : "warning";

  return (
    <SurfaceCard>
      <View testID={airPayTestIds.app.pendingChainCard} style={styles.content}>
        <View style={styles.header}>
          <View style={styles.copy}>
            <Text style={styles.id}>{props.transaction.intent.intentId}</Text>
            <Text style={styles.meta}>{t("chain.card.to", { address: props.transaction.intent.toAddress })}</Text>
          </View>
          <View style={styles.trailing}>
            <Text style={styles.amount}>
              {formatAssetAmount(props.transaction.intent.amount, props.transaction.intent.assetId)} {props.transaction.intent.assetId}
            </Text>
            {approxLabel ? <Text style={styles.approximation}>{approxLabel}</Text> : null}
            <StatusChip label={t(`common.state.${props.transaction.status}`)} tone={tone} />
          </View>
        </View>
        <Text style={styles.meta}>
          {props.transaction.intent.requiresOnlineAssembly ? t("chain.card.intentQueued") : t("chain.card.serializedReady")}
        </Text>
        {props.transaction.txSignature ? <Text style={styles.hash}>{t("chain.card.signature", { signature: props.transaction.txSignature })}</Text> : null}
        {props.transaction.lastError ? <Text style={styles.error}>{props.transaction.lastError}</Text> : null}
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 10,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 14,
  },
  copy: {
    flex: 1,
    gap: 4,
  },
  trailing: {
    alignItems: "flex-end",
    gap: 6,
    maxWidth: "42%",
  },
  id: {
    ...typeRamp.bodyStrong,
  },
  amount: {
    ...typeRamp.bodyStrong,
    color: palette.cyan,
    textAlign: "right",
  },
  approximation: {
    ...typeRamp.caption,
    color: palette.muted,
    textAlign: "right",
  },
  meta: {
    ...typeRamp.body,
  },
  hash: {
    ...typeRamp.mono,
    color: palette.amber,
  },
  error: {
    ...typeRamp.caption,
    color: palette.coral,
  },
});
