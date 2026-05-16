import AsyncStorage from "@react-native-async-storage/async-storage";
import { sha256Hex } from "@airpay/shared";

export type TrustCacheTier = "hot" | "warm" | "cold";
export type TrustBand = "trusted" | "neutral" | "watch" | "blocked";
export type PeerInteractionKind =
  | "sent"
  | "received"
  | "claimed"
  | "settled"
  | "rejected"
  | "encountered"
  | "handshake-accepted"
  | "receipt-published"
  | "closed"
  | "closed-clean";
export type BlacklistState = "clear" | "listed" | "unknown";
export type LocalTrustDecision = "allow" | "warn" | "block";
export type EncounterRecency = "fresh" | "recent" | "stale" | "cold";
export type OperationalTrustSignal = "stable" | "pending" | "recovering" | "risky";
export type SessionQuality = "verified" | "mixed" | "fragile" | "unknown";
export type LocalRiskLevel = "low" | "guarded" | "high" | "blocked";

export interface LocalInteractionEvent {
  peerId: string;
  kind: PeerInteractionKind;
  amount?: number;
  occurredAt: string;
  regionHint?: string;
}

export interface PeerInteractionStats {
  peerId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  totalInteractions: number;
  encounterCount: number;
  handshakeAcceptedCount: number;
  receiptPublishedCount: number;
  closedCount: number;
  cleanCloseCount: number;
  sentCount: number;
  receivedCount: number;
  claimCount: number;
  settledCount: number;
  rejectedCount: number;
  totalAmount: number;
  lastRegionHint?: string;
}

export interface BlacklistDigest {
  subjectId: string;
  sourceAuthority: string;
  signatureDigest: string;
  listedAt: string;
  expiresAt?: string;
  epoch?: number;
  rootHash?: string;
  reasonCode?: string;
  ttlSeconds: number;
}

export interface ReputationCheckpoint {
  peerId: string;
  checkpointHash: string;
  rootHash: string;
  createdAt: string;
  ttlSeconds: number;
  blockHeight?: number;
}

export interface PeerTrustSummary {
  peerId: string;
  cacheTier: TrustCacheTier;
  trustBand: TrustBand;
  trustScore: number;
  blacklistState: BlacklistState;
  interactionCount: number;
  encounterCount: number;
  handshakeAcceptedCount: number;
  receiptPublishedCount: number;
  sessionCloseCount: number;
  cleanCloseCount: number;
  successfulSettlements: number;
  failedSettlements: number;
  pendingClaims: number;
  totalAmount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastRegionHint?: string;
  updatedAt: string;
}

export interface CompactReputationHint {
  peerId: string;
  trustBand: TrustBand;
  trustScore: number;
  blacklistState: BlacklistState;
  lastSeenAt: string;
  interactionCount: number;
}

export interface GossipEnvelope {
  issuedAt: string;
  expiresAt: string;
  reputations: CompactReputationHint[];
  blacklist: BlacklistDigest[];
  checkpoints: ReputationCheckpoint[];
}

export interface TrustDecisionSnapshot {
  peerId?: string;
  decision: LocalTrustDecision;
  trustBand: TrustBand;
  trustScore: number;
  riskLevel: LocalRiskLevel;
  riskScore: number;
  reasons: string[];
  summary?: PeerTrustSummary;
}

export interface PeerTrustPreview {
  peerId: string;
  decision: LocalTrustDecision;
  trustBand: TrustBand;
  trustScore: number;
  riskLevel: LocalRiskLevel;
  riskScore: number;
  reasons: string[];
  summary: PeerTrustSummary;
}

export interface TrustCacheSummary {
  hotPeers: number;
  warmPeers: number;
  coldPeers: number;
  freshPeers: number;
  recentPeersCount: number;
  stalePeers: number;
  pendingPeers: number;
  recoveringPeers: number;
  riskyPeers: number;
  lowRiskPeers: number;
  guardedRiskPeers: number;
  highRiskPeers: number;
  blockedRiskPeers: number;
  verifiedPeers: number;
  mixedPeers: number;
  fragilePeers: number;
  unknownPeers: number;
  blacklistedPeers: number;
  checkpoints: number;
  trustedPeers: number;
  watchPeers: number;
  blockedPeers: number;
  updatedAt: string;
  recentPeers: Array<
    PeerTrustSummary & {
      encounterRecency: EncounterRecency;
      operationalSignal: OperationalTrustSignal;
      sessionQuality: SessionQuality;
      riskLevel: LocalRiskLevel;
      riskScore: number;
    }
  >;
}

export interface LocalTrustState {
  peers: Record<string, PeerTrustSummary>;
  interactions: Record<string, PeerInteractionStats>;
  blacklist: Record<string, BlacklistDigest>;
  checkpoints: Record<string, ReputationCheckpoint>;
  updatedAt: string;
}

const TRUST_STORAGE_KEY = "airpay.trust.state.v1";

function nowIso() {
  return new Date().toISOString();
}

function hoursBetween(leftIso: string, rightIso: string) {
  return Math.abs(new Date(leftIso).getTime() - new Date(rightIso).getTime()) / (1000 * 60 * 60);
}

function isExpired(createdAt: string, ttlSeconds: number, now: string) {
  return new Date(createdAt).getTime() + ttlSeconds * 1000 <= new Date(now).getTime();
}

