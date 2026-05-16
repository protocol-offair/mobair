import Constants from "expo-constants";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";

import { buildBaseRoot } from "@airpay/shared";

import { createGatewayWalletSessionWithBackend } from "../services/backend";
import {
  disableBackgroundRuntime as disableNativeBackgroundRuntime,
  enableBackgroundRuntime as enableNativeBackgroundRuntime,
  hideBackgroundOverlay,
  openBluetoothControlPanel,
  openNfcControlPanel,
  refreshBackgroundRuntimeStatus,
  requestBluetoothActivation,
  showBackgroundOverlay,
  subscribeBackgroundRuntimeEvents,
  type BackgroundRuntimeStatus,
} from "../services/backgroundRuntime";
import { probeRpcReachability } from "../services/chain";
import { getDefaultTransportIds } from "../services/integrity";
import { claimPromiseOnChain, materializePromiseReceiptOnChain, settlePromiseOnChain } from "../services/offair";
import { paymentRequestMemo, type OnlinePaymentRequest } from "../services/paymentRequest";
import {
  acknowledgeTransfer,
  startNearbyReceiverDiscovery,
  prepareReceiverTransport,
  publishTransferReceipt,
  stopReceiverTransport,
  subscribeToIncomingTransfers,
  subscribeToReceiverLifecycle,
  type NearbyReceiverCandidate,
  type NearbyReceiverDiscoveryHandle,
  type NfcDiscoveryStatus,
} from "../services/transport";
import {
  canArmReceiver,
  confirmWalletBackupAndRefreshProtocolState,
  createCustodyWalletState,
  importCustodyWalletState,
  isOfflineReady,
  getOfflinePromiseCapacity,
  loadWalletState,
  queueChainTransferState,
  refreshPendingChainTransactionsState,
  recordIncomingTransfer,
  refreshWalletBalancesState,
  resetWalletState,
  selectActiveWalletState,
  revealCustodyMnemonicState,
  saveWalletState,
  sendOfflineTransfer,
  submitPendingChainTransactionsState,
  fundReserveState,
  refreshProtocolState as refreshProtocolStateState,
  syncPromiseStates,
  withdrawReserveState,
  previewOfflinePeerTrust,
  SendTrustWarningError,
  type SendTrustWarningPrompt,
  type WalletState,
} from "../services/wallet";
import {
  buildTrustCacheSummary,
  classifySessionQuality,
  evaluatePeerTrustDecision,
  loadLocalTrustState,
  mutateLocalTrustState,
  recordPeerInteraction,
  type LocalRiskLevel,
  type PeerTrustPreview,
  type TrustBand,
  type TrustCacheSummary,
} from "../services/trust";
import {
  flushDiagnosticEntries,
  flushRememberedDiagnosticEntries,
  recordDiagnostic,
  recordDiagnosticError,
  rememberDiagnosticDeviceId,
} from "../services/diagnostics";
import { translate } from "../i18n";

const helperEndpointUrl = Constants.expoConfig?.extra?.backendUrl as string | undefined;
const CHAIN_POLL_INTERVAL_MS = 12000;
const BACKGROUND_SYNC_COOLDOWN_MS = 25000;

interface ReceiverState {
  status: "idle" | "arming" | "ready" | "connected" | "error";
  message: string;
  sessionId?: string;
}

interface ReceiverTrustNotice {
  tone: "info" | "warning" | "danger";
  message: string;
  helper?: string;
  riskLabel?: string;
  riskTone?: "info" | "warning" | "danger";
  peerId?: string;
  trustBand?: TrustBand;
}

interface SendTrustPreview {
  tone: "info" | "warning" | "danger";
  message: string;
  helper?: string;
  riskLabel?: string;
  riskTone?: "info" | "warning" | "danger";
}

interface SenderDiscoveryState {
  receivers: NearbyReceiverCandidate[];
  selectedReceiverId: string | null;
  nfcStatus: NfcDiscoveryStatus;
  bleActive: boolean;
  resolvingReceiverId: string | null;
}

interface SenderReceiverSelectionHint {
  candidateId?: string;
  walletAddress?: string;
  deviceId?: string;
  displayName?: string;
  deviceName?: string;
}

type BackgroundRuntimeViewState = BackgroundRuntimeStatus & {
  autoSyncInFlight: boolean;
  networkConnected?: boolean;
  lastAutoSyncAt?: string;
};

const DEFAULT_BACKGROUND_RUNTIME_STATE: BackgroundRuntimeViewState = {
  supported: false,
  backgroundServiceRunning: false,
  overlayPermissionGranted: false,
  overlayVisible: false,
  bluetoothEnabled: false,
  nfcEnabled: false,
  permissions: {},
  autoSyncInFlight: false,
};

function toneForRiskLevel(riskLevel: LocalRiskLevel): "info" | "warning" | "danger" {
  return riskLevel === "blocked" ? "danger" : riskLevel === "high" || riskLevel === "guarded" ? "warning" : "info";
}

function translateTrustReason(reason: string) {
  const reasonKey = `offline.trustWarning.reason.${reason}` as const;
  const translated = translate(reasonKey);
  return translated === reasonKey ? reason : translated;
}

function buildReceiverTrustNotice(input: {
  peerLabel: string;
  trustBand: TrustBand;
  trustScore: number;
  riskLevel: LocalRiskLevel;
  riskScore: number;
  reasons: string[];
  tone: "warning" | "danger";
}): ReceiverTrustNotice {
  const reasons = input.reasons.map(translateTrustReason).join(", ");
  const riskLabel = translate(`history.trust.risk.${input.riskLevel}`);

  return {
    tone: input.tone,
    message:
      input.tone === "danger"
        ? translate("receive.trust.notice.block", {
            peer: input.peerLabel,
            risk: riskLabel,
            riskScore: input.riskScore,
          })
        : translate("receive.trust.notice.warn", {
            peer: input.peerLabel,
            risk: riskLabel,
            riskScore: input.riskScore,
          }),
    helper: translate("receive.trust.notice.helper", {
      reasons: reasons || translateTrustReason("no-local-signal"),
    }),
    riskLabel,
    riskTone: toneForRiskLevel(input.riskLevel),
    trustBand: input.trustBand,
  };
}

function translatePreviewMessage(preview: PeerTrustPreview): SendTrustPreview {
  const tone = preview.decision === "block" ? "danger" : preview.decision === "warn" ? "warning" : "info";
  const translatedReasons = preview.reasons.map(translateTrustReason).join(", ");

  return {
    tone,
    message: translate(`offline.trustPreview.${preview.decision}`, {
      peer: preview.peerId,
      band: translate(`history.trust.band.${preview.trustBand}`),
      score: preview.trustScore,
      risk: translate(`history.trust.risk.${preview.riskLevel}`),
      riskScore: preview.riskScore,
    }),
    helper: translate("offline.trustPreview.helper", {
      reasons: translatedReasons || translateTrustReason("no-local-signal"),
    }),
    riskLabel: translate(`history.trust.risk.${preview.riskLevel}`),
    riskTone: toneForRiskLevel(preview.riskLevel),
  };
}

function resolveReceiverTrustHint(candidate: NearbyReceiverCandidate | null | undefined) {
  if (!candidate) {
    return "";
  }

  return candidate.walletAddress ?? candidate.deviceId ?? candidate.displayName ?? candidate.deviceName ?? "";
}

