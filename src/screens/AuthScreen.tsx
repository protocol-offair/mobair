import { useEffect, useState } from "react";
import Feather from "@expo/vector-icons/Feather";
import * as Speech from "expo-speech";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import type { LocalAccountAuthController } from "../hooks/useLocalAccountAuth";
import { useI18n } from "../i18n/I18nProvider";
import { airPayTestIds } from "../testing/testIds";
import { palette, radii, spacing, typeRamp } from "../theme/palette";
import { AlertBanner } from "../components/ui/AlertBanner";
import { AppTopBar } from "../components/ui/AppTopBar";
import { ActionButton } from "../components/ui/ActionButton";
import { ScreenFrame } from "../components/ui/ScreenFrame";
import { SectionHeader } from "../components/ui/SectionHeader";
import { SurfaceCard } from "../components/ui/SurfaceCard";

export function AuthScreen(props: {
  controller: LocalAccountAuthController;
}) {
  const { t } = useI18n();
  const isRegistration = !props.controller.profile;
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [enableBiometric, setEnableBiometric] = useState(false);

  useEffect(() => {
    if (props.controller.profile?.email) {
      setEmail(props.controller.profile.email);
    }
  }, [props.controller.profile?.email]);

  useEffect(() => {
    return () => {
      void Speech.stop();
    };
  }, []);

  return (
    <ScreenFrame contentStyle={styles.content}>
      <AppTopBar
        statusLabel={t("auth.status.locked")}
        statusTone="warning"
      />

      <SurfaceCard variant="hero">
        <Text style={styles.kicker}>{t("auth.hero.eyebrow")}</Text>
        <Text style={styles.title}>
          {isRegistration ? t("auth.hero.createTitle") : t("auth.hero.loginTitle")}
        </Text>
        <Text style={styles.body}>
          {isRegistration ? t("auth.hero.createBody") : t("auth.hero.loginBody")}
        </Text>
      </SurfaceCard>

      {props.controller.error ? <AlertBanner tone="danger" message={props.controller.error} /> : null}

      {isRegistration ? (
        <GuidedOnboardingCard />
      ) : null}

      <SurfaceCard variant="raised">
        <SectionHeader title={isRegistration ? t("auth.register.title") : t("auth.login.title")} />

        {isRegistration ? (
          <>
            <LabeledInput
              testID={airPayTestIds.auth.fullNameInput}
              label={t("auth.input.fullName")}
              value={fullName}
              onChangeText={setFullName}
              autoCapitalize="words"
              autoCorrect={false}
              editable={!props.controller.busy}
            />
            <LabeledInput
              testID={airPayTestIds.auth.emailInput}
              label={t("auth.input.email")}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
              editable={!props.controller.busy}
            />
            <LabeledInput
              testID={airPayTestIds.auth.passwordInput}
              label={t("auth.input.password")}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!props.controller.busy}
            />
            <LabeledInput
              testID={airPayTestIds.auth.confirmPasswordInput}
              label={t("auth.input.confirmPassword")}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!props.controller.busy}
            />
            {props.controller.biometricAvailable ? (
              <View style={styles.switchRow}>
                <View style={styles.switchCopy}>
                  <Text style={styles.switchTitle}>{t("auth.biometric.title")}</Text>
                  <Text style={styles.switchBody}>{t("auth.biometric.body")}</Text>
                </View>
                <Switch
                  value={enableBiometric}
                  onValueChange={setEnableBiometric}
                  disabled={props.controller.busy}
                  trackColor={{ true: palette.skySoft, false: palette.surfaceAlt }}
                  thumbColor={enableBiometric ? palette.sky : palette.muted}
                />
              </View>
            ) : null}

            <ActionButton
              testID={airPayTestIds.auth.registerButton}
              label={props.controller.busy ? t("common.working") : t("auth.register.cta")}
              icon="user-plus"
              disabled={props.controller.busy}
              onPress={() =>
                props.controller.register({
                  fullName,
                  email,
                  password,
                  confirmPassword,
                  enableBiometric: enableBiometric && props.controller.biometricAvailable,
                })
              }
            />
          </>
        ) : (
          <>
            <LabeledInput
              testID={airPayTestIds.auth.emailInput}
              label={t("auth.input.email")}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
              editable={!props.controller.busy}
            />
            <LabeledInput
              testID={airPayTestIds.auth.passwordInput}
              label={t("auth.input.password")}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!props.controller.busy}
            />

            {props.controller.biometricEnabled ? (
              <ActionButton
                testID={airPayTestIds.auth.biometricButton}
                label={props.controller.busy ? t("common.working") : t("auth.login.biometric")}
                icon="shield"
                disabled={props.controller.busy}
                onPress={() => props.controller.loginWithBiometrics()}
              />
            ) : null}

            <ActionButton
              testID={airPayTestIds.auth.loginButton}
              label={props.controller.busy ? t("common.working") : t("auth.login.cta")}
              icon="log-in"
              disabled={props.controller.busy}
              onPress={() => props.controller.loginWithPassword({ email, password })}
            />
          </>
        )}
      </SurfaceCard>
    </ScreenFrame>
  );
}

