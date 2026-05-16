import { StyleSheet, Text, View } from "react-native";

import type { OfflineTransfer } from "@protocol-offair/shared";

import { formatAssetAmount } from "../i18n";
import { useAppSettings } from "../settings/AppSettingsProvider";
import { formatApproximateAssetAmount } from "../services/valueApproximation";
import { airPayTestIds } from "../testing/testIds";
import { useI18n } from "../i18n/I18nProvider";
import { palette, typeRamp } from "../theme/palette";
import { StatusChip } from "./ui/StatusChip";
import { SurfaceCard } from "./ui/SurfaceCard";

export function JournalCard(props: { transfer: OfflineTransfer }) {
  const { t } = useI18n();
  const { approximation } = useAppSettings();
  const settlementStatus = props.transfer.settlementStatus as string;
  const approxLabel = formatApproximateAssetAmount(props.transfer.amount, props.transfer.assetId, approximation);
  const tone =
    settlementStatus === "reconciled" || settlementStatus === "settled"
      ? "success"
      : settlementStatus === "rejected"
        ? "danger"
        : "warning";

  return (
    <SurfaceCard>
      <View testID={airPayTestIds.app.journalCard} style={styles.content}>
        <View style={styles.header}>
          <View style={styles.copy}>
            <Text style={styles.id}>{props.transfer.localTxId}</Text>
            <Text style={styles.meta}>{t("journal.card.counter", { counter: props.transfer.counter })}</Text>
            <Text style={styles.meta}>{t("journal.card.peer", { peer: props.transfer.receiverPseudoId })}</Text>
          </View>
          <View style={styles.trailing}>
            <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
              {formatAssetAmount(props.transfer.amount, props.transfer.assetId)} {props.transfer.assetId}
            </Text>
            {approxLabel ? (
              <Text style={styles.approximation} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                {approxLabel}
              </Text>
            ) : null}
            <StatusChip label={t(`common.state.${settlementStatus}`)} tone={tone} />
          </View>
        </View>
        <Text style={styles.meta}>{t("journal.card.risk", { risk: t(`common.risk.${props.transfer.risk.band}`) })}</Text>
        <Text style={styles.hash}>{t("journal.card.prev", { hash: props.transfer.prevTxHash.slice(0, 16) })}</Text>
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 8,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  copy: {
    flex: 1,
    gap: 4,
  },
  trailing: {
    alignItems: "flex-end",
    gap: 6,
    flexShrink: 0,
    maxWidth: "48%",
  },
  id: {
    ...typeRamp.bodyStrong,
  },
  amount: {
    ...typeRamp.bodyStrong,
    color: palette.amber,
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
    color: palette.sky,
  },
});