function getTime(value: string | undefined) {
  if (!value) {
    return Number.NaN;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.NaN;
}

function isBlacklistDigestExpired(entry: BlacklistDigest, now: string) {
  const nowTime = getTime(now);
  const ttlExpired = isExpired(entry.listedAt, entry.ttlSeconds, now);
  const explicitExpiry = entry.expiresAt ? getTime(entry.expiresAt) <= nowTime : false;
  return ttlExpired || explicitExpiry;
}

export function buildBlacklistSignatureDigest(entry: Omit<BlacklistDigest, "signatureDigest">): string {
  return sha256Hex({
    domain: "airpay:blacklist-digest:v1",
    epoch: entry.epoch ?? null,
    expiresAt: entry.expiresAt ?? null,
    listedAt: entry.listedAt,
    reasonCode: entry.reasonCode ?? null,
    rootHash: entry.rootHash ?? null,
    sourceAuthority: entry.sourceAuthority,
    subjectId: entry.subjectId,
    ttlSeconds: entry.ttlSeconds,
  });
}

export function validateBlacklistDigest(
  entry: BlacklistDigest,
  now = nowIso(),
): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const subjectId = typeof entry.subjectId === "string" ? entry.subjectId : "";
  const sourceAuthority = typeof entry.sourceAuthority === "string" ? entry.sourceAuthority : "";

  if (!subjectId.trim()) {
    reasons.push("blacklist subject missing");
  }
  if (!sourceAuthority.trim()) {
    reasons.push("blacklist authority missing");
  }
  if (!Number.isFinite(entry.ttlSeconds) || entry.ttlSeconds <= 0) {
    reasons.push("blacklist ttl invalid");
  }
  if (!Number.isFinite(getTime(entry.listedAt))) {
    reasons.push("blacklist listedAt invalid");
  }
  if (entry.expiresAt && !Number.isFinite(getTime(entry.expiresAt))) {
    reasons.push("blacklist expiresAt invalid");
  }
  if (isBlacklistDigestExpired(entry, now)) {
    reasons.push("blacklist digest expired");
  }

  const expectedDigest = buildBlacklistSignatureDigest({
    subjectId: entry.subjectId,
    sourceAuthority: entry.sourceAuthority,
    listedAt: entry.listedAt,
    expiresAt: entry.expiresAt,
    epoch: entry.epoch,
    rootHash: entry.rootHash,
    reasonCode: entry.reasonCode,
    ttlSeconds: entry.ttlSeconds,
  });
  if (entry.signatureDigest !== expectedDigest) {
    reasons.push("blacklist signature digest mismatch");
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}

export function validateGossipEnvelopeFreshness(
  envelope: GossipEnvelope,
  now = nowIso(),
): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const issuedAt = getTime(envelope.issuedAt);
  const expiresAt = getTime(envelope.expiresAt);
  const nowTime = getTime(now);

  if (!Number.isFinite(issuedAt)) {
    reasons.push("gossip issuedAt invalid");
  }
  if (!Number.isFinite(expiresAt)) {
    reasons.push("gossip expiresAt invalid");
  }
  if (Number.isFinite(issuedAt) && Number.isFinite(expiresAt) && issuedAt >= expiresAt) {
    reasons.push("gossip issuedAt after expiresAt");
  }
  if (Number.isFinite(expiresAt) && expiresAt <= nowTime) {
    reasons.push("gossip envelope expired");
  }
  if (Number.isFinite(issuedAt) && issuedAt > nowTime + 5 * 60 * 1000) {
    reasons.push("gossip issued in the future");
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function localRiskSeverity(riskLevel: LocalRiskLevel) {
  return riskLevel === "blocked" ? 3 : riskLevel === "high" ? 2 : riskLevel === "guarded" ? 1 : 0;
}

export function createEmptyTrustState(now = nowIso()): LocalTrustState {
  return {
    peers: {},
    interactions: {},
    blacklist: {},
    checkpoints: {},
    updatedAt: now,
  };
}

function normalizeInteractionStats(
  peerId: string,
  stats: Partial<PeerInteractionStats> | undefined,
  now: string,
): PeerInteractionStats {
  return {
    peerId,
    firstSeenAt: stats?.firstSeenAt ?? stats?.lastSeenAt ?? now,
    lastSeenAt: stats?.lastSeenAt ?? stats?.firstSeenAt ?? now,
    totalInteractions: stats?.totalInteractions ?? 0,
    encounterCount: stats?.encounterCount ?? 0,
    handshakeAcceptedCount: stats?.handshakeAcceptedCount ?? 0,
    receiptPublishedCount: stats?.receiptPublishedCount ?? 0,
    closedCount: stats?.closedCount ?? 0,
    cleanCloseCount: stats?.cleanCloseCount ?? 0,
    sentCount: stats?.sentCount ?? 0,
    receivedCount: stats?.receivedCount ?? 0,
    claimCount: stats?.claimCount ?? 0,
    settledCount: stats?.settledCount ?? 0,
    rejectedCount: stats?.rejectedCount ?? 0,
    totalAmount: stats?.totalAmount ?? 0,
    lastRegionHint: stats?.lastRegionHint,
  };
}

function normalizePeerSummary(
  peerId: string,
  peer: Partial<PeerTrustSummary> | undefined,
  blacklist: BlacklistDigest | undefined,
  interactions: PeerInteractionStats | undefined,
  now: string,
): PeerTrustSummary {
  if (interactions) {
    return summarizePeer({
      interactions,
      blacklist,
      now,
    });
  }

  return {
    peerId,
    cacheTier: peer?.cacheTier ?? "cold",
    trustBand: peer?.trustBand ?? (blacklist ? "blocked" : "neutral"),
    trustScore: peer?.trustScore ?? (blacklist ? 0 : 50),
    blacklistState: blacklist ? "listed" : (peer?.blacklistState ?? "unknown"),
    interactionCount: peer?.interactionCount ?? 0,
    encounterCount: peer?.encounterCount ?? 0,
    handshakeAcceptedCount: peer?.handshakeAcceptedCount ?? 0,
    receiptPublishedCount: peer?.receiptPublishedCount ?? 0,
    sessionCloseCount: peer?.sessionCloseCount ?? 0,
    cleanCloseCount: peer?.cleanCloseCount ?? 0,
    successfulSettlements: peer?.successfulSettlements ?? 0,
    failedSettlements: peer?.failedSettlements ?? 0,
    pendingClaims: peer?.pendingClaims ?? 0,
    totalAmount: peer?.totalAmount ?? 0,
    firstSeenAt: peer?.firstSeenAt ?? peer?.lastSeenAt ?? now,
    lastSeenAt: peer?.lastSeenAt ?? peer?.firstSeenAt ?? now,
    lastRegionHint: peer?.lastRegionHint,
    updatedAt: peer?.updatedAt ?? now,
  };
}

export function classifyTrustCacheTier(input: {
  totalInteractions: number;
  lastSeenAt: string;
  now?: string;
}): TrustCacheTier {
  const now = input.now ?? nowIso();
  const ageHours = hoursBetween(input.lastSeenAt, now);

  if (input.totalInteractions >= 5 && ageHours <= 72) {
    return "hot";
  }
  if (input.totalInteractions >= 2 && ageHours <= 30 * 24) {
    return "warm";
  }
  return "cold";
}

export function classifyEncounterRecency(input: {
  lastSeenAt: string;
  now?: string;
}): EncounterRecency {
  const now = input.now ?? nowIso();
  const ageHours = hoursBetween(input.lastSeenAt, now);

  if (ageHours <= 6) {
    return "fresh";
  }
  if (ageHours <= 72) {
    return "recent";
  }
  if (ageHours <= 30 * 24) {
    return "stale";
  }
  return "cold";
}

export function classifyOperationalTrustSignal(input: {
  peer: PeerTrustSummary;
  now?: string;
}): OperationalTrustSignal {
  const now = input.now ?? nowIso();
  const ageHours = hoursBetween(input.peer.lastSeenAt, now);
  const incompleteSessions = Math.max(0, input.peer.handshakeAcceptedCount - input.peer.receiptPublishedCount);
  const unstableClosures = Math.max(0, input.peer.sessionCloseCount - input.peer.cleanCloseCount);

  if (input.peer.blacklistState === "listed" || input.peer.trustBand === "blocked") {
    return "risky";
  }
  if (input.peer.pendingClaims > 0) {
    return "pending";
  }
  if (input.peer.failedSettlements > 0) {
    return ageHours <= 7 * 24 ? "risky" : "recovering";
  }
  if (
    (input.peer.handshakeAcceptedCount >= 3 && incompleteSessions >= 2 && input.peer.receiptPublishedCount === 0) ||
    (unstableClosures >= 3 && input.peer.cleanCloseCount === 0 && ageHours <= 7 * 24)
  ) {
    return "risky";
  }
  if ((incompleteSessions > 0 || unstableClosures > input.peer.cleanCloseCount) && ageHours <= 7 * 24) {
    return "recovering";
  }
  return "stable";
}

export function classifySessionQuality(input: {
  peer: Pick<
    PeerTrustSummary,
    "handshakeAcceptedCount" | "receiptPublishedCount" | "sessionCloseCount" | "cleanCloseCount"
  >;
}): SessionQuality {
  const incompleteSessions = Math.max(0, input.peer.handshakeAcceptedCount - input.peer.receiptPublishedCount);
  const unstableClosures = Math.max(0, input.peer.sessionCloseCount - input.peer.cleanCloseCount);

  if (
    input.peer.handshakeAcceptedCount === 0 &&
    input.peer.receiptPublishedCount === 0 &&
    input.peer.sessionCloseCount === 0 &&
    input.peer.cleanCloseCount === 0
  ) {
    return "unknown";
  }
  if (
    input.peer.handshakeAcceptedCount >= 3 &&
    (incompleteSessions >= 2 || unstableClosures >= 2) &&
    input.peer.receiptPublishedCount === 0
  ) {
    return "fragile";
  }
  if (incompleteSessions > 0 || unstableClosures > 0) {
    return "mixed";
  }
  return "verified";
}

export function evaluateLocalPeerRisk(input: {
  peer: PeerTrustSummary;
  now?: string;
}): {
  riskLevel: LocalRiskLevel;
  riskScore: number;
  encounterRecency: EncounterRecency;
  operationalSignal: OperationalTrustSignal;
  sessionQuality: SessionQuality;
} {
  const encounterRecency = classifyEncounterRecency({
    lastSeenAt: input.peer.lastSeenAt,
    now: input.now,
  });
  const operationalSignal = classifyOperationalTrustSignal({
    peer: input.peer,
    now: input.now,
  });
  const sessionQuality = classifySessionQuality({
    peer: input.peer,
  });

  if (input.peer.blacklistState === "listed" || input.peer.trustBand === "blocked") {
    return {
      riskLevel: "blocked",
      riskScore: 100,
      encounterRecency,
      operationalSignal,
      sessionQuality,
    };
  }

  let riskScore = 100 - input.peer.trustScore;
  riskScore += input.peer.pendingClaims * 4;
  riskScore += input.peer.failedSettlements * 12;
  riskScore -= Math.min(input.peer.successfulSettlements * 3, 18);

  riskScore +=
    encounterRecency === "fresh"
      ? -8
      : encounterRecency === "recent"
        ? 0
        : encounterRecency === "stale"
          ? 8
          : 14;

  riskScore +=
    operationalSignal === "stable"
      ? -10
      : operationalSignal === "pending"
        ? 10
        : operationalSignal === "recovering"
          ? 18
          : 30;

  riskScore +=
    sessionQuality === "verified"
      ? -10
      : sessionQuality === "mixed"
        ? 10
        : sessionQuality === "fragile"
          ? 24
          : 5;

  riskScore = clamp(Math.round(riskScore), 0, 100);

  const riskLevel =
    riskScore >= 85 ? "blocked" : riskScore >= 60 ? "high" : riskScore >= 30 ? "guarded" : "low";

  return {
    riskLevel,
    riskScore,
    encounterRecency,
    operationalSignal,
    sessionQuality,
  };
}

export function computeTrustScore(input: {
  interactions: PeerInteractionStats;
  blacklist?: BlacklistDigest;
  now?: string;
}): { trustScore: number; trustBand: TrustBand; blacklistState: BlacklistState } {
  const now = input.now ?? nowIso();
  const blacklistActive = input.blacklist && validateBlacklistDigest(input.blacklist, now).ok;
  if (blacklistActive) {
    return {
      trustScore: 0,
      trustBand: "blocked",
      blacklistState: "listed",
    };
  }

  const successfulWeight = input.interactions.settledCount * 14;
  const rejectionPenalty = input.interactions.rejectedCount * 22;
  const claimWeight = input.interactions.claimCount * 4;
  const recencyBonus = clamp(72 - hoursBetween(input.interactions.lastSeenAt, now), 0, 72) / 3;
  const activityBonus = Math.min(input.interactions.totalInteractions * 3, 18);
  const rawScore = 40 + successfulWeight + claimWeight + recencyBonus + activityBonus - rejectionPenalty;
  const trustScore = clamp(Math.round(rawScore), 0, 100);

  if (trustScore >= 75) {
    return { trustScore, trustBand: "trusted", blacklistState: "clear" };
  }
  if (trustScore >= 45) {
    return { trustScore, trustBand: "neutral", blacklistState: "clear" };
  }
  return { trustScore, trustBand: "watch", blacklistState: "clear" };
}

function summarizePeer(input: {
  interactions: PeerInteractionStats;
  blacklist?: BlacklistDigest;
  now?: string;
}): PeerTrustSummary {
  const now = input.now ?? nowIso();
  const score = computeTrustScore({
    interactions: input.interactions,
    blacklist: input.blacklist,
    now,
  });

  return {
    peerId: input.interactions.peerId,
    cacheTier: classifyTrustCacheTier({
      totalInteractions: input.interactions.totalInteractions,
      lastSeenAt: input.interactions.lastSeenAt,
      now,
    }),
    trustBand: score.trustBand,
    trustScore: score.trustScore,
    blacklistState: score.blacklistState,
    interactionCount: input.interactions.totalInteractions,
    encounterCount: input.interactions.encounterCount,
    handshakeAcceptedCount: input.interactions.handshakeAcceptedCount,
    receiptPublishedCount: input.interactions.receiptPublishedCount,
    sessionCloseCount: input.interactions.closedCount,
    cleanCloseCount: input.interactions.cleanCloseCount,
    successfulSettlements: input.interactions.settledCount,
    failedSettlements: input.interactions.rejectedCount,
    pendingClaims: Math.max(0, input.interactions.claimCount - input.interactions.settledCount - input.interactions.rejectedCount),
    totalAmount: input.interactions.totalAmount,
    firstSeenAt: input.interactions.firstSeenAt,
    lastSeenAt: input.interactions.lastSeenAt,
    lastRegionHint: input.interactions.lastRegionHint,
    updatedAt: now,
  };
}

function summarizeHintPeer(input: {
  peerId: string;
  trustBand: TrustBand;
  trustScore: number;
  blacklistState: BlacklistState;
  interactionCount: number;
  lastSeenAt: string;
  now?: string;
}): PeerTrustSummary {
  const now = input.now ?? nowIso();
  return {
    peerId: input.peerId,
    cacheTier: classifyTrustCacheTier({
      totalInteractions: input.interactionCount,
      lastSeenAt: input.lastSeenAt,
      now,
    }),
    trustBand: input.trustBand,
    trustScore: input.trustScore,
    blacklistState: input.blacklistState,
    interactionCount: input.interactionCount,
    encounterCount: 0,
    handshakeAcceptedCount: 0,
    receiptPublishedCount: 0,
    sessionCloseCount: 0,
    cleanCloseCount: 0,
    successfulSettlements: 0,
    failedSettlements: 0,
    pendingClaims: 0,
    totalAmount: 0,
    firstSeenAt: input.lastSeenAt,
    lastSeenAt: input.lastSeenAt,
    updatedAt: now,
  };
}

function normalizePeerIds(peerIds: string[] | undefined): string[] {
  if (!peerIds) {
    return [];
  }

  return [...new Set(peerIds.map((item) => item.trim()).filter(Boolean))];
}

function computePeerRelevance(
  peer: PeerTrustSummary,
  now: string,
  context: {
    targetPeerIds?: Set<string>;
  } = {},
) {
  const recencyHours = hoursBetween(peer.lastSeenAt, now);
  const recencyScore = Math.max(0, 240 - recencyHours);
  const tierScore = peer.cacheTier === "hot" ? 180 : peer.cacheTier === "warm" ? 90 : 20;
  const targetScore = context.targetPeerIds?.has(peer.peerId) ? 2000 : 0;
  const incompleteSessions = Math.max(0, peer.handshakeAcceptedCount - peer.receiptPublishedCount);
  const unstableClosures = Math.max(0, peer.sessionCloseCount - peer.cleanCloseCount);
  const riskScore =
    (peer.blacklistState === "listed" ? 600 : 0) +
    (peer.trustBand === "blocked" ? 260 : peer.trustBand === "watch" ? 60 : 0) +
    peer.failedSettlements * 160 +
    peer.pendingClaims * 180 +
    incompleteSessions * 70 +
    unstableClosures * 60;
  const activityScore = Math.min(peer.interactionCount * 12, 120);
  const reliabilityScore =
    peer.successfulSettlements * 70 +
    peer.receiptPublishedCount * 45 +
    peer.cleanCloseCount * 20 +
    peer.encounterCount * 6 +
    Math.round(peer.trustScore * 1.5);

  return targetScore + tierScore + riskScore + activityScore + recencyScore + reliabilityScore;
}

export function recordPeerInteraction(
  state: LocalTrustState,
  event: LocalInteractionEvent,
  now = event.occurredAt,
): LocalTrustState {
  const existing = state.interactions[event.peerId];
  const nextStats: PeerInteractionStats = {
    peerId: event.peerId,
    firstSeenAt: existing?.firstSeenAt ?? event.occurredAt,
    lastSeenAt: event.occurredAt,
    totalInteractions: (existing?.totalInteractions ?? 0) + 1,
    encounterCount: (existing?.encounterCount ?? 0) + (event.kind === "encountered" ? 1 : 0),
    handshakeAcceptedCount:
      (existing?.handshakeAcceptedCount ?? 0) + (event.kind === "handshake-accepted" ? 1 : 0),
    receiptPublishedCount:
      (existing?.receiptPublishedCount ?? 0) + (event.kind === "receipt-published" ? 1 : 0),
    closedCount: (existing?.closedCount ?? 0) + (event.kind === "closed" ? 1 : 0),
    cleanCloseCount: (existing?.cleanCloseCount ?? 0) + (event.kind === "closed-clean" ? 1 : 0),
    sentCount: (existing?.sentCount ?? 0) + (event.kind === "sent" ? 1 : 0),
    receivedCount: (existing?.receivedCount ?? 0) + (event.kind === "received" ? 1 : 0),
    claimCount: (existing?.claimCount ?? 0) + (event.kind === "claimed" ? 1 : 0),
    settledCount: (existing?.settledCount ?? 0) + (event.kind === "settled" ? 1 : 0),
    rejectedCount: (existing?.rejectedCount ?? 0) + (event.kind === "rejected" ? 1 : 0),
    totalAmount: (existing?.totalAmount ?? 0) + (event.amount ?? 0),
    lastRegionHint: event.regionHint ?? existing?.lastRegionHint,
  };

  return {
    ...state,
    interactions: {
      ...state.interactions,
      [event.peerId]: nextStats,
    },
    peers: {
      ...state.peers,
      [event.peerId]: summarizePeer({
        interactions: nextStats,
        blacklist: state.blacklist[event.peerId],
        now,
      }),
    },
    updatedAt: now,
  };
}

export function ingestBlacklistDigests(
  state: LocalTrustState,
  entries: BlacklistDigest[],
  now = nowIso(),
): LocalTrustState {
  const nextBlacklist = { ...state.blacklist };
  const nextPeers = { ...state.peers };

  for (const entry of entries) {
    if (isBlacklistDigestExpired(entry, now)) {
      delete nextBlacklist[entry.subjectId];
      continue;
    }
    if (!validateBlacklistDigest(entry, now).ok) {
      continue;
    }

    const current = nextBlacklist[entry.subjectId];
    if (!current || new Date(entry.listedAt).getTime() >= new Date(current.listedAt).getTime()) {
      nextBlacklist[entry.subjectId] = entry;
    }
  }

  for (const [subjectId, entry] of Object.entries(nextBlacklist)) {
    if (!validateBlacklistDigest(entry, now).ok) {
      delete nextBlacklist[subjectId];
    }
  }

  for (const [peerId, peer] of Object.entries(nextPeers)) {
    const interactions = state.interactions[peerId];
    if (!interactions) {
      continue;
    }
    nextPeers[peerId] = summarizePeer({
      interactions,
      blacklist: nextBlacklist[peerId],
      now,
    });
  }

  return {
    ...state,
    blacklist: nextBlacklist,
    peers: nextPeers,
    updatedAt: now,
  };
}

export function ingestReputationCheckpoints(
  state: LocalTrustState,
  checkpoints: ReputationCheckpoint[],
  now = nowIso(),
): LocalTrustState {
  const nextCheckpoints = { ...state.checkpoints };

  for (const checkpoint of checkpoints) {
    if (isExpired(checkpoint.createdAt, checkpoint.ttlSeconds, now)) {
      continue;
    }
    const existing = nextCheckpoints[checkpoint.checkpointHash];
    if (!existing || new Date(checkpoint.createdAt).getTime() >= new Date(existing.createdAt).getTime()) {
      nextCheckpoints[checkpoint.checkpointHash] = checkpoint;
    }
  }

  for (const [checkpointHash, checkpoint] of Object.entries(nextCheckpoints)) {
    if (isExpired(checkpoint.createdAt, checkpoint.ttlSeconds, now)) {
      delete nextCheckpoints[checkpointHash];
    }
  }

  return {
    ...state,
    checkpoints: nextCheckpoints,
    updatedAt: now,
  };
}

export function pruneTrustState(
  state: LocalTrustState,
  options: {
    now?: string;
    maxColdPeers?: number;
  } = {},
): LocalTrustState {
  const now = options.now ?? nowIso();
  const maxColdPeers = options.maxColdPeers ?? 128;
  const withoutExpiredBlacklist = ingestBlacklistDigests(state, [], now);
  const withoutExpiredCheckpoints = ingestReputationCheckpoints(withoutExpiredBlacklist, [], now);

  const coldPeers = Object.values(withoutExpiredCheckpoints.peers)
    .filter((peer) => peer.cacheTier === "cold")
    .sort((left, right) => {
      const scoreDelta = computePeerRelevance(right, now) - computePeerRelevance(left, now);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    });
  const keepCold = new Set(coldPeers.slice(0, maxColdPeers).map((peer) => peer.peerId));

  const nextPeers = Object.fromEntries(
    Object.entries(withoutExpiredCheckpoints.peers).filter(([, peer]) => peer.cacheTier !== "cold" || keepCold.has(peer.peerId)),
  );
  const nextInteractions = Object.fromEntries(
    Object.entries(withoutExpiredCheckpoints.interactions).filter(([peerId]) => nextPeers[peerId]),
  );

  return {
    ...withoutExpiredCheckpoints,
    peers: nextPeers,
    interactions: nextInteractions,
    updatedAt: now,
  };
}

export function buildSelectiveGossipEnvelope(
  state: LocalTrustState,
  options: {
    now?: string;
    maxPeers?: number;
    maxBlacklist?: number;
    maxCheckpoints?: number;
    targetPeerIds?: string[];
  } = {},
): GossipEnvelope {
  const now = options.now ?? nowIso();
  const maxPeers = options.maxPeers ?? 24;
  const maxBlacklist = options.maxBlacklist ?? 24;
  const maxCheckpoints = options.maxCheckpoints ?? 32;
  const pruned = pruneTrustState(state, { now });
  const targetPeerIds = new Set(normalizePeerIds(options.targetPeerIds));

  const reputations = Object.values(pruned.peers)
    .sort((left, right) => {
      const scoreDelta =
        computePeerRelevance(right, now, { targetPeerIds }) - computePeerRelevance(left, now, { targetPeerIds });
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    })
    .slice(0, maxPeers)
    .map((peer) => ({
      peerId: peer.peerId,
      trustBand: peer.trustBand,
      trustScore: peer.trustScore,
      blacklistState: peer.blacklistState,
      lastSeenAt: peer.lastSeenAt,
      interactionCount: peer.interactionCount,
    }));

  const blacklist = Object.values(pruned.blacklist)
    .sort((left, right) => {
      const targetDelta =
        (targetPeerIds.has(right.subjectId) ? 1 : 0) - (targetPeerIds.has(left.subjectId) ? 1 : 0);
      if (targetDelta !== 0) {
        return targetDelta;
      }
      return right.listedAt.localeCompare(left.listedAt);
    })
    .slice(0, maxBlacklist);

  const selectedPeerIds = new Set(reputations.map((peer) => peer.peerId));
  const checkpoints = Object.values(pruned.checkpoints)
    .sort((left, right) => {
      const leftPeer = pruned.peers[left.peerId];
      const rightPeer = pruned.peers[right.peerId];
      const leftTargetPriority = targetPeerIds.has(left.peerId) ? 2000 : 0;
      const rightTargetPriority = targetPeerIds.has(right.peerId) ? 2000 : 0;
      const leftPriority =
        leftTargetPriority +
        (selectedPeerIds.has(left.peerId) ? 1000 : 0) +
        (leftPeer ? computePeerRelevance(leftPeer, now, { targetPeerIds }) : 0);
      const rightPriority =
        rightTargetPriority +
        (selectedPeerIds.has(right.peerId) ? 1000 : 0) +
        (rightPeer ? computePeerRelevance(rightPeer, now, { targetPeerIds }) : 0);
      if (rightPriority !== leftPriority) {
        return rightPriority - leftPriority;
      }
      return right.createdAt.localeCompare(left.createdAt);
    })
    .slice(0, maxCheckpoints);

  return {
    issuedAt: now,
    expiresAt: new Date(new Date(now).getTime() + 15 * 60 * 1000).toISOString(),
    reputations,
    blacklist,
    checkpoints,
  };
}

export function ingestGossipEnvelope(
  state: LocalTrustState,
  envelope: GossipEnvelope,
  now = nowIso(),
): LocalTrustState {
  if (!validateGossipEnvelopeFreshness(envelope, now).ok) {
    return state;
  }

  const nextBlacklist = ingestBlacklistDigests(state, envelope.blacklist, now);
  const nextCheckpoints = ingestReputationCheckpoints(nextBlacklist, envelope.checkpoints, now);
  const nextPeers = { ...nextCheckpoints.peers };

  for (const hint of envelope.reputations) {
    const current = nextPeers[hint.peerId];
    if (current && new Date(current.updatedAt).getTime() > new Date(envelope.issuedAt).getTime()) {
      continue;
    }

    nextPeers[hint.peerId] = summarizeHintPeer({
      peerId: hint.peerId,
      trustBand: hint.trustBand,
      trustScore: hint.trustScore,
      blacklistState: hint.blacklistState,
      interactionCount: hint.interactionCount,
      lastSeenAt: hint.lastSeenAt,
      now,
    });
  }

  return {
    ...nextCheckpoints,
    peers: nextPeers,
    updatedAt: now,
  };
}

export function evaluatePeerTrustDecision(
  state: LocalTrustState,
  input: {
    peerIds: string[];
    now?: string;
  },
): TrustDecisionSnapshot {
  const now = input.now ?? nowIso();
  const peerIds = [...new Set(input.peerIds.map((item) => item.trim()).filter(Boolean))];
  if (!peerIds.length) {
    return {
      decision: "allow",
      trustBand: "neutral",
      trustScore: 50,
      riskLevel: "guarded",
      riskScore: 50,
      reasons: ["no-peer-id"],
    };
  }

  for (const peerId of peerIds) {
    const blacklist = state.blacklist[peerId];
    if (blacklist && validateBlacklistDigest(blacklist, now).ok) {
      const summary = state.peers[peerId];
      return {
        peerId,
        decision: "block",
        trustBand: "blocked",
        trustScore: 0,
        riskLevel: "blocked",
        riskScore: 100,
        reasons: ["blacklist-listed"],
        summary,
      };
    }
  }

  const summaries = peerIds
    .map((peerId) => ({ peerId, summary: state.peers[peerId] }))
    .filter((entry): entry is { peerId: string; summary: PeerTrustSummary } => Boolean(entry.summary));

  if (!summaries.length) {
    return {
      peerId: peerIds[0],
      decision: "allow",
      trustBand: "neutral",
      trustScore: 50,
      riskLevel: "guarded",
      riskScore: 50,
      reasons: ["no-local-signal"],
    };
  }

  const ranked = summaries.sort((left, right) => {
    const riskLeft = evaluateLocalPeerRisk({
      peer: left.summary,
      now,
    });
    const riskRight = evaluateLocalPeerRisk({
      peer: right.summary,
      now,
    });
    const severityLeft = localRiskSeverity(riskLeft.riskLevel);
    const severityRight = localRiskSeverity(riskRight.riskLevel);
    if (severityLeft !== severityRight) {
      return severityRight - severityLeft;
    }
    if (riskLeft.riskScore !== riskRight.riskScore) {
      return riskRight.riskScore - riskLeft.riskScore;
    }
    if (left.summary.failedSettlements !== right.summary.failedSettlements) {
      return right.summary.failedSettlements - left.summary.failedSettlements;
    }
    return left.summary.trustScore - right.summary.trustScore;
  });

  const selected = ranked[0];
  const localRisk = evaluateLocalPeerRisk({
    peer: selected.summary,
    now,
  });
  const operationalSignal = classifyOperationalTrustSignal({
    peer: selected.summary,
    now,
  });
  if (localRisk.riskLevel === "blocked" || localRisk.riskLevel === "high") {
    return {
      peerId: selected.peerId,
      decision: "block",
      trustBand: selected.summary.trustBand,
      trustScore: selected.summary.trustScore,
      riskLevel: localRisk.riskLevel,
      riskScore: localRisk.riskScore,
      reasons:
        selected.summary.blacklistState === "listed" || selected.summary.trustBand === "blocked"
          ? ["peer-blocked"]
          : operationalSignal === "risky" || localRisk.sessionQuality === "fragile"
            ? ["session-instability", "fresh-risk"]
            : selected.summary.pendingClaims > 0
              ? ["pending-claims", "low-trust-score"]
              : selected.summary.failedSettlements > 0
                ? ["recent-failures", "low-trust-score"]
                : ["low-trust-score"],
      summary: selected.summary,
    };
  }

  if (localRisk.riskLevel === "guarded") {
    return {
      peerId: selected.peerId,
      decision: "warn",
      trustBand: selected.summary.trustBand,
      trustScore: selected.summary.trustScore,
      riskLevel: localRisk.riskLevel,
      riskScore: localRisk.riskScore,
      reasons:
        operationalSignal === "pending"
          ? ["pending-claims"]
          : operationalSignal === "recovering" || localRisk.sessionQuality === "mixed"
            ? ["incomplete-sessions", "recovery-window"]
            : selected.summary.trustBand === "watch"
              ? ["watch-band"]
              : ["low-trust-score"],
      summary: selected.summary,
    };
  }

  return {
    peerId: selected.peerId,
    decision: "allow",
    trustBand: selected.summary.trustBand,
    trustScore: selected.summary.trustScore,
    riskLevel: localRisk.riskLevel,
    riskScore: localRisk.riskScore,
    reasons: ["trusted-local-history"],
    summary: selected.summary,
  };
}

export function buildTrustCacheSummary(
  state: LocalTrustState,
  options: {
    now?: string;
    recentLimit?: number;
  } = {},
): TrustCacheSummary {
  const now = options.now ?? nowIso();
  const recentLimit = options.recentLimit ?? 3;
  const pruned = pruneTrustState(state, { now });
  const peers = Object.values(pruned.peers).sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));

  return {
    hotPeers: peers.filter((peer) => peer.cacheTier === "hot").length,
    warmPeers: peers.filter((peer) => peer.cacheTier === "warm").length,
    coldPeers: peers.filter((peer) => peer.cacheTier === "cold").length,
    freshPeers: peers.filter((peer) => classifyEncounterRecency({ lastSeenAt: peer.lastSeenAt, now }) === "fresh").length,
    recentPeersCount: peers.filter((peer) => classifyEncounterRecency({ lastSeenAt: peer.lastSeenAt, now }) === "recent").length,
    stalePeers: peers.filter((peer) => classifyEncounterRecency({ lastSeenAt: peer.lastSeenAt, now }) === "stale").length,
    pendingPeers: peers.filter((peer) => classifyOperationalTrustSignal({ peer, now }) === "pending").length,
    recoveringPeers: peers.filter((peer) => classifyOperationalTrustSignal({ peer, now }) === "recovering").length,
    riskyPeers: peers.filter((peer) => classifyOperationalTrustSignal({ peer, now }) === "risky").length,
    lowRiskPeers: peers.filter((peer) => evaluateLocalPeerRisk({ peer, now }).riskLevel === "low").length,
    guardedRiskPeers: peers.filter((peer) => evaluateLocalPeerRisk({ peer, now }).riskLevel === "guarded").length,
    highRiskPeers: peers.filter((peer) => evaluateLocalPeerRisk({ peer, now }).riskLevel === "high").length,
    blockedRiskPeers: peers.filter((peer) => evaluateLocalPeerRisk({ peer, now }).riskLevel === "blocked").length,
    verifiedPeers: peers.filter((peer) => classifySessionQuality({ peer }) === "verified").length,
    mixedPeers: peers.filter((peer) => classifySessionQuality({ peer }) === "mixed").length,
    fragilePeers: peers.filter((peer) => classifySessionQuality({ peer }) === "fragile").length,
    unknownPeers: peers.filter((peer) => classifySessionQuality({ peer }) === "unknown").length,
    blacklistedPeers: Object.keys(pruned.blacklist).length,
    checkpoints: Object.keys(pruned.checkpoints).length,
    trustedPeers: peers.filter((peer) => peer.trustBand === "trusted").length,
    watchPeers: peers.filter((peer) => peer.trustBand === "watch").length,
    blockedPeers: peers.filter((peer) => peer.trustBand === "blocked").length,
    updatedAt: pruned.updatedAt,
    recentPeers: peers.slice(0, recentLimit).map((peer) => ({
      ...peer,
      encounterRecency: classifyEncounterRecency({ lastSeenAt: peer.lastSeenAt, now }),
      operationalSignal: classifyOperationalTrustSignal({ peer, now }),
      sessionQuality: classifySessionQuality({ peer }),
      riskLevel: evaluateLocalPeerRisk({ peer, now }).riskLevel,
      riskScore: evaluateLocalPeerRisk({ peer, now }).riskScore,
    })),
  };
}

