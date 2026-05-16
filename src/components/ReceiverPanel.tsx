import { StyleSheet, Text, View } from "react-native";

import { airPayTestIds } from "../testing/testIds";
import { useI18n } from "../i18n/I18nProvider";
import { palette, typeRamp } from "../theme/palette";
import { ActionRail } from "./ui/ActionRail";
import { ActionButton } from "./ui/ActionButton";
import { AlertBanner } from "./ui/AlertBanner";
import { StatusChip } from "./ui/StatusChip";
import { SurfaceCard } from "./ui/SurfaceCard";

export function ReceiverPanel(props: {
  busy: boolean;
  disabled?: boolean;
  disabledReason?: string;
  status: "idle" | "arming" | "ready" | "connected" | "error";
  message: string;
  sessionId?: string;
  onPrepare: () => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const { t } = useI18n();
  const tone =
    props.status === "ready"
      ? "success"
      : props.status === "connected"
        ? "info"
        : props.status === "error"
          ? "danger"
          : "warning";
  const canStop = props.status === "ready" || props.status === "connected" || props.status === "arming";

  return (
    <SurfaceCard>
      <View testID={airPayTestIds.receiver.card} style={styles.content}>
        <View style={styles.header}>
          <View style={styles.copy}>
            <Text style={styles.kicker}>{t("receiver.kicker")}</Text>
            <Text style={styles.title}>{t("receiver.title")}</Text>
          </View>
          <StatusChip label={t(`receiver.status.${props.status}`)} tone={tone} />
        </View>
        <Text testID={airPayTestIds.receiver.message} style={styles.message}>
          {props.message}
        </Text>
        <AlertBanner tone="info" message={t("receiver.feePolicy")} />
        {props.disabled && props.disabledReason ? (
          <Text testID={airPayTestIds.receiver.helperText} style={styles.helper}>
            {props.disabledReason}
          </Text>
        ) : null}
        {props.sessionId ? (
          <Text testID={airPayTestIds.receiver.session} style={styles.session}>
            {t("receiver.session", { sessionId: props.sessionId })}
          </Text>
        ) : null}
        <ActionButton
          testID={canStop ? airPayTestIds.receiver.stopButton : airPayTestIds.receiver.armButton}
          label={
            canStop
              ? t("common.stop")
              : props.busy
                ? t("receiver.action.preparing")
                : props.disabled
                  ? t("receiver.action.syncRequired")
                  : t("receiver.action.prepare")
          }
          disabled={props.busy || (!canStop && props.disabled)}
          onPress={() => (canStop ? props.onStop() : props.onPrepare())}
        />
        {canStop ? (
          <ActionRail
            items={[
              {
                id: "prepare",
                label: t("receiver.action.prepare"),
                icon: "radio",
                disabled: props.busy || props.disabled,
              },
            ]}
            onSelect={(id) => {
              if (id === "prepare") {
                void props.onPrepare();
              }
            }}
          />
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
  copy: {
    gap: 6,
  },
  kicker: {
    ...typeRamp.label,
    color: palette.cyan,
  },
  title: {
    ...typeRamp.title,
  },
  message: {
    ...typeRamp.body,
  },
  helper: {
    ...typeRamp.caption,
    color: palette.cyan,
  },
  session: {
    ...typeRamp.mono,
    color: palette.amber,
  },
});