function GuidedOnboardingCard() {
  const { locale, t } = useI18n();
  const [currentStep, setCurrentStep] = useState(0);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const steps = [
    {
      label: t("auth.guided.profile"),
      body: t("auth.guided.profileBody"),
    },
    {
      label: t("auth.guided.wallet"),
      body: t("auth.guided.walletBody"),
    },
    {
      label: t("auth.guided.backup"),
      body: t("auth.guided.backupBody"),
    },
    {
      label: t("auth.guided.reserve"),
      body: t("auth.guided.reserveBody"),
    },
    {
      label: t("auth.guided.transport"),
      body: t("auth.guided.transportBody"),
    },
    {
      label: t("auth.guided.sync"),
      body: t("auth.guided.syncBody"),
    },
  ];
  const activeStep = steps[currentStep] ?? steps[0];
  const narrationText = `${activeStep.label}. ${activeStep.body}`;

  useEffect(() => {
    void Speech.stop();
    setAudioPlaying(false);
  }, [currentStep, locale]);

  function toggleAudioGuide() {
    if (audioPlaying) {
      void Speech.stop();
      setAudioPlaying(false);
      return;
    }

    setAudioPlaying(true);
    Speech.speak(narrationText, {
      language: locale === "pt-BR" ? "pt-BR" : "en-US",
      onDone: () => setAudioPlaying(false),
      onStopped: () => setAudioPlaying(false),
      onError: () => setAudioPlaying(false),
    });
  }

  function goToPreviousStep() {
    setCurrentStep((step) => Math.max(0, step - 1));
  }

  function goToNextStep() {
    setCurrentStep((step) => Math.min(steps.length - 1, step + 1));
  }

  return (
    <SurfaceCard testID={airPayTestIds.auth.guidedCard} variant="raised" style={styles.guideCard}>
      <View style={styles.guideHeader}>
        <View style={styles.guideStepBadge}>
          <Text style={styles.guideStepText}>
            {t("auth.guided.step", { current: currentStep + 1, total: steps.length })}
          </Text>
        </View>
        <View style={styles.guideProgress}>
          {steps.map((step, index) => (
            <View
              key={step.label}
              style={[styles.guideProgressSegment, index <= currentStep ? styles.guideProgressActive : null]}
            />
          ))}
        </View>
      </View>

      <View style={styles.guideHero}>
        <View style={styles.guideIcon}>
          <Feather name="shield" size={18} color="#FFFFFF" />
        </View>
        <Text style={styles.guideTitle}>{activeStep.label}</Text>
        <Text style={styles.guideBody}>{activeStep.body}</Text>
      </View>

      <View style={styles.audioCard}>
        <View style={styles.audioHeader}>
          <View style={styles.audioTitleWrap}>
            <Text style={styles.audioKicker}>{t("auth.guided.audioTitle")}</Text>
            <Text style={styles.audioCaption}>{audioPlaying ? t("auth.guided.audioPause") : t("auth.guided.audioPlay")}</Text>
          </View>
          <Pressable
            testID={airPayTestIds.auth.guidedAudioButton}
            onPress={toggleAudioGuide}
            style={({ pressed }) => [styles.audioButton, pressed && styles.audioButtonPressed]}
          >
            <Feather name={audioPlaying ? "pause" : "play"} size={18} color="#FFFFFF" />
          </Pressable>
        </View>
        <View style={styles.waveRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {[0, 1, 2, 3, 4, 5, 6].map((bar) => (
            <View key={bar} style={[styles.waveBar, audioPlaying ? styles.waveBarActive : null, { height: 10 + ((bar % 4) * 5) }]} />
          ))}
        </View>
      </View>

      <View style={styles.transcriptBlock}>
        <Text style={styles.transcriptTitle}>{t("auth.guided.transcriptTitle")}</Text>
        <Text style={styles.transcriptBody}>{narrationText}</Text>
      </View>

      <View style={styles.guideControls}>
        <Pressable
          testID={airPayTestIds.auth.guidedPreviousButton}
          disabled={currentStep === 0}
          onPress={goToPreviousStep}
          style={({ pressed }) => [
            styles.guideControlButton,
            currentStep === 0 ? styles.guideControlDisabled : null,
            pressed && currentStep > 0 ? styles.guideControlPressed : null,
          ]}
        >
          <Feather name="arrow-left" size={16} color={currentStep === 0 ? palette.muted : palette.ink} />
          <Text style={[styles.guideControlText, currentStep === 0 ? styles.guideControlTextDisabled : null]}>
            {t("auth.guided.previous")}
          </Text>
        </Pressable>
        <Pressable
          testID={airPayTestIds.auth.guidedNextButton}
          disabled={currentStep === steps.length - 1}
          onPress={goToNextStep}
          style={({ pressed }) => [
            styles.guideControlButton,
            styles.guideControlPrimary,
            currentStep === steps.length - 1 ? styles.guideControlDisabled : null,
            pressed && currentStep < steps.length - 1 ? styles.guideControlPressed : null,
          ]}
        >
          <Text style={[styles.guideControlText, styles.guideControlPrimaryText]}>
            {currentStep === steps.length - 1 ? t("auth.guided.done") : t("auth.guided.next")}
          </Text>
          <Feather name="arrow-right" size={16} color="#FFFFFF" />
        </Pressable>
      </View>
    </SurfaceCard>
  );
}

function LabeledInput(
  props: {
    label: string;
    testID?: string;
    value: string;
    onChangeText: (value: string) => void;
    secureTextEntry?: boolean;
    keyboardType?: "default" | "email-address";
    autoCapitalize?: "none" | "words" | "sentences" | "characters";
    autoCorrect?: boolean;
    editable?: boolean;
  },
) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        testID={props.testID}
        value={props.value}
        onChangeText={props.onChangeText}
        secureTextEntry={props.secureTextEntry}
        keyboardType={props.keyboardType}
        autoCapitalize={props.autoCapitalize}
        autoCorrect={props.autoCorrect}
        autoComplete="off"
        importantForAutofill="noExcludeDescendants"
        textContentType="none"
        editable={props.editable}
        style={styles.input}
        placeholderTextColor={palette.muted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.sectionGap,
  },
  kicker: {
    ...typeRamp.label,
    color: "rgba(247,255,232,0.82)",
  },
  title: {
    ...typeRamp.display,
    color: "#F7FFE8",
  },
  body: {
    ...typeRamp.body,
    color: "rgba(247,255,232,0.84)",
  },
  guideCard: {
    gap: 16,
  },
  guideHeader: {
    gap: 10,
  },
  guideStepBadge: {
    alignSelf: "flex-start",
    borderRadius: radii.pill,
    backgroundColor: palette.skySoft,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  guideStepText: {
    ...typeRamp.chip,
    color: palette.sky,
  },
  guideProgress: {
    flexDirection: "row",
    gap: 6,
  },
  guideProgressSegment: {
    flex: 1,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: palette.lineStrong,
  },
  guideProgressActive: {
    backgroundColor: palette.sky,
  },
  guideHero: {
    gap: 10,
    borderRadius: radii.lg,
    backgroundColor: "#0B130E",
    padding: 16,
  },
  guideIcon: {
    width: 36,
    height: 36,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.sky,
  },
  guideTitle: {
    ...typeRamp.title,
    color: "#FFFFFF",
  },
  guideBody: {
    ...typeRamp.body,
    color: "rgba(255,255,255,0.78)",
  },
  audioCard: {
    gap: 12,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surfaceAlt,
    padding: 14,
  },
  audioHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  audioTitleWrap: {
    flex: 1,
    gap: 2,
  },
  audioKicker: {
    ...typeRamp.bodyStrong,
    color: palette.ink,
  },
  audioCaption: {
    ...typeRamp.caption,
    color: palette.muted,
  },
  audioButton: {
    width: 42,
    height: 42,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.sky,
  },
  audioButtonPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.96 }],
  },
  waveRow: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  waveBar: {
    width: 5,
    borderRadius: radii.pill,
    backgroundColor: palette.lineStrong,
  },
  waveBarActive: {
    backgroundColor: palette.cyan,
  },
  transcriptBlock: {
    gap: 6,
  },
  transcriptTitle: {
    ...typeRamp.label,
    color: palette.sky,
  },
  transcriptBody: {
    ...typeRamp.body,
  },
  guideControls: {
    flexDirection: "row",
    gap: 10,
  },
  guideControlButton: {
    minHeight: 42,
    flex: 1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    backgroundColor: palette.surface,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
  },
  guideControlPrimary: {
    borderColor: palette.sky,
    backgroundColor: palette.sky,
  },
  guideControlPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.98 }],
  },
  guideControlDisabled: {
    opacity: 0.52,
  },
  guideControlText: {
    ...typeRamp.bodyStrong,
    color: palette.ink,
  },
  guideControlPrimaryText: {
    color: "#FFFFFF",
  },
  guideControlTextDisabled: {
    color: palette.muted,
  },
  inputGroup: {
    gap: 8,
  },
  label: {
    ...typeRamp.label,
    color: palette.muted,
  },
  input: {
    minHeight: 54,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.lineStrong,
    backgroundColor: palette.surface,
    color: palette.ink,
    paddingHorizontal: 16,
    ...typeRamp.body,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    paddingVertical: 4,
  },
  switchCopy: {
    flex: 1,
    gap: 4,
  },
  switchTitle: {
    ...typeRamp.bodyStrong,
    color: palette.ink,
  },
  switchBody: {
    ...typeRamp.caption,
    color: palette.muted,
  },
});