export function findPeerTrustPreview(
  state: LocalTrustState,
  input: {
    peerHint: string;
    now?: string;
  },
): PeerTrustPreview | null {
  const hint = input.peerHint.trim().toLowerCase();
  if (hint.length < 4) {
    return null;
  }

  const peers = Object.values(state.peers);
  const matched = peers.filter((peer) => {
    const peerId = peer.peerId.toLowerCase();
    return peerId === hint || (hint.length >= 6 && peerId.startsWith(hint));
  });

  if (!matched.length) {
    return null;
  }

  const selected = matched.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
  const decision = evaluatePeerTrustDecision(state, {
    peerIds: [selected.peerId],
    now: input.now,
  });

  return {
    peerId: selected.peerId,
    decision: decision.decision,
    trustBand: decision.trustBand,
    trustScore: decision.trustScore,
    riskLevel: decision.riskLevel,
    riskScore: decision.riskScore,
    reasons: decision.reasons,
    summary: selected,
  };
}

export async function loadLocalTrustState(): Promise<LocalTrustState> {
  const raw = await AsyncStorage.getItem(TRUST_STORAGE_KEY);
  if (!raw) {
    return createEmptyTrustState();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LocalTrustState>;
    const now = parsed.updatedAt ?? nowIso();
    const blacklist = Object.fromEntries(
      Object.entries(parsed.blacklist ?? {}).filter(([, entry]) =>
        validateBlacklistDigest(entry as BlacklistDigest, now).ok,
      ),
    ) as Record<string, BlacklistDigest>;
    const interactions = Object.fromEntries(
      Object.entries(parsed.interactions ?? {}).map(([peerId, stats]) => [
        peerId,
        normalizeInteractionStats(peerId, stats as Partial<PeerInteractionStats>, now),
      ]),
    );
    const peerIds = new Set([...Object.keys(parsed.peers ?? {}), ...Object.keys(interactions)]);
    const peers = Object.fromEntries(
      [...peerIds].map((peerId) => [
        peerId,
        normalizePeerSummary(
          peerId,
          (parsed.peers ?? {})[peerId] as Partial<PeerTrustSummary> | undefined,
          blacklist[peerId],
          interactions[peerId],
          now,
        ),
      ]),
    );
    return {
      peers,
      interactions,
      blacklist,
      checkpoints: parsed.checkpoints ?? {},
      updatedAt: now,
    };
  } catch {
    return createEmptyTrustState();
  }
}

export async function saveLocalTrustState(state: LocalTrustState): Promise<void> {
  await AsyncStorage.setItem(TRUST_STORAGE_KEY, JSON.stringify(state));
}

export async function mutateLocalTrustState(
  mutator: (state: LocalTrustState) => LocalTrustState | Promise<LocalTrustState>,
): Promise<LocalTrustState> {
  const current = await loadLocalTrustState();
  const next = await mutator(current);
  const pruned = pruneTrustState(next);
  await saveLocalTrustState(pruned);
  return pruned;
}