export function useAirPayWallet() {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [trustSummary, setTrustSummary] = useState<TrustCacheSummary | null>(null);
  const [sendTrustPrompt, setSendTrustPrompt] = useState<SendTrustWarningPrompt | null>(null);
  const [sendTrustPreview, setSendTrustPreview] = useState<SendTrustPreview | null>(null);
  const [receiverTrustNotice, setReceiverTrustNotice] = useState<ReceiverTrustNotice | null>(null);
  const [backgroundRuntime, setBackgroundRuntime] = useState<BackgroundRuntimeViewState>(DEFAULT_BACKGROUND_RUNTIME_STATE);
  const [senderDiscovery, setSenderDiscovery] = useState<SenderDiscoveryState>({
    receivers: [],
    selectedReceiverId: null,
    nfcStatus: "idle",
    bleActive: false,
    resolvingReceiverId: null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mnemonicPreview, setMnemonicPreview] = useState<string | null>(null);
  const [receiverState, setReceiverState] = useState<ReceiverState>({
    status: "idle",
    message: translate("hook.receiver.notArmed"),
  });
  const walletRef = useRef<WalletState | null>(null);
  const senderDiscoveryHandleRef = useRef<NearbyReceiverDiscoveryHandle | null>(null);
  const senderDiscoveryUnsubscribeRef = useRef<(() => void) | null>(null);
  const chainRefreshInFlightRef = useRef(false);
  const protocolRefreshInFlightRef = useRef(false);
  const balanceRefreshInFlightRef = useRef(false);
  const diagnosticsFlushInFlightRef = useRef(false);
  const backgroundSyncInFlightRef = useRef(false);
  const lastBackgroundSyncAttemptAtRef = useRef(0);

  async function flushDiagnosticsForWallet(candidate: WalletState | null | undefined) {
    if (!helperEndpointUrl || diagnosticsFlushInFlightRef.current) {
      return;
    }

    diagnosticsFlushInFlightRef.current = true;
    try {
      const deviceId = candidate?.manifest?.deviceId?.trim();
      if (deviceId) {
        await rememberDiagnosticDeviceId(deviceId);
        await flushDiagnosticEntries(deviceId);
      } else {
        await flushRememberedDiagnosticEntries();
      }
    } catch {
      // Keep buffered diagnostics for the next online attempt.
    } finally {
      diagnosticsFlushInFlightRef.current = false;
    }
  }

  async function refreshTrustSummary() {
    try {
      const trustState = await loadLocalTrustState();
      setTrustSummary(buildTrustCacheSummary(trustState));
    } catch {
      setTrustSummary(null);
    }
  }

  async function updateBackgroundRuntimeStatus() {
    const status = await refreshBackgroundRuntimeStatus();
    setBackgroundRuntime((current) => ({
      ...current,
      ...status,
    }));
    return status;
  }

  async function syncGatewayWalletSession(currentWallet: WalletState, reason: string): Promise<string | null> {
    if (!currentWallet.profile) {
      return null;
    }

    try {
      const session = await createGatewayWalletSessionWithBackend({
        profile: currentWallet.profile,
        audience: `airpay-mobile:${reason}`,
      });
      if (!session) {
        return null;
      }
      await recordDiagnostic({
        level: "info",
        category: "gateway.wallet.session",
        message: "AirPay Gateway wallet session signed successfully.",
        context: {
          reason,
          walletId: session.walletId,
          expiresAt: session.expiresAt,
        },
      });
      return translate("service.wallet.status.gatewayWalletSynced");
    } catch (gatewaySyncError) {
      await recordDiagnosticError("gateway.wallet.session", gatewaySyncError, { reason });
      return null;
    }
  }

  async function runAutomaticReconnectSync(reason: "network" | "runtime" | "manual") {
    const currentWallet = walletRef.current;
    if (!currentWallet?.manifest || !currentWallet.profile || backgroundSyncInFlightRef.current) {
      return;
    }

    const now = Date.now();
    if (reason !== "manual" && now - lastBackgroundSyncAttemptAtRef.current < BACKGROUND_SYNC_COOLDOWN_MS) {
      return;
    }

    lastBackgroundSyncAttemptAtRef.current = now;
    backgroundSyncInFlightRef.current = true;
    setBackgroundRuntime((current) => ({
      ...current,
      autoSyncInFlight: true,
    }));

    try {
      const rpcReachable = await probeRpcReachability().catch(() => false);
      if (!rpcReachable) {
        return;
      }

      const gatewaySyncStatus = await syncGatewayWalletSession(currentWallet, reason);
      const synced = await refreshProtocolStateState(currentWallet, {
        allowOnChainMutation: true,
        requestedAmount: currentWallet.reserve.totalAmount > 0 ? currentWallet.reserve.totalAmount : undefined,
        requestedTransfers: currentWallet.reserve.remainingTransfers > 0 ? currentWallet.reserve.remainingTransfers : undefined,
      });
      const processed = await syncPromiseStates(synced);
      const submitted = await submitPendingChainTransactionsState(processed).catch(async (submitError) => {
        await recordDiagnosticError("background.sync.submit_queue", submitError, { reason });
        return processed;
      });
      const refreshedQueue = await refreshPendingChainTransactionsState(submitted, { log: false });
      const refreshedBalances = await refreshWalletBalancesState(refreshedQueue);
      const nextWallet: WalletState = {
        ...refreshedBalances,
        statusLog: [
          ...(gatewaySyncStatus ? [gatewaySyncStatus] : []),
          translate("service.wallet.status.autoReconnectSync", { reason }),
          ...refreshedBalances.statusLog,
        ].slice(0, 12),
      };
      await commitWallet(nextWallet);
      setBackgroundRuntime((current) => ({
        ...current,
        autoSyncInFlight: false,
        lastAutoSyncAt: new Date().toISOString(),
      }));
    } catch (syncError) {
      await recordDiagnosticError("background.sync.reconnect", syncError, { reason });
      await flushDiagnosticsForWallet(walletRef.current);
    } finally {
      backgroundSyncInFlightRef.current = false;
      setBackgroundRuntime((current) => ({
        ...current,
        autoSyncInFlight: false,
      }));
    }
  }

  async function updateSendTrustPreviewForCandidate(candidate: NearbyReceiverCandidate | null | undefined) {
    const peerHint = resolveReceiverTrustHint(candidate);
    if (!peerHint) {
      setSendTrustPreview(null);
      return null;
    }

    const preview = await previewOfflinePeerTrust({ peerHint });
    if (!preview) {
      setSendTrustPreview(null);
      return null;
    }

    setSendTrustPreview(translatePreviewMessage(preview));
    return preview;
  }

  function applySenderDiscoverySnapshot(snapshot: {
    receivers: NearbyReceiverCandidate[];
    bleActive: boolean;
    nfcStatus: NfcDiscoveryStatus;
  }) {
    setSenderDiscovery((current) => {
      const previouslySelectedReceiver =
        current.selectedReceiverId
          ? current.receivers.find((receiver) => receiver.candidateId === current.selectedReceiverId) ?? null
          : null;
      const selectedExists =
        current.selectedReceiverId &&
        snapshot.receivers.some((receiver) => receiver.candidateId === current.selectedReceiverId);
      const nfcPreferred = snapshot.receivers.find((receiver) => receiver.mode === "nfc" && receiver.preferred);
      const preferredReceivers = snapshot.receivers.filter((receiver) => receiver.preferred);
      const singlePreferredReceiver = preferredReceivers.length === 1 ? preferredReceivers[0] : null;
      const resolvedReceivers = snapshot.receivers.filter((receiver) => receiver.resolved);
      const singleResolvedReceiver = resolvedReceivers.length === 1 ? resolvedReceivers[0] : null;
      const singleReceiver = snapshot.receivers.length === 1 ? snapshot.receivers[0] : null;
      const matchedPreviousSelection =
        !selectedExists && previouslySelectedReceiver
          ? snapshot.receivers.find(
              (receiver) =>
                receiver.candidateId === previouslySelectedReceiver.candidateId ||
                (previouslySelectedReceiver.walletAddress &&
                  receiver.walletAddress === previouslySelectedReceiver.walletAddress) ||
                (previouslySelectedReceiver.deviceId && receiver.deviceId === previouslySelectedReceiver.deviceId) ||
                (previouslySelectedReceiver.displayName &&
                  receiver.displayName === previouslySelectedReceiver.displayName) ||
                (previouslySelectedReceiver.deviceName && receiver.deviceName === previouslySelectedReceiver.deviceName),
            )
          : null;
      let nextReceivers = snapshot.receivers;
      let nextSelectedReceiverId =
        selectedExists && current.selectedReceiverId
          ? current.selectedReceiverId
          : (matchedPreviousSelection?.candidateId ??
            nfcPreferred?.candidateId ??
            singlePreferredReceiver?.candidateId ??
            singleResolvedReceiver?.candidateId ??
            singleReceiver?.candidateId ??
            null);

      if (!nextSelectedReceiverId && previouslySelectedReceiver && (snapshot.bleActive || current.bleActive)) {
        nextReceivers = [
          previouslySelectedReceiver,
          ...snapshot.receivers.filter((receiver) => receiver.candidateId !== previouslySelectedReceiver.candidateId),
        ];
        nextSelectedReceiverId = previouslySelectedReceiver.candidateId;
      }

      return {
        ...current,
        receivers: nextReceivers,
        selectedReceiverId: nextSelectedReceiverId,
        nfcStatus: snapshot.nfcStatus,
        bleActive: snapshot.bleActive,
      };
    });
  }

  async function stopSenderDiscoveryInternal(options?: { preserveReceivers?: boolean }) {
    senderDiscoveryUnsubscribeRef.current?.();
    senderDiscoveryUnsubscribeRef.current = null;
    const handle = senderDiscoveryHandleRef.current;
    senderDiscoveryHandleRef.current = null;
    if (handle) {
      await handle.stop().catch(() => undefined);
    }
    setSenderDiscovery((current) => ({
      receivers: options?.preserveReceivers ? current.receivers : [],
      selectedReceiverId: options?.preserveReceivers ? current.selectedReceiverId : null,
      nfcStatus: "idle",
      bleActive: false,
      resolvingReceiverId: null,
    }));
  }

  function buildSelectionHint(candidate: NearbyReceiverCandidate | null | undefined): SenderReceiverSelectionHint | undefined {
    if (!candidate) {
      return undefined;
    }
    return {
      candidateId: candidate.candidateId,
      walletAddress: candidate.walletAddress,
      deviceId: candidate.deviceId,
      displayName: candidate.displayName,
      deviceName: candidate.deviceName,
    };
  }

  function resolveSelectedReceiverFromHint(hint?: SenderReceiverSelectionHint) {
    if (selectedNearbyReceiver) {
      return selectedNearbyReceiver;
    }
    if (!hint) {
      return null;
    }
    return (
      senderDiscovery.receivers.find(
        (receiver) =>
          (hint.candidateId && receiver.candidateId === hint.candidateId) ||
          (hint.walletAddress && receiver.walletAddress === hint.walletAddress) ||
          (hint.deviceId && receiver.deviceId === hint.deviceId) ||
          (hint.displayName && receiver.displayName === hint.displayName) ||
          (hint.deviceName && receiver.deviceName === hint.deviceName),
      ) ?? null
    );
  }

  async function startSenderDiscoveryInternal(candidateToReselect?: SenderReceiverSelectionHint) {
    const currentWallet = walletRef.current;
    if (!currentWallet?.manifest || !currentWallet.profile || !isOfflineReady(currentWallet)) {
      await stopSenderDiscoveryInternal();
      setSendTrustPreview(null);
      return;
    }
    if (senderDiscoveryHandleRef.current) {
      return;
    }

    const handle = await startNearbyReceiverDiscovery({
      manifest: currentWallet.manifest,
    });
    senderDiscoveryHandleRef.current = handle;

    const selectMatchingCandidate = async (receivers: NearbyReceiverCandidate[]) => {
      if (!candidateToReselect) {
        return;
      }
      const match = receivers.find(
        (receiver) =>
          (candidateToReselect.candidateId && receiver.candidateId === candidateToReselect.candidateId) ||
          (candidateToReselect.walletAddress && receiver.walletAddress === candidateToReselect.walletAddress) ||
          (candidateToReselect.deviceId && receiver.deviceId === candidateToReselect.deviceId) ||
          (candidateToReselect.displayName && receiver.displayName === candidateToReselect.displayName) ||
          (candidateToReselect.deviceName && receiver.deviceName === candidateToReselect.deviceName),
      );
      if (!match) {
        return;
      }
      setSenderDiscovery((current) => ({
        ...current,
        selectedReceiverId: match.candidateId,
      }));
      await updateSendTrustPreviewForCandidate(match);
    };

    senderDiscoveryUnsubscribeRef.current = handle.subscribe((snapshot) => {
      applySenderDiscoverySnapshot(snapshot);
      void selectMatchingCandidate(snapshot.receivers);
      const preferredReceiver = snapshot.receivers.find((receiver) => receiver.mode === "nfc" && receiver.preferred);
      if (preferredReceiver) {
        void updateSendTrustPreviewForCandidate(preferredReceiver);
      }
    });
  }

  useEffect(() => {
    walletRef.current = wallet;
  }, [wallet]);

  useEffect(() => {
    void updateBackgroundRuntimeStatus();
    const unsubscribe = subscribeBackgroundRuntimeEvents({
      onNetworkAvailable: (event) => {
        setBackgroundRuntime((current) => ({
          ...current,
          networkConnected: event.connected,
        }));
        if (event.connected) {
          void runAutomaticReconnectSync("network");
        }
      },
      onStatus: (status) => {
        setBackgroundRuntime((current) => ({
          ...current,
          ...status,
        }));
      },
    });
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        void updateBackgroundRuntimeStatus();
      }
    });

    return () => {
      unsubscribe();
      appStateSubscription.remove();
    };
  }, []);

  useEffect(() => {
    loadWalletState()
      .then((loadedWallet) => {
        walletRef.current = loadedWallet;
        setWallet(loadedWallet);
        void refreshTrustSummary();
        void flushDiagnosticsForWallet(loadedWallet);
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        void recordDiagnosticError("wallet.load", loadError);
      });
  }, []);

  useEffect(() => {
    if (wallet?.manifest && wallet.profile && backgroundRuntime.backgroundServiceRunning) {
      void runAutomaticReconnectSync("runtime");
    }
  }, [backgroundRuntime.backgroundServiceRunning, wallet?.manifest?.deviceId, wallet?.profile?.walletId]);

  useEffect(
    () => () => {
      void stopSenderDiscoveryInternal();
    },
    [],
  );

  useEffect(() => {
    let unsubscribeIncoming: () => void = () => {};
    let unsubscribeLifecycle: () => void = () => {};

    try {
      unsubscribeIncoming = subscribeToIncomingTransfers((event) => {
        void (async () => {
          const currentWallet = walletRef.current;
          if (!currentWallet) {
            return;
          }
          const replayedEntry = currentWallet.journal.find(
            (entry) =>
              entry.localTxId === event.transfer.localTxId ||
              (entry.promiseId && event.transfer.promiseId && entry.promiseId === event.transfer.promiseId) ||
              (entry.signatureBundle?.payloadHash &&
                event.transfer.signatureBundle?.payloadHash &&
                entry.signatureBundle.payloadHash === event.transfer.signatureBundle.payloadHash),
          );
          if (replayedEntry) {
            void recordDiagnostic({
              level: "warn",
              category: "receiver.transfer.replay_duplicate",
              message: `Incoming transfer ${event.transfer.localTxId} ignored because it matches an existing journal promise.`,
              context: {
                sessionId: event.sessionId,
                transferId: event.transfer.localTxId,
                existingTransferId: replayedEntry.localTxId,
                promiseId: event.transfer.promiseId,
              },
            });
            return;
          }
          if (event.transfer.replayProtection) {
            const replayWindowMs = event.transfer.replayProtection.timestampWindowSeconds * 1000;
            const createdAt = new Date(event.transfer.replayProtection.createdAt).getTime();
            const now = Date.now();
            if (!Number.isFinite(createdAt) || createdAt + replayWindowMs < now - 5 * 60 * 1000) {
              const message = "Offline transfer replay window expired.";
              setError(message);
              setReceiverState({
                status: "error",
                sessionId: event.sessionId,
                message,
              });
              await recordDiagnostic({
                level: "warn",
                category: "receiver.transfer.replay_window_expired",
                message,
                context: {
                  sessionId: event.sessionId,
                  transferId: event.transfer.localTxId,
                  promiseId: event.transfer.promiseId,
                  replayProtection: event.transfer.replayProtection,
                },
              });
              await flushDiagnosticsForWallet(walletRef.current);
              return;
            }
          }

          try {
            const trustState = await loadLocalTrustState();
            const trustDecision = evaluatePeerTrustDecision(trustState, {
              peerIds: [
                event.transfer.senderAddress ?? "",
                event.handshake?.manifest.solanaAddress ?? "",
                event.handshake?.manifest.deviceId ?? "",
                event.transfer.senderPseudoId,
              ],
            });
            const sessionQuality = trustDecision.summary
              ? classifySessionQuality({ peer: trustDecision.summary })
              : "unknown";
            const receiverDecision = trustDecision.decision;
            const receiverReasons = trustDecision.reasons;
            const peerLabel =
              event.transfer.senderAddress ??
              event.handshake?.manifest.solanaAddress ??
              event.transfer.senderPseudoId ??
              event.handshake?.manifest.deviceId ??
              translate("common.state.unknown");

            if (receiverDecision === "block") {
              if (trustDecision.peerId) {
                await mutateLocalTrustState((state) =>
                  recordPeerInteraction(state, {
                    peerId: trustDecision.peerId!,
                    kind: "rejected",
                    amount: event.transfer.amount,
                    occurredAt: new Date().toISOString(),
                  }),
                );
              }

              await refreshTrustSummary();
              setReceiverTrustNotice({
                ...buildReceiverTrustNotice({
                  peerLabel,
                  trustBand: trustDecision.trustBand,
                  trustScore: trustDecision.trustScore,
                  riskLevel: trustDecision.riskLevel,
                  riskScore: trustDecision.riskScore,
                  reasons: receiverReasons,
                  tone: "danger",
                }),
                peerId: trustDecision.peerId,
              });
              setReceiverState({
                status: "connected",
                sessionId: event.sessionId,
                message: translate("service.wallet.error.receiverPeerBlockedLocal", {
                  peer: peerLabel,
                }),
              });
              await recordDiagnostic({
                level: "warn",
                category: "receiver.transfer.blocked_local_trust",
                message: `Incoming transfer ${event.transfer.localTxId} blocked by local trust policy.`,
                context: {
                  sessionId: event.sessionId,
                  transferId: event.transfer.localTxId,
                  peerId: trustDecision.peerId,
                  peerLabel,
                  trustBand: trustDecision.trustBand,
                  trustScore: trustDecision.trustScore,
                  riskLevel: trustDecision.riskLevel,
                  riskScore: trustDecision.riskScore,
                  reasons: receiverReasons,
                  sessionQuality,
                },
              });
              await flushDiagnosticsForWallet(walletRef.current);
              return;
            }

            if (receiverDecision === "warn") {
              setReceiverTrustNotice({
                ...buildReceiverTrustNotice({
                  peerLabel,
                  trustBand: trustDecision.trustBand,
                  trustScore: trustDecision.trustScore,
                  riskLevel: trustDecision.riskLevel,
                  riskScore: trustDecision.riskScore,
                  reasons: receiverReasons,
                  tone: "warning",
                }),
                peerId: trustDecision.peerId,
              });
              await recordDiagnostic({
                level: "warn",
                category: "receiver.transfer.warn_local_trust",
                message: `Incoming transfer ${event.transfer.localTxId} accepted with local trust warning.`,
                context: {
                  sessionId: event.sessionId,
                  transferId: event.transfer.localTxId,
                  peerId: trustDecision.peerId,
                  peerLabel,
                  trustBand: trustDecision.trustBand,
                  trustScore: trustDecision.trustScore,
                  riskLevel: trustDecision.riskLevel,
                  riskScore: trustDecision.riskScore,
                  reasons: receiverReasons,
                  sessionQuality,
                },
              });
            } else {
              setReceiverTrustNotice(null);
            }

            let resolvedTransfer = event.transfer;
            let receiptMetadata: Parameters<typeof acknowledgeTransfer>[1] = {
              walletId: currentWallet.profile?.walletId,
              sessionSettlementMode: event.transfer.sessionSettlementMode ?? "offline_promise",
              directSettlementSignature: event.transfer.directSettlementSignature,
              claimStatus: event.transfer.claimStatus,
            };
            const receiverDiagnostics = [
              event.handshake
                ? translate("hook.receiver.handshakeAccepted", { deviceId: event.handshake.manifest.deviceId })
                : translate("hook.receiver.handshakeAcceptedGeneric"),
              translate("hook.receiver.feePayerNotice"),
            ];

            if (event.transfer.sessionSettlementMode === "direct_sol") {
              resolvedTransfer = {
                ...event.transfer,
                claimStatus: "settled",
                settlementStatus: "reconciled",
              };
            } else if (event.transfer.sessionSettlementMode === "instant_claim") {
              const receiverRpcReachable = await probeRpcReachability().catch(() => false);
              if (receiverRpcReachable && currentWallet.profile) {
                let instantClaimStage: "claim" | "receipt" | "settle" = "claim";
                try {
                  await recordDiagnostic({
                    level: "info",
                    category: "receiver.instant_claim.started",
                    message: `Immediate on-chain claim started for promise ${event.transfer.promiseId ?? "unknown"}.`,
                    context: {
                      sessionId: event.sessionId,
                      transferId: event.transfer.localTxId,
                      promiseId: event.transfer.promiseId,
                      stage: instantClaimStage,
                    },
                  });
                  let chainState = await claimPromiseOnChain({
                    profile: currentWallet.profile,
                    transfer: event.transfer,
                  });
                  await recordDiagnostic({
                    level: "info",
                    category: "receiver.instant_claim.claimed",
                    message: `Promise ${event.transfer.promiseId ?? "unknown"} claimed on-chain during this session.`,
                    context: {
                      sessionId: event.sessionId,
                      transferId: event.transfer.localTxId,
                      promiseId: event.transfer.promiseId,
                      claimStatus: chainState.status,
                      claimTx: chainState.claimTx,
                      stage: instantClaimStage,
                    },
                  });
                  receiverDiagnostics.push(
                    translate("hook.receiver.instantClaimed", {
                      promiseId: event.transfer.promiseId ?? "unknown",
                    }),
                  );
                  const shouldMaterializeReceipt =
                    chainState.receiptMaterializationRequired ?? event.transfer.receiptMaterializationRequired ?? false;
                  if (!chainState.receiptMint && shouldMaterializeReceipt) {
                    try {
                      instantClaimStage = "receipt";
                      const receipt = await materializePromiseReceiptOnChain({
                        profile: currentWallet.profile,
                        transfer: event.transfer,
                      });
                      chainState = {
                        ...chainState,
                        receiptMint: receipt.receiptMint,
                        receiptTokenAccount: receipt.receiptTokenAccount,
                        receiptMintedAt: receipt.mintedAt,
                      };
                      await recordDiagnostic({
                        level: "info",
                        category: "receiver.instant_claim.receipt_materialized",
                        message: `Promise ${event.transfer.promiseId ?? "unknown"} receipt materialized on-chain.`,
                        context: {
                          sessionId: event.sessionId,
                          transferId: event.transfer.localTxId,
                          promiseId: event.transfer.promiseId,
                          receiptMint: receipt.receiptMint,
                          receiptTokenAccount: receipt.receiptTokenAccount,
                          stage: instantClaimStage,
                        },
                      });
                      receiverDiagnostics.push(
                        translate("hook.receiver.instantClaimed", {
                          promiseId: event.transfer.promiseId ?? "unknown",
                        }),
                      );
                    } catch (receiptError) {
                      await recordDiagnosticError("receiver.instant_claim.receipt_materialize", receiptError, {
                        sessionId: event.sessionId,
                        transferId: event.transfer.localTxId,
                        promiseId: event.transfer.promiseId,
                        stage: instantClaimStage,
                      });
                      receiverDiagnostics.push(
                        `Receipt materialization failed: ${
                          receiptError instanceof Error ? receiptError.message : String(receiptError)
                        }`,
                      );
                    }
                  }
                  if (chainState.status !== "settled") {
                    instantClaimStage = "settle";
                    chainState = await settlePromiseOnChain({
                      profile: currentWallet.profile,
                      transfer: event.transfer,
                    });
                    await recordDiagnostic({
                      level: chainState.status === "settled" ? "info" : "warn",
                      category:
                        chainState.status === "settled"
                          ? "receiver.instant_claim.settled"
                          : "receiver.instant_claim.pending_settlement",
                      message:
                        chainState.status === "settled"
                          ? `Promise ${event.transfer.promiseId ?? "unknown"} settled from reserve liquidity.`
                          : `Promise ${event.transfer.promiseId ?? "unknown"} claimed immediately but remains pending settlement.`,
                      context: {
                        sessionId: event.sessionId,
                        transferId: event.transfer.localTxId,
                        promiseId: event.transfer.promiseId,
                        claimStatus: chainState.status,
                        claimTx: chainState.claimTx,
                        settleTx: chainState.settleTx,
                        stage: instantClaimStage,
                      },
                    });
                    receiverDiagnostics.push(
                      chainState.status === "settled"
                        ? translate("hook.receiver.instantSettled", {
                            promiseId: event.transfer.promiseId ?? "unknown",
                          })
                        : translate("hook.receiver.instantClaimPending", {
                            promiseId: event.transfer.promiseId ?? "unknown",
                          }),
                    );
                  }
                  resolvedTransfer = {
                    ...event.transfer,
                    claimStatus: chainState.status,
                    settlementStatus: chainState.status === "settled" ? "reconciled" : event.transfer.settlementStatus,
                    sessionSettlementMode: "instant_claim",
                    instantClaimSignature: chainState.claimTx ?? event.transfer.instantClaimSignature,
                    instantSettleSignature: chainState.settleTx ?? event.transfer.instantSettleSignature,
                  };
                  receiptMetadata = {
                    walletId: currentWallet.profile?.walletId,
                    sessionSettlementMode: "instant_claim",
                    claimStatus: chainState.status,
                    claimTxSignature: chainState.claimTx,
                    settleTxSignature: chainState.settleTx,
                  };
                } catch (claimError) {
                  await recordDiagnosticError("receiver.instant_claim.failed", claimError, {
                    sessionId: event.sessionId,
                    transferId: event.transfer.localTxId,
                    promiseId: event.transfer.promiseId,
                    stage: instantClaimStage,
                  });
                  const reason = claimError instanceof Error ? claimError.message : String(claimError);
                  receiverDiagnostics.push(
                    translate("hook.receiver.instantClaimDeferred", {
                      reason,
                    }),
                  );
                  resolvedTransfer = {
                    ...event.transfer,
                    sessionSettlementMode: "offline_promise",
                    claimStatus: event.transfer.claimStatus ?? "pending",
                    settlementStatus: "pending",
                  };
                  receiptMetadata = {
                    walletId: currentWallet.profile?.walletId,
                    sessionSettlementMode: "offline_promise",
                    claimStatus: event.transfer.claimStatus ?? "pending",
                  };
                }
              } else {
                receiverDiagnostics.push(
                  translate("hook.receiver.instantClaimDeferred", {
                    reason: translate("hook.receiver.instantClaimUnavailable"),
                  }),
                );
                resolvedTransfer = {
                  ...event.transfer,
                  sessionSettlementMode: "offline_promise",
                  claimStatus: event.transfer.claimStatus ?? "pending",
                  settlementStatus: "pending",
                };
                receiptMetadata = {
                  walletId: currentWallet.profile?.walletId,
                  sessionSettlementMode: "offline_promise",
                  claimStatus: event.transfer.claimStatus ?? "pending",
                };
              }
            }

            const acknowledgedTransfer = await acknowledgeTransfer(resolvedTransfer, receiptMetadata);
            await publishTransferReceipt(acknowledgedTransfer);
            receiverDiagnostics.push(
              translate("hook.receiver.receiptPublished", {
                receiptId: acknowledgedTransfer.receipt?.receiptId ?? "unknown",
              }),
            );

            const nextWallet = await recordIncomingTransfer(currentWallet, acknowledgedTransfer, receiverDiagnostics);
            await saveWalletState(nextWallet);
            walletRef.current = nextWallet;
            setWallet(nextWallet);
            void refreshTrustSummary();
            void recordDiagnostic({
              level: "info",
              category: "receiver.transfer.accepted",
              message: `Incoming transfer ${acknowledgedTransfer.localTxId} acknowledged.`,
              context: {
                sessionId: event.sessionId,
                transferId: acknowledgedTransfer.localTxId,
                senderDeviceId: event.handshake?.manifest.deviceId,
              },
            });
            void flushDiagnosticsForWallet(nextWallet);
          } catch (incomingError) {
            setError(incomingError instanceof Error ? incomingError.message : String(incomingError));
            setReceiverState({
              status: "error",
              message:
                incomingError instanceof Error
                  ? incomingError.message
                  : translate("hook.receiver.ackFailed"),
            });
            void recordDiagnosticError("receiver.transfer.acknowledge", incomingError, {
              sessionId: event.sessionId,
              transferId: event.transfer.localTxId,
              senderDeviceId: event.handshake?.manifest.deviceId,
            });
            void flushDiagnosticsForWallet(walletRef.current);
          }
        })();
      });
      unsubscribeLifecycle = subscribeToReceiverLifecycle((event) => {
        void recordDiagnostic({
          level: event.type === "error" ? "error" : "info",
          category: `receiver.lifecycle.${event.type}`,
          message: event.message,
          context: {
            sessionId: event.sessionId,
          },
        });
        void flushDiagnosticsForWallet(walletRef.current);
        switch (event.type) {
          case "ready":
            setReceiverState({
              status: "ready",
              sessionId: event.sessionId,
              message: event.message,
            });
            break;
          case "connected":
            setReceiverState({
              status: "connected",
              sessionId: event.sessionId,
              message: event.message,
            });
            break;
          case "disconnected":
            setReceiverState({
              status: "ready",
              sessionId: event.sessionId,
              message: event.message,
            });
            break;
          case "closed":
            setReceiverState({
              status: "idle",
              sessionId: event.sessionId,
              message: event.message,
            });
            void stopReceiverTransport().catch(() => undefined);
            break;
          case "error":
            setReceiverState({
              status: "error",
              sessionId: event.sessionId,
              message: event.message,
            });
            void stopReceiverTransport().catch(() => undefined);
            break;
        }
      });
    } catch (subscriptionError) {
      setReceiverState({
        status: "error",
        message:
          subscriptionError instanceof Error
            ? subscriptionError.message
            : translate("hook.native.subscriptionFailed"),
      });
      void recordDiagnosticError("receiver.subscription", subscriptionError);
    }

    return () => {
      unsubscribeIncoming();
      unsubscribeLifecycle();
      void stopReceiverTransport();
    };
  }, []);

  useEffect(() => {
    const hasTrackableQueue =
      wallet?.manifest &&
      wallet.pendingChainTransactions.some((entry) => entry.status !== "confirmed");

    if (!hasTrackableQueue) {
      return;
    }

    let cancelled = false;

    const refreshQueue = async () => {
      if (chainRefreshInFlightRef.current) {
        return;
      }

      const currentWallet = walletRef.current;
      if (!currentWallet?.manifest) {
        return;
      }

      chainRefreshInFlightRef.current = true;
      try {
        const before = JSON.stringify(
          currentWallet.pendingChainTransactions.map((entry) => ({
            id: entry.intent.intentId,
            status: entry.status,
            txSignature: entry.txSignature,
            submittedAt: entry.submittedAt,
            confirmedAt: entry.confirmedAt,
            lastError: entry.lastError,
          })),
        );
        const nextWallet = await refreshPendingChainTransactionsState(currentWallet, { log: false });
        const after = JSON.stringify(
          nextWallet.pendingChainTransactions.map((entry) => ({
            id: entry.intent.intentId,
            status: entry.status,
            txSignature: entry.txSignature,
            submittedAt: entry.submittedAt,
            confirmedAt: entry.confirmedAt,
            lastError: entry.lastError,
          })),
        );

        if (!cancelled && before !== after) {
          await saveWalletState(nextWallet);
          walletRef.current = nextWallet;
          setWallet(nextWallet);
          void flushDiagnosticsForWallet(nextWallet);
        }
      } catch {
        // Silent polling path; explicit actions surface failures.
      } finally {
        chainRefreshInFlightRef.current = false;
      }
    };

    void refreshQueue();
    const intervalId = setInterval(() => {
      void refreshQueue();
    }, CHAIN_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [wallet]);

  useEffect(() => {
    if (!wallet?.manifest || !wallet.profile) {
      return;
    }
    if (wallet.onboarding.quarantined) {
      return;
    }

    const needsSync =
      !wallet.onboarding.deviceKeyReady ||
      !wallet.onboarding.onChainProfileReady;

    if (!needsSync || protocolRefreshInFlightRef.current) {
      return;
    }

    let cancelled = false;
    protocolRefreshInFlightRef.current = true;

    const sync = async () => {
      try {
        const next = await refreshProtocolStateState(wallet, {
          requestedAmount: wallet.reserve.totalAmount > 0 ? wallet.reserve.totalAmount : undefined,
          requestedTransfers: wallet.reserve.remainingTransfers > 0 ? wallet.reserve.remainingTransfers : undefined,
        });
        if (!cancelled) {
          await saveWalletState(next);
          walletRef.current = next;
          setWallet(next);
          void flushDiagnosticsForWallet(next);
        }
      } catch (startupSyncError) {
        void recordDiagnosticError("onboarding.startup_sync", startupSyncError);
      } finally {
        protocolRefreshInFlightRef.current = false;
      }
    };

    void sync();

    return () => {
      cancelled = true;
    };
  }, [wallet]);

  useEffect(() => {
    if (!wallet?.profile) {
      return;
    }

    const balancesNeedRefresh =
      wallet.balances.SOL.source !== "rpc";

    if (!balancesNeedRefresh || balanceRefreshInFlightRef.current) {
      return;
    }

    let cancelled = false;
    balanceRefreshInFlightRef.current = true;

    const refresh = async () => {
      try {
        const next = await refreshWalletBalancesState(wallet);
        if (!cancelled) {
          await saveWalletState(next);
          walletRef.current = next;
          setWallet(next);
          void flushDiagnosticsForWallet(next);
        }
      } catch (balanceRefreshError) {
        void recordDiagnosticError("wallet.balance.startup_refresh", balanceRefreshError);
      } finally {
        balanceRefreshInFlightRef.current = false;
      }
    };

    void refresh();

    return () => {
      cancelled = true;
    };
  }, [wallet?.profile?.solanaAddress, wallet?.balances.SOL.source]);

  useEffect(() => {
    if (!wallet?.manifest?.deviceId) {
      return;
    }

    void rememberDiagnosticDeviceId(wallet.manifest.deviceId);

    return () => undefined;
  }, [wallet?.manifest?.deviceId]);

  useEffect(() => {
    if (!helperEndpointUrl) {
      return;
    }

    const flushBufferedDiagnostics = () => {
      void flushDiagnosticsForWallet(walletRef.current);
    };

    flushBufferedDiagnostics();
    const intervalId = setInterval(flushBufferedDiagnostics, 15000);
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        flushBufferedDiagnostics();
      }
    });

    return () => {
      clearInterval(intervalId);
      appStateSubscription.remove();
    };
  }, []);

  const pendingAmount = useMemo(
    () =>
      wallet?.journal.reduce(
        (total, entry) =>
          total +
          (entry.assetId === "OFFAIR" &&
          entry.settlementStatus === "pending" &&
          (entry.sessionSettlementMode ?? "offline_promise") === "offline_promise"
            ? entry.amount
            : 0),
        0,
      ) ?? 0,
    [wallet],
  );

  const selectedNearbyReceiver = useMemo(
    () =>
      senderDiscovery.selectedReceiverId
        ? senderDiscovery.receivers.find((receiver) => receiver.candidateId === senderDiscovery.selectedReceiverId) ?? null
        : null,
    [senderDiscovery.receivers, senderDiscovery.selectedReceiverId],
  );

  const pendingChainCount = useMemo(
    () =>
      wallet?.pendingChainTransactions.filter((entry) => entry.status === "queued" || entry.status === "signed" || entry.status === "failed").length ??
      0,
    [wallet],
  );

  const offlineReady = useMemo(() => (wallet ? isOfflineReady(wallet) : false), [wallet]);
  const offlinePromiseCapacity = useMemo(
    () => (wallet ? getOfflinePromiseCapacity(wallet) : null),
    [wallet],
  );

  useEffect(() => {
    if (!selectedNearbyReceiver) {
      setSendTrustPreview(null);
      return;
    }
    void updateSendTrustPreviewForCandidate(selectedNearbyReceiver);
  }, [selectedNearbyReceiver]);

  async function commitWallet(nextWallet: WalletState) {
    await saveWalletState(nextWallet);
    walletRef.current = nextWallet;
    setWallet(nextWallet);
    await refreshTrustSummary();
    await flushDiagnosticsForWallet(nextWallet);
  }

  async function performOfflineSend(
    currentWallet: WalletState,
    amount: number,
    allowTrustWarning = false,
    selectionHint?: SenderReceiverSelectionHint,
  ) {
    const selectedReceiver = resolveSelectedReceiverFromHint(selectionHint);
    if (!selectedReceiver) {
      throw new Error(translate("service.wallet.error.receiverSelectionRequired"));
    }

    const preview = await updateSendTrustPreviewForCandidate(selectedReceiver);
    const peerLabel =
      selectedReceiver.displayName ??
      selectedReceiver.deviceName ??
      selectedReceiver.walletAddress ??
      selectedReceiver.deviceId ??
      translate("common.state.unknown");

    if (preview?.decision === "block") {
      throw new Error(
        translate("service.wallet.error.peerBlockedLocal", {
          peer: peerLabel,
        }),
      );
    }

    if (preview?.decision === "warn" && !allowTrustWarning) {
      throw new SendTrustWarningError({
        amount,
        peerAlias: peerLabel,
        peerLabel,
        peerId: preview.peerId,
        trustBand: preview.trustBand,
        trustScore: preview.trustScore,
        riskLevel: preview.riskLevel,
        riskScore: preview.riskScore,
        reasons: preview.reasons,
        selectedReceiverHint: buildSelectionHint(selectedReceiver),
      });
    }

    const senderRpcReachable = await probeRpcReachability().catch(() => false);
    if (!senderRpcReachable) {
      const capacity = getOfflinePromiseCapacity(currentWallet);
      if (amount > capacity.maxAmount) {
        throw new Error(
          `${translate("service.wallet.error.offairCapExceeded", {
            max: Number.isFinite(capacity.maxAmount) ? capacity.maxAmount.toString() : currentWallet.policy.maxOfflineAmount,
          })} ${capacity.reasons.join("; ")}`,
        );
      }
    }

    const handle = senderDiscoveryHandleRef.current;
    if (!handle) {
      throw new Error(translate("service.wallet.error.discoveryRestartRequired"));
    }

    const session = await handle.createSession({
      manifest: currentWallet.manifest!,
      baseRoot: buildBaseRoot({
        journal: currentWallet.journal,
      }),
      counter: currentWallet.journal.length + 1,
      candidateId: selectedReceiver.candidateId,
    });

    return sendOfflineTransfer(currentWallet, {
      amount,
      peerAlias: peerLabel,
      allowTrustWarning,
      session,
    });
  }

  async function handleActionFailure(actionName: string, actionError: unknown) {
    setError(actionError instanceof Error ? actionError.message : String(actionError));
    await refreshTrustSummary();
    await recordDiagnosticError(`action.${actionName}`, actionError, {
      receiverStatus: receiverState.status,
    });
    await flushDiagnosticsForWallet(walletRef.current);
  }

  async function runAction(actionName: string, action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (actionError) {
      await handleActionFailure(actionName, actionError);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return {
    wallet,
    busy,
    error,
    mnemonicPreview,
    pendingAmount,
    pendingChainCount,
    offlineReady,
    offlinePromiseCapacity,
    trustSummary,
    senderDiscovery,
    selectedNearbyReceiver,
    sendTrustPrompt,
    sendTrustPreview,
    receiverTrustNotice,
    receiverState,
    backgroundRuntime,
    async createWallet(input: {
      passphrase: string;
      displayName?: string;
    }) {
      if (!wallet) {
        return;
      }

      await runAction("wallet.create", async () => {
        const created = await createCustodyWalletState(wallet, input);
        setMnemonicPreview(created.mnemonic);
        await commitWallet(created.state);
      });
    },
    async importWallet(input: {
      mnemonic: string;
      passphrase: string;
      displayName?: string;
    }) {
      if (!wallet) {
        return;
      }

      await runAction("wallet.import", async () => {
        const imported = await importCustodyWalletState(wallet, input);
        setMnemonicPreview(null);
        await commitWallet(imported.state);
      });
    },
    async selectWallet(walletId: string) {
      if (!wallet) {
        return;
      }

      await runAction("wallet.select", async () => {
        const next = await selectActiveWalletState(wallet, walletId);
        await commitWallet(next);
      });
    },
    async revealMnemonic() {
      if (!wallet) {
        return;
      }

      await runAction("wallet.reveal_mnemonic", async () => {
        const revealed = await revealCustodyMnemonicState(wallet);
        setMnemonicPreview(revealed.mnemonic);
        await commitWallet(revealed.state);
      });
    },
    async confirmBackup() {
      if (!wallet) {
        return;
      }

      await runAction("wallet.confirm_backup", async () => {
        const next = await confirmWalletBackupAndRefreshProtocolState(wallet);
        await commitWallet(next);
      });
    },
    dismissMnemonicPreview() {
      setMnemonicPreview(null);
    },
    async refreshBalances() {
      if (!wallet) {
        return;
      }

      await runAction("wallet.refresh_balances", async () => {
        const next = await refreshWalletBalancesState(wallet);
        await commitWallet(next);
      });
    },
    async fundReserve(amount: string) {
      if (!wallet) {
        return;
      }

      await runAction("wallet.fund_reserve", async () => {
        const next = await fundReserveState(wallet, { amount });
        await commitWallet(next);
      });
    },
    async withdrawReserve(amount: string) {
      if (!wallet) {
        return;
      }

      await runAction("wallet.withdraw_reserve", async () => {
        const next = await withdrawReserveState(wallet, { amount });
        await commitWallet(next);
      });
    },
    async refreshProtocolState() {
      if (!wallet) {
        return;
      }

      await runAction("wallet.refresh_protocol_state", async () => {
        const gatewaySyncStatus = await syncGatewayWalletSession(wallet, "manual-refresh");
        const synced = await refreshProtocolStateState(wallet, {
          allowOnChainMutation: true,
        });
        const processed = await syncPromiseStates(synced);
        const refreshedBalances = await refreshWalletBalancesState(processed);
        const refreshed: WalletState = gatewaySyncStatus
          ? {
              ...refreshedBalances,
              statusLog: [gatewaySyncStatus, ...refreshedBalances.statusLog].slice(0, 12),
            }
          : refreshedBalances;
        await commitWallet(refreshed);
      });
    },
    async runAutomaticSync() {
      await runAction("background.sync.manual", async () => {
        await runAutomaticReconnectSync("manual");
      });
    },
    async enableBackgroundRuntime() {
      await runAction("background.enable", async () => {
        const status = await enableNativeBackgroundRuntime();
        setBackgroundRuntime((current) => ({
          ...current,
          ...status,
        }));
        await runAutomaticReconnectSync("runtime");
      });
    },
    async disableBackgroundRuntime() {
      await runAction("background.disable", async () => {
        const status = await disableNativeBackgroundRuntime();
        setBackgroundRuntime((current) => ({
          ...current,
          ...status,
        }));
      });
    },
    async showBackgroundOverlay() {
      await runAction("background.overlay.show", async () => {
        const status = await showBackgroundOverlay();
        setBackgroundRuntime((current) => ({
          ...current,
          ...status,
        }));
      });
    },
    async hideBackgroundOverlay() {
      await runAction("background.overlay.hide", async () => {
        const status = await hideBackgroundOverlay();
        setBackgroundRuntime((current) => ({
          ...current,
          ...status,
        }));
      });
    },
    async requestBluetoothActivation() {
      await runAction("background.bluetooth.enable", async () => {
        const status = await requestBluetoothActivation();
        setBackgroundRuntime((current) => ({
          ...current,
          ...status,
        }));
      });
    },
    async openBluetoothSettings() {
      await runAction("background.bluetooth.settings", async () => {
        const status = await openBluetoothControlPanel();
        setBackgroundRuntime((current) => ({
          ...current,
          ...status,
        }));
      });
    },
    async openNfcSettings() {
      await runAction("background.nfc.settings", async () => {
        const status = await openNfcControlPanel();
        setBackgroundRuntime((current) => ({
          ...current,
          ...status,
        }));
      });
    },
    async queueChainTransfer(assetId: "SOL", toAddress: string, amount: string, memo?: string, reference?: string) {
      if (!wallet) {
        return;
      }

      await runAction("chain.queue_transfer", async () => {
        const next = await queueChainTransferState(wallet, {
          assetId,
          toAddress,
          amount,
          memo,
          reference,
        });
        await commitWallet(next);
      });
    },
    async submitChainTransactions() {
      if (!wallet) {
        return;
      }

      await runAction("chain.submit_transactions", async () => {
        const submitted = await submitPendingChainTransactionsState(wallet);
        const refreshed = await refreshPendingChainTransactionsState(submitted, { log: false });
        await commitWallet(refreshed);
      });
    },
    async refreshChainQueue() {
      if (!wallet) {
        return;
      }

      await runAction("chain.refresh_queue", async () => {
        const next = await refreshPendingChainTransactionsState(wallet);
        await commitWallet(next);
      });
    },
    async payOnlineRequest(request: OnlinePaymentRequest) {
      if (!wallet) {
        return false;
      }

      return runAction("gateway.pay_online_request", async () => {
        const memo = paymentRequestMemo(request);
        const queued = await queueChainTransferState(wallet, {
          assetId: "SOL",
          toAddress: request.wallet,
          amount: request.amount,
          memo,
          reference: request.reference,
        });
        if (backgroundRuntime.networkConnected === false) {
          await commitWallet({
            ...queued,
            statusLog: [
              translate("service.wallet.status.gatewayPaymentQueuedOffline"),
              ...queued.statusLog,
            ].slice(0, 20),
          });
          return;
        }

        const submitted = await submitPendingChainTransactionsState(queued);
        const refreshed = await refreshPendingChainTransactionsState(submitted, { log: false });
        await commitWallet(refreshed);

        const transaction = refreshed.pendingChainTransactions.find(
          (item) =>
            item.intent.toAddress === request.wallet &&
            String(item.intent.amount) === String(request.amount) &&
            item.intent.reference === request.reference &&
            item.intent.memo === memo,
        );
        if (!transaction || transaction.status === "failed") {
          throw new Error(transaction?.lastError ?? translate("service.chain.error.submitSigned"));
        }
        if (!transaction.txSignature && transaction.status !== "queued" && transaction.status !== "signed") {
          throw new Error(transaction?.lastError ?? translate("service.chain.error.submitSigned"));
        }
      });
    },
    async send(amount: number, peerAlias: string) {
      void peerAlias;
      if (!wallet) {
        return;
      }
      setBusy(true);
      setError(null);
      setSendTrustPrompt(null);
      const selectedReceiverHint = buildSelectionHint(selectedNearbyReceiver);
      try {
        const next = await performOfflineSend(wallet, amount, false, selectedReceiverHint);
        await commitWallet(next);
      } catch (actionError) {
        if (actionError instanceof SendTrustWarningError) {
          setSendTrustPrompt(actionError.prompt);
          await refreshTrustSummary();
          await recordDiagnostic({
            level: "warn",
            category: "offline.send.trust_warn",
            message: actionError.message,
            context: {
              peerId: actionError.prompt.peerId,
              peerLabel: actionError.prompt.peerLabel,
              trustBand: actionError.prompt.trustBand,
              trustScore: actionError.prompt.trustScore,
              riskLevel: actionError.prompt.riskLevel,
              riskScore: actionError.prompt.riskScore,
            },
          });
          await flushDiagnosticsForWallet(walletRef.current);
        } else {
          await handleActionFailure("offline.send", actionError);
        }
      } finally {
        await stopSenderDiscoveryInternal({ preserveReceivers: true });
        await startSenderDiscoveryInternal(selectedReceiverHint);
        setBusy(false);
      }
    },
    async confirmSendTrustWarning() {
      const currentWallet = walletRef.current;
      const prompt = sendTrustPrompt;
      if (!currentWallet || !prompt) {
        return;
      }

      setBusy(true);
      setError(null);
      const selectedReceiverHint = prompt.selectedReceiverHint ?? buildSelectionHint(selectedNearbyReceiver);
      try {
        const next = await performOfflineSend(currentWallet, prompt.amount, true, selectedReceiverHint);
        setSendTrustPrompt(null);
        await commitWallet(next);
      } catch (actionError) {
        setSendTrustPrompt(null);
        await handleActionFailure("offline.send.confirm_warn", actionError);
      } finally {
        await stopSenderDiscoveryInternal({ preserveReceivers: true });
        await startSenderDiscoveryInternal(selectedReceiverHint);
        setBusy(false);
      }
    },
    dismissSendTrustWarning() {
      setSendTrustPrompt(null);
      setError(null);
    },
    async previewSendTrust(peerHint: string) {
      const preview = await previewOfflinePeerTrust({ peerHint });
      if (!preview) {
        setSendTrustPreview(null);
        return;
      }
      setSendTrustPreview(translatePreviewMessage(preview));
    },
    async startSenderDiscovery() {
      setError(null);
      await startSenderDiscoveryInternal();
    },
    async stopSenderDiscovery() {
      await stopSenderDiscoveryInternal();
    },
    async retryNfcDiscovery() {
      const handle = senderDiscoveryHandleRef.current;
      if (!handle) {
        await startSenderDiscoveryInternal();
        return;
      }
      setSenderDiscovery((current) => ({
        ...current,
        nfcStatus: "scanning",
      }));
      await handle.retryNfc();
    },
    async selectNearbyReceiver(candidateId: string) {
      const handle = senderDiscoveryHandleRef.current;
      if (!handle) {
        throw new Error(translate("service.wallet.error.discoveryRestartRequired"));
      }
      setError(null);
      const candidate = handle.getSnapshot().receivers.find((receiver) => receiver.candidateId === candidateId);
      if (candidate && candidate.mode === "ble" && !candidate.resolved) {
        setSenderDiscovery((current) => ({
          ...current,
          selectedReceiverId: candidate.candidateId,
          resolvingReceiverId: null,
        }));
        await updateSendTrustPreviewForCandidate(candidate);
        return;
      }
      setSenderDiscovery((current) => ({
        ...current,
        resolvingReceiverId: candidateId,
      }));
      try {
        const resolved = await handle.resolveCandidate(candidateId);
        applySenderDiscoverySnapshot(handle.getSnapshot());
        setSenderDiscovery((current) => ({
          ...current,
          selectedReceiverId: resolved.candidateId,
          resolvingReceiverId: null,
        }));
        await updateSendTrustPreviewForCandidate(resolved);
      } catch (selectionError) {
        setSenderDiscovery((current) => ({
          ...current,
          resolvingReceiverId: null,
        }));
        throw selectionError;
      }
    },
    async prepareReceiver() {
      await runAction("receiver.prepare", async () => {
        const currentWallet = walletRef.current;
        if (!currentWallet) {
          throw new Error(translate("service.wallet.error.receiverManifest"));
        }
        const manifest = currentWallet.manifest;
        if (!manifest) {
          throw new Error(translate("service.wallet.error.receiverManifest"));
        }
        const receiverReadiness = canArmReceiver(currentWallet);
        if (!receiverReadiness.ok) {
          throw new Error(receiverReadiness.reason);
        }
        setReceiverTrustNotice(null);
        setReceiverState({
          status: "arming",
          message: translate("service.wallet.status.receiverPreparing"),
        });

        const receiverBaseRoot = buildBaseRoot({
          journal: currentWallet.journal,
        });
        const prepared = await prepareReceiverTransport({
          manifest,
          baseRoot: receiverBaseRoot,
          counter: currentWallet.journal.length + 1,
          transportIds: getDefaultTransportIds(),
        });
        const nextWallet = {
          ...currentWallet,
          statusLog: [`Receiver session ${prepared.sessionId} armed for NFC tap.`, ...prepared.diagnostics, ...currentWallet.statusLog].slice(
            0,
            12,
          ),
        };
        await commitWallet(nextWallet);
        setReceiverState({
          status: "ready",
          sessionId: prepared.sessionId,
          message: translate("service.wallet.status.receiverReady"),
        });
      });
    },
    async stopReceiver() {
      await runAction("receiver.stop", async () => {
        await stopReceiverTransport();
        setReceiverTrustNotice(null);
        setReceiverState({
          status: "idle",
          message: translate("hook.receiver.notArmed"),
        });
      });
    },
    async reset() {
      await runAction("wallet.reset", async () => {
        const next = await resetWalletState();
        setMnemonicPreview(null);
        await commitWallet(next);
      });
    },
  };
}

export type AirPayWalletController = ReturnType<typeof useAirPayWallet>;
