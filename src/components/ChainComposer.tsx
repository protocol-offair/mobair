import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { airPayTestIds } from "../testing/testIds";
import { useI18n } from "../i18n/I18nProvider";
import { normalizeDecimalInput } from "../services/inputFormatters";
import { palette, radii, typeRamp } from "../theme/palette";
import { ActionRail } from "./ui/ActionRail";
import { ActionButton } from "./ui/ActionButton";
import { StatusChip } from "./ui/StatusChip";
import { SurfaceCard } from "./ui/SurfaceCard";

export function ChainComposer(props: {
  busy: boolean;
  disabled?: boolean;
  onQueue: (assetId: "SOL", toAddress: string, amount: string, memo?: string) => Promise<void>;
  onSubmit: () => Promise<void>;
  onRefresh: () => Promise<void>;
  pendingCount: number;
}) {
  const { t } = useI18n();
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("0.05");
  const [memo, setMemo] = useState("");
  const submitDisabled = props.busy || props.disabled || props.pendingCount === 0;
  const normalizedAmount = amount.endsWith(".") ? amount.slice(0, -1) : amount;

  return (
    <SurfaceCard variant="raised">
      <View testID={airPayTestIds.chain.card} style={styles.content}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.kicker}>{t("chain.kicker")}</Text>
            <Text style={styles.title}>{t("chain.title")}</Text>
          </View>
          <StatusChip label={props.pendingCount > 0 ? t("chain.queue.pending", { count: props.pendingCount }) : t("chain.queue.empty")} tone={props.pendingCount > 0 ? "info" : "muted"} />
        </View>

        <StatusChip label={t("chain.asset.solOnly")} tone="info" />

        <TextInput
          testID={airPayTestIds.chain.addressInput}
          value={toAddress}
          onChangeText={setToAddress}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="next"
          placeholder={t("chain.input.address")}
          placeholderTextColor={palette.mutedStrong}
        />
        <View style={styles.row}>
          <TextInput
            testID={airPayTestIds.chain.amountInput}
            value={amount}
            onChangeText={(value) => setAmount(normalizeDecimalInput(value))}
            style={[styles.input, styles.halfInput]}
            autoCapitalize="none"
            keyboardType="decimal-pad"
            returnKeyType="next"
            placeholder={t("chain.input.amount")}
            placeholderTextColor={palette.mutedStrong}
          />
          <TextInput
            testID={airPayTestIds.chain.memoInput}
            value={memo}
            onChangeText={setMemo}
            style={[styles.input, styles.halfInput]}
            autoCapitalize="sentences"
            autoCorrect={false}
            returnKeyType="done"
            placeholder={t("chain.input.memo")}
            placeholderTextColor={palette.mutedStrong}
          />
        </View>

        {!props.disabled && props.pendingCount === 0 ? (
          <Text testID={airPayTestIds.chain.helperText} style={styles.helper}>
            {t("chain.helper")}
          </Text>
        ) : null}

        <ActionButton
          testID={airPayTestIds.chain.queueButton}
          label={props.busy ? t("chain.action.signing") : props.disabled ? t("chain.action.walletRequired") : t("chain.action.queue")}
          disabled={props.busy || props.disabled}
          onPress={() => props.onQueue("SOL", toAddress.trim(), normalizedAmount, memo.trim() || undefined)}
        />
        <ActionRail
          items={[
            {
              id: "submit",
              label: props.disabled ? t("chain.action.walletRequired") : props.pendingCount === 0 ? t("chain.action.submitNone") : t("chain.action.submit", { count: props.pendingCount }),
              icon: "upload-cloud",
              disabled: submitDisabled,
            },
            {
              id: "refresh",
              label: t("chain.action.refresh"),
              icon: "refresh-cw",
              disabled: props.busy || props.disabled,
            },
          ]}
          onSelect={(id) => {
            if (id === "submit") {
              void props.onSubmit();
            } else {
              void props.onRefresh();
            }
          }}
        />
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
  kicker: {
    ...typeRamp.label,
    color: palette.cyan,
  },
  title: {
    ...typeRamp.title,
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
  halfInput: {
    flex: 1,
  },
  helper: {
    ...typeRamp.caption,
    color: palette.cyan,
  },
});
