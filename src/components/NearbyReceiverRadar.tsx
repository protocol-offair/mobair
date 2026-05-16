import Feather from "@expo/vector-icons/Feather";
import { useEffect, useRef } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { NearbyReceiverCandidate, NfcDiscoveryStatus } from "../services/transport";
import { useI18n } from "../i18n/I18nProvider";
import { palette, radii, typeRamp } from "../theme/palette";
import { airPayTestIds } from "../testing/testIds";
import { ActionButton } from "./ui/ActionButton";
import { StatusChip } from "./ui/StatusChip";
import { SurfaceCard } from "./ui/SurfaceCard";

function nfcTone(status: NfcDiscoveryStatus): "info" | "success" | "warning" | "danger" | "muted" {
  switch (status) {
    case "matched":
      return "success";
    case "timed_out":
      return "warning";
    case "error":
      return "danger";
    case "unsupported":
      return "muted";
    case "scanning":
    default:
      return "info";
  }
}

export function NearbyReceiverRadar(props: {
  receivers: NearbyReceiverCandidate[];
  selectedReceiverId: string | null;
  nfcStatus: NfcDiscoveryStatus;
  bleActive: boolean;
  busy: boolean;
  resolvingReceiverId: string | null;
  onSelectReceiver: (candidateId: string) => void;
  onRetryNfc: () => void;
}) {
  const { t } = useI18n();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 2600,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => {
      animation.stop();
      pulse.setValue(0);
    };
  }, [pulse]);

  const ringOneScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.78, 1.06],
  });
  const ringTwoScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.62, 1.22],
  });
  const ringOneOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.28, 0.04],
  });
  const ringTwoOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.18, 0.02],
  });

  return (
    <SurfaceCard variant="hero">
      <View testID={airPayTestIds.offline.discoveryCard} style={styles.content}>
        <Text style={styles.kicker}>{t("offline.discovery.kicker")}</Text>
        <Text style={styles.title}>{t("offline.discovery.title")}</Text>
        <Text style={styles.body}>{t("offline.discovery.body")}</Text>

        <View style={styles.metaRow}>
          <StatusChip
            label={props.bleActive ? t("offline.discovery.ble.scanning") : t("offline.discovery.ble.idle")}
            tone={props.bleActive ? "info" : "muted"}
          />
          <StatusChip
            label={t(`offline.discovery.nfc.${props.nfcStatus}`)}
            tone={nfcTone(props.nfcStatus)}
          />
        </View>

        <View style={styles.radarWrap}>
          <Animated.View style={[styles.radarRing, styles.radarRingPrimary, { transform: [{ scale: ringOneScale }], opacity: ringOneOpacity }]} />
          <Animated.View style={[styles.radarRing, styles.radarRingSecondary, { transform: [{ scale: ringTwoScale }], opacity: ringTwoOpacity }]} />
          <View style={styles.centerCore}>
            <Feather name="send" size={22} color="#FFFFFF" />
          </View>

          {props.receivers.slice(0, 6).map((receiver, index, list) => {
            const angle = (-Math.PI / 2) + (index * ((Math.PI * 2) / Math.max(list.length, 1)));
            const radius = 78;
            const offsetX = Math.cos(angle) * radius;
            const offsetY = Math.sin(angle) * radius;
            const selected = props.selectedReceiverId === receiver.candidateId;

            return (
              <Pressable
                key={receiver.candidateId}
                testID={index === 0 ? airPayTestIds.offline.discoveryFirstReceiver : undefined}
                style={[
                  styles.receiverDot,
                  {
                    transform: [{ translateX: offsetX }, { translateY: offsetY }],
                  },
                  selected ? styles.receiverDotSelected : null,
                ]}
                disabled={props.busy}
                onPress={() => props.onSelectReceiver(receiver.candidateId)}
              >
                <Feather
                  name={receiver.mode === "nfc" ? "radio" : "bluetooth"}
                  size={14}
                  color={selected ? "#FFFFFF" : palette.sky}
                />
              </Pressable>
            );
          })}
        </View>

        <View style={styles.list}>
          {props.receivers.length === 0 ? (
            <Text style={styles.empty}>{t("offline.discovery.empty")}</Text>
          ) : null}

          {props.receivers.map((receiver) => {
            const selected = props.selectedReceiverId === receiver.candidateId;
            const resolving = props.resolvingReceiverId === receiver.candidateId;
            const label =
              receiver.displayName ??
              receiver.deviceName ??
              receiver.walletAddress?.slice(0, 10) ??
              receiver.deviceId?.slice(0, 10) ??
              t("offline.discovery.receiverFallback");

            return (
              <Pressable
                key={receiver.candidateId}
                style={[styles.receiverRow, selected ? styles.receiverRowSelected : null]}
                disabled={props.busy}
                onPress={() => props.onSelectReceiver(receiver.candidateId)}
              >
                <View style={styles.receiverMeta}>
                  <View style={styles.receiverIcon}>
                    <Feather
                      name={receiver.mode === "nfc" ? "radio" : "bluetooth"}
                      size={16}
                      color={selected ? "#FFFFFF" : palette.cyan}
                    />
                  </View>
                  <View style={styles.receiverTextBlock}>
                    <Text style={styles.receiverLabel}>{label}</Text>
                    <Text style={styles.receiverHint}>
                      {receiver.walletAddress?.slice(0, 14) ??
                        receiver.deviceId?.slice(0, 14) ??
                        t("offline.discovery.receiverHint")}
                    </Text>
                  </View>
                </View>

                <View style={styles.receiverActions}>
                  <StatusChip
                    label={t(`offline.discovery.mode.${receiver.mode}`)}
                    tone={receiver.mode === "nfc" ? "success" : "info"}
                  />
                  {selected ? (
                    <StatusChip label={t("offline.discovery.selected")} tone="success" />
                  ) : null}
                  {resolving ? (
                    <Text style={styles.resolving}>{t("offline.discovery.resolving")}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.footer}>
          <Text style={styles.helper}>
            {props.nfcStatus === "matched"
              ? t("offline.discovery.helperNfcMatched")
              : props.nfcStatus === "timed_out"
                ? t("offline.discovery.helperBleFallback")
                : t("offline.discovery.helperDefault")}
          </Text>
          <ActionButton
            testID={airPayTestIds.offline.retryNfcButton}
            label={t("offline.discovery.retryNfc")}
            icon="radio"
            compact
            variant="secondary"
            disabled={props.busy}
            onPress={props.onRetryNfc}
          />
        </View>
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
  },
  kicker: {
    ...typeRamp.label,
    color: palette.cyan,
  },
  title: {
    ...typeRamp.title,
    color: "#FFFFFF",
  },
  body: {
    ...typeRamp.body,
    color: "rgba(255,255,255,0.78)",
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  radarWrap: {
    alignSelf: "center",
    width: 220,
    height: 220,
    alignItems: "center",
    justifyContent: "center",
  },
  radarRing: {
    position: "absolute",
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: "rgba(173,199,255,0.35)",
  },
  radarRingPrimary: {
    width: 154,
    height: 154,
  },
  radarRingSecondary: {
    width: 198,
    height: 198,
    borderColor: "rgba(69,216,237,0.24)",
  },
  centerCore: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: palette.sky,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: palette.cyan,
    shadowOpacity: 0.25,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  receiverDot: {
    position: "absolute",
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surfaceAlt,
    borderWidth: 1,
    borderColor: "rgba(173,199,255,0.24)",
  },
  receiverDotSelected: {
    backgroundColor: palette.cyan,
    borderColor: "rgba(0,46,104,0.2)",
  },
  list: {
    gap: 10,
  },
  empty: {
    ...typeRamp.body,
    color: "rgba(255,255,255,0.66)",
  },
  receiverRow: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.07)",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  receiverRowSelected: {
    borderColor: "rgba(184,243,90,0.36)",
    backgroundColor: "rgba(14,111,59,0.32)",
  },
  receiverMeta: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  receiverIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  receiverTextBlock: {
    flex: 1,
    gap: 2,
  },
  receiverLabel: {
    ...typeRamp.bodyStrong,
    color: "#FFFFFF",
  },
  receiverHint: {
    ...typeRamp.caption,
    color: "rgba(255,255,255,0.62)",
  },
  receiverActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
  },
  resolving: {
    ...typeRamp.caption,
    color: palette.amber,
  },
  footer: {
    gap: 12,
  },
  helper: {
    ...typeRamp.caption,
    color: "rgba(255,255,255,0.68)",
  },
});
