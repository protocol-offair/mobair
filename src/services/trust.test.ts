import { describe, expect, it } from "vitest";

import {
  buildBlacklistSignatureDigest,
  buildTrustCacheSummary,
  buildSelectiveGossipEnvelope,
  classifyEncounterRecency,
  classifyOperationalTrustSignal,
  classifyTrustCacheTier,
  computeTrustScore,
  createEmptyTrustState,
  evaluateLocalPeerRisk,
  evaluatePeerTrustDecision,
  ingestGossipEnvelope,
  ingestBlacklistDigests,
  ingestReputationCheckpoints,
  pruneTrustState,
  recordPeerInteraction,
  validateBlacklistDigest,
  validateGossipEnvelopeFreshness,
  type BlacklistDigest,
} from "./trust";

function blacklistDigest(entry: Omit<BlacklistDigest, "signatureDigest">): BlacklistDigest {
  return {
    ...entry,
    signatureDigest: buildBlacklistSignatureDigest(entry),
  };
}

describe("trust", () => {
  it("classifies hot, warm, and cold cache tiers", () => {
    expect(
      classifyTrustCacheTier({
        totalInteractions: 6,
        lastSeenAt: "2026-04-14T10:00:00.000Z",
        now: "2026-04-15T10:00:00.000Z",
      }),
    ).toBe("hot");

    expect(
      classifyTrustCacheTier({
        totalInteractions: 3,
        lastSeenAt: "2026-04-01T10:00:00.000Z",
        now: "2026-04-15T10:00:00.000Z",
      }),
    ).toBe("warm");

    expect(
      classifyTrustCacheTier({
        totalInteractions: 1,
        lastSeenAt: "2026-01-01T10:00:00.000Z",
        now: "2026-04-15T10:00:00.000Z",
      }),
    ).toBe("cold");
  });

  it("classifies fresh, recent, stale, and cold encounters", () => {
    expect(
      classifyEncounterRecency({
        lastSeenAt: "2026-04-15T07:00:00.000Z",
        now: "2026-04-15T10:00:00.000Z",
      }),
    ).toBe("fresh");

    expect(
      classifyEncounterRecency({
        lastSeenAt: "2026-04-14T10:00:00.000Z",
        now: "2026-04-15T10:00:00.000Z",
      }),
    ).toBe("recent");

    expect(
      classifyEncounterRecency({
        lastSeenAt: "2026-04-01T10:00:00.000Z",
        now: "2026-04-15T10:00:00.000Z",
      }),
    ).toBe("stale");

    expect(
      classifyEncounterRecency({
        lastSeenAt: "2026-01-01T10:00:00.000Z",
        now: "2026-04-15T10:00:00.000Z",
      }),
    ).toBe("cold");
  });

  it("classifies operational trust signals", () => {
    expect(
      classifyOperationalTrustSignal({
        peer: {
          peerId: "peer-stable",
          cacheTier: "hot",
          trustBand: "trusted",
          trustScore: 90,
          blacklistState: "clear",
          interactionCount: 6,
          encounterCount: 2,
          handshakeAcceptedCount: 1,
          receiptPublishedCount: 1,
          sessionCloseCount: 1,
          cleanCloseCount: 1,
          successfulSettlements: 4,
          failedSettlements: 0,
          pendingClaims: 0,
          totalAmount: 50,
          firstSeenAt: "2026-04-14T08:00:00.000Z",
          lastSeenAt: "2026-04-15T08:00:00.000Z",
          updatedAt: "2026-04-15T08:00:00.000Z",
        },
        now: "2026-04-15T10:00:00.000Z",
      }),
    ).toBe("stable");

    expect(
      classifyOperationalTrustSignal({
        peer: {
          peerId: "peer-pending",
          cacheTier: "warm",
          trustBand: "neutral",
          trustScore: 58,
          blacklistState: "clear",
          interactionCount: 3,
          encounterCount: 1,
          handshakeAcceptedCount: 1,
          receiptPublishedCount: 1,
          sessionCloseCount: 1,
          cleanCloseCount: 1,
          successfulSettlements: 1,
          failedSettlements: 0,
          pendingClaims: 2,
          totalAmount: 20,
          firstSeenAt: "2026-04-14T08:00:00.000Z",
          lastSeenAt: "2026-04-15T08:00:00.000Z",
          updatedAt: "2026-04-15T08:00:00.000Z",
        },
        now: "2026-04-15T10:00:00.000Z",
      }),
    ).toBe("pending");

    expect(
      classifyOperationalTrustSignal({
        peer: {
          peerId: "peer-recovering",
          cacheTier: "warm",
          trustBand: "neutral",
          trustScore: 58,
          blacklistState: "clear",
          interactionCount: 4,
          encounterCount: 2,
          handshakeAcceptedCount: 2,
          receiptPublishedCount: 1,
          sessionCloseCount: 2,
          cleanCloseCount: 1,
          successfulSettlements: 2,
          failedSettlements: 1,
          pendingClaims: 0,
          totalAmount: 20,
          firstSeenAt: "2026-03-01T08:00:00.000Z",
          lastSeenAt: "2026-03-20T08:00:00.000Z",
          updatedAt: "2026-03-20T08:00:00.000Z",
        },
        now: "2026-04-15T10:00:00.000Z",
      }),
    ).toBe("recovering");

    expect(
      classifyOperationalTrustSignal({
        peer: {
          peerId: "peer-risky",
          cacheTier: "warm",
          trustBand: "watch",
          trustScore: 20,
          blacklistState: "clear",
          interactionCount: 2,
          encounterCount: 2,
          handshakeAcceptedCount: 3,
          receiptPublishedCount: 0,
          sessionCloseCount: 3,
          cleanCloseCount: 0,
          successfulSettlements: 0,
          failedSettlements: 1,
          pendingClaims: 0,
          totalAmount: 10,
          firstSeenAt: "2026-04-14T08:00:00.000Z",
          lastSeenAt: "2026-04-15T08:00:00.000Z",
          updatedAt: "2026-04-15T08:00:00.000Z",
        },
        now: "2026-04-15T10:00:00.000Z",
      }),
    ).toBe("risky");
  });

  it("classifies consolidated local risk for a stable peer", () => {
    const risk = evaluateLocalPeerRisk({
      peer: {
        peerId: "peer-stable",
        cacheTier: "hot",
        trustBand: "trusted",
        trustScore: 90,
        blacklistState: "clear",
        interactionCount: 6,
        encounterCount: 2,
        handshakeAcceptedCount: 1,
        receiptPublishedCount: 1,
        sessionCloseCount: 1,
        cleanCloseCount: 1,
        successfulSettlements: 4,
        failedSettlements: 0,
        pendingClaims: 0,
        totalAmount: 50,
        firstSeenAt: "2026-04-14T08:00:00.000Z",
        lastSeenAt: "2026-04-15T08:00:00.000Z",
        updatedAt: "2026-04-15T08:00:00.000Z",
      },
      now: "2026-04-15T10:00:00.000Z",
    });

    expect(risk.riskLevel).toBe("low");
    expect(risk.riskScore).toBeLessThan(30);
    expect(risk.operationalSignal).toBe("stable");
    expect(risk.sessionQuality).toBe("verified");
  });

  it("classifies blocked local risk for a blacklisted peer", () => {
    const risk = evaluateLocalPeerRisk({
      peer: {
        peerId: "peer-blocked",
        cacheTier: "warm",
        trustBand: "blocked",
        trustScore: 0,
        blacklistState: "listed",
        interactionCount: 2,
        encounterCount: 1,
        handshakeAcceptedCount: 1,
        receiptPublishedCount: 0,
        sessionCloseCount: 1,
        cleanCloseCount: 0,
        successfulSettlements: 0,
        failedSettlements: 1,
        pendingClaims: 1,
        totalAmount: 10,
        firstSeenAt: "2026-04-14T08:00:00.000Z",
        lastSeenAt: "2026-04-15T08:00:00.000Z",
        updatedAt: "2026-04-15T08:00:00.000Z",
      },
      now: "2026-04-15T10:00:00.000Z",
    });

    expect(risk.riskLevel).toBe("blocked");
    expect(risk.riskScore).toBe(100);
  });

  it("builds trust score from local interactions", () => {
    let state = createEmptyTrustState("2026-04-14T10:00:00.000Z");
    state = recordPeerInteraction(state, {
      peerId: "peer-a",
      kind: "received",
      amount: 20,
      occurredAt: "2026-04-14T10:00:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-a",
      kind: "settled",
      amount: 20,
      occurredAt: "2026-04-14T10:03:00.000Z",
    });

    const peer = state.peers["peer-a"];
    expect(peer).toBeDefined();
    expect(peer.trustBand).toBe("trusted");
    expect(peer.trustScore).toBeGreaterThan(75);

    const direct = computeTrustScore({
      interactions: state.interactions["peer-a"],
      now: "2026-04-14T10:05:00.000Z",
    });
    expect(direct.blacklistState).toBe("clear");
  });

  it("blacklist entries force blocked trust and gossip selection respects ttl", () => {
    let state = createEmptyTrustState("2026-04-14T10:00:00.000Z");
    state = recordPeerInteraction(state, {
      peerId: "peer-b",
      kind: "claimed",
      occurredAt: "2026-04-14T10:00:00.000Z",
    });
    state = ingestBlacklistDigests(
      state,
      [
        blacklistDigest({
          subjectId: "peer-b",
          sourceAuthority: "mainwallet",
          listedAt: "2026-04-14T10:01:00.000Z",
          ttlSeconds: 3600,
        }),
      ],
      "2026-04-14T10:02:00.000Z",
    );

    expect(state.peers["peer-b"].trustBand).toBe("blocked");
    const envelope = buildSelectiveGossipEnvelope(state, {
      now: "2026-04-14T10:05:00.000Z",
      maxPeers: 10,
      maxBlacklist: 10,
      maxCheckpoints: 10,
    });
    expect(envelope.blacklist).toHaveLength(1);
    expect(envelope.reputations[0]?.blacklistState).toBe("listed");
  });

  it("filters expired checkpoints from the gossip envelope", () => {
    let state = createEmptyTrustState("2026-04-14T10:00:00.000Z");
    state = ingestReputationCheckpoints(
      state,
      [
        {
          peerId: "peer-a",
          checkpointHash: "cp-live",
          rootHash: "root-live",
          createdAt: "2026-04-14T09:55:00.000Z",
          ttlSeconds: 3600,
        },
        {
          peerId: "peer-b",
          checkpointHash: "cp-expired",
          rootHash: "root-expired",
          createdAt: "2026-04-14T08:00:00.000Z",
          ttlSeconds: 60,
        },
      ],
      "2026-04-14T10:00:00.000Z",
    );

    const envelope = buildSelectiveGossipEnvelope(state, {
      now: "2026-04-14T10:10:00.000Z",
    });
    expect(envelope.checkpoints.map((item) => item.checkpointHash)).toEqual(["cp-live"]);
  });

  it("ingests gossip envelopes and builds trust cache summaries", () => {
    const state = ingestGossipEnvelope(
      createEmptyTrustState("2026-04-14T10:00:00.000Z"),
      {
        issuedAt: "2026-04-14T10:01:00.000Z",
        expiresAt: "2026-04-14T10:16:00.000Z",
        reputations: [
          {
            peerId: "peer-hot",
            trustBand: "trusted",
            trustScore: 81,
            blacklistState: "clear",
            lastSeenAt: "2026-04-14T10:00:00.000Z",
            interactionCount: 6,
          },
          {
            peerId: "peer-watch",
            trustBand: "watch",
            trustScore: 22,
            blacklistState: "clear",
            lastSeenAt: "2026-04-13T10:00:00.000Z",
            interactionCount: 3,
          },
        ],
        blacklist: [],
        checkpoints: [
          {
            peerId: "peer-hot",
            checkpointHash: "cp-hot",
            rootHash: "root-hot",
            createdAt: "2026-04-14T10:00:00.000Z",
            ttlSeconds: 3600,
          },
        ],
      },
      "2026-04-14T10:02:00.000Z",
    );

    const summary = buildTrustCacheSummary(state, {
      now: "2026-04-14T10:02:00.000Z",
    });
    expect(summary.hotPeers).toBe(1);
    expect(summary.warmPeers).toBe(1);
    expect(summary.checkpoints).toBe(1);
    expect(summary.trustedPeers).toBe(1);
    expect(summary.watchPeers).toBe(1);
    expect(summary.lowRiskPeers).toBe(1);
    expect(summary.highRiskPeers).toBe(1);
    expect(summary.recentPeers.map((peer) => peer.peerId)).toEqual(["peer-hot", "peer-watch"]);
  });

  it("rejects expired gossip envelopes before applying reputation hints", () => {
    const envelope = {
      issuedAt: "2026-04-14T10:01:00.000Z",
      expiresAt: "2026-04-14T10:02:00.000Z",
      reputations: [
        {
          peerId: "peer-stale",
          trustBand: "trusted" as const,
          trustScore: 99,
          blacklistState: "clear" as const,
          lastSeenAt: "2026-04-14T10:00:00.000Z",
          interactionCount: 12,
        },
      ],
      blacklist: [],
      checkpoints: [],
    };

    expect(validateGossipEnvelopeFreshness(envelope, "2026-04-14T10:03:00.000Z").ok).toBe(false);
    const state = ingestGossipEnvelope(
      createEmptyTrustState("2026-04-14T10:00:00.000Z"),
      envelope,
      "2026-04-14T10:03:00.000Z",
    );

    expect(state.peers["peer-stale"]).toBeUndefined();
  });

  it("rejects forged blacklist digests from gossip", () => {
    const forged = {
      subjectId: "peer-forged",
      sourceAuthority: "mainwallet",
      signatureDigest: "sig-forged",
      listedAt: "2026-04-14T10:00:30.000Z",
      ttlSeconds: 3600,
    };

    expect(validateBlacklistDigest(forged, "2026-04-14T10:01:00.000Z").ok).toBe(false);
    const state = ingestGossipEnvelope(
      createEmptyTrustState("2026-04-14T10:00:00.000Z"),
      {
        issuedAt: "2026-04-14T10:01:00.000Z",
        expiresAt: "2026-04-14T10:16:00.000Z",
        reputations: [],
        blacklist: [forged],
        checkpoints: [],
      },
      "2026-04-14T10:02:00.000Z",
    );

    expect(state.blacklist["peer-forged"]).toBeUndefined();
  });

  it("evaluates local trust decisions conservatively", () => {
    let state = createEmptyTrustState("2026-04-14T10:00:00.000Z");
    state = ingestGossipEnvelope(
      state,
      {
        issuedAt: "2026-04-14T10:01:00.000Z",
        expiresAt: "2026-04-14T10:16:00.000Z",
        reputations: [
          {
            peerId: "peer-trusted",
            trustBand: "trusted",
            trustScore: 80,
            blacklistState: "clear",
            lastSeenAt: "2026-04-14T10:00:00.000Z",
            interactionCount: 6,
          },
          {
            peerId: "peer-watch",
            trustBand: "watch",
            trustScore: 28,
            blacklistState: "clear",
            lastSeenAt: "2026-04-14T09:40:00.000Z",
            interactionCount: 2,
          },
        ],
        blacklist: [
          blacklistDigest({
            subjectId: "peer-blocked",
            sourceAuthority: "mainwallet",
            listedAt: "2026-04-14T10:00:30.000Z",
            ttlSeconds: 3600,
          }),
        ],
        checkpoints: [],
      },
      "2026-04-14T10:02:00.000Z",
    );

    expect(
      evaluatePeerTrustDecision(state, {
        peerIds: ["peer-trusted"],
        now: "2026-04-14T10:02:00.000Z",
      }).decision,
    ).toBe("allow");
    expect(
      evaluatePeerTrustDecision(state, {
        peerIds: ["peer-watch"],
        now: "2026-04-14T10:02:00.000Z",
      }).decision,
    ).toBe("warn");
    expect(
      evaluatePeerTrustDecision(state, {
        peerIds: ["peer-blocked"],
        now: "2026-04-14T10:02:00.000Z",
      }).decision,
    ).toBe("block");
  });

  it("warns for peers with pending operational exposure", () => {
    let state = createEmptyTrustState("2026-04-14T10:00:00.000Z");
    state = recordPeerInteraction(state, {
      peerId: "peer-pending",
      kind: "claimed",
      amount: 20,
      occurredAt: "2026-04-14T10:00:00.000Z",
    });

    const decision = evaluatePeerTrustDecision(state, {
      peerIds: ["peer-pending"],
      now: "2026-04-14T10:05:00.000Z",
    });

    expect(decision.decision).toBe("warn");
    expect(decision.reasons).toContain("pending-claims");
  });

  it("warns for peers with incomplete recent sessions", () => {
    let state = createEmptyTrustState("2026-04-14T10:00:00.000Z");
    state = recordPeerInteraction(state, {
      peerId: "peer-recovering-session",
      kind: "encountered",
      occurredAt: "2026-04-14T10:00:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-recovering-session",
      kind: "handshake-accepted",
      occurredAt: "2026-04-14T10:01:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-recovering-session",
      kind: "closed",
      occurredAt: "2026-04-14T10:02:00.000Z",
    });

    const decision = evaluatePeerTrustDecision(state, {
      peerIds: ["peer-recovering-session"],
      now: "2026-04-14T10:05:00.000Z",
    });

    expect(decision.decision).toBe("warn");
    expect(decision.riskLevel).toBe("guarded");
    expect(decision.reasons).toContain("incomplete-sessions");
  });

  it("blocks high local risk even when trust band is not blocked", () => {
    let state = createEmptyTrustState("2026-04-14T10:00:00.000Z");
    state = recordPeerInteraction(state, {
      peerId: "peer-high-risk",
      kind: "claimed",
      amount: 40,
      occurredAt: "2026-04-14T10:00:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-high-risk",
      kind: "rejected",
      amount: 40,
      occurredAt: "2026-04-14T10:05:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-high-risk",
      kind: "encountered",
      occurredAt: "2026-04-14T10:06:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-high-risk",
      kind: "handshake-accepted",
      occurredAt: "2026-04-14T10:07:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-high-risk",
      kind: "closed",
      occurredAt: "2026-04-14T10:08:00.000Z",
    });

    const decision = evaluatePeerTrustDecision(state, {
      peerIds: ["peer-high-risk"],
      now: "2026-04-14T10:10:00.000Z",
    });

    expect(decision.trustBand).not.toBe("blocked");
    expect(["high", "blocked"]).toContain(decision.riskLevel);
    expect(decision.decision).toBe("block");
  });

  it("blocks peers with unstable session quality", () => {
    let state = createEmptyTrustState("2026-04-14T10:00:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      state = recordPeerInteraction(state, {
        peerId: "peer-unstable-session",
        kind: "encountered",
        occurredAt: `2026-04-14T10:0${index}:00.000Z`,
      });
      state = recordPeerInteraction(state, {
        peerId: "peer-unstable-session",
        kind: "handshake-accepted",
        occurredAt: `2026-04-14T10:0${index}:10.000Z`,
      });
      state = recordPeerInteraction(state, {
        peerId: "peer-unstable-session",
        kind: "closed",
        occurredAt: `2026-04-14T10:0${index}:20.000Z`,
      });
    }

    const decision = evaluatePeerTrustDecision(state, {
      peerIds: ["peer-unstable-session"],
      now: "2026-04-14T10:10:00.000Z",
    });

    expect(decision.decision).toBe("block");
    expect(decision.reasons).toContain("session-instability");
  });

  it("keeps high-risk cold peers when pruning the cache", () => {
    let state = createEmptyTrustState("2026-04-01T10:00:00.000Z");
    state = recordPeerInteraction(state, {
      peerId: "peer-risky",
      kind: "claimed",
      amount: 25,
      occurredAt: "2026-04-01T10:00:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-risky",
      kind: "rejected",
      amount: 25,
      occurredAt: "2026-04-01T10:02:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-neutral",
      kind: "received",
      amount: 10,
      occurredAt: "2026-04-02T10:00:00.000Z",
    });

    const pruned = pruneTrustState(state, {
      now: "2026-05-20T10:00:00.000Z",
      maxColdPeers: 1,
    });

    expect(Object.keys(pruned.peers)).toEqual(["peer-risky"]);
    expect(pruned.peers["peer-risky"]?.trustBand).toBe("watch");
  });

  it("prioritizes risky or pending peers inside selective gossip", () => {
    let state = createEmptyTrustState("2026-04-14T10:00:00.000Z");
    state = recordPeerInteraction(state, {
      peerId: "peer-pending",
      kind: "claimed",
      amount: 40,
      occurredAt: "2026-04-14T10:00:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-trusted",
      kind: "received",
      amount: 15,
      occurredAt: "2026-04-14T10:05:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-trusted",
      kind: "settled",
      amount: 15,
      occurredAt: "2026-04-14T10:08:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-cold",
      kind: "received",
      amount: 5,
      occurredAt: "2026-03-01T10:00:00.000Z",
    });

    const envelope = buildSelectiveGossipEnvelope(state, {
      now: "2026-04-15T10:00:00.000Z",
      maxPeers: 2,
    });

    expect(envelope.reputations.map((item) => item.peerId)).toContain("peer-pending");
    expect(envelope.reputations.map((item) => item.peerId)).toContain("peer-trusted");
    expect(envelope.reputations.map((item) => item.peerId)).not.toContain("peer-cold");
  });

  it("prioritizes the current session peer inside selective gossip", () => {
    let state = createEmptyTrustState("2026-04-14T10:00:00.000Z");
    state = recordPeerInteraction(state, {
      peerId: "peer-very-hot",
      kind: "received",
      amount: 30,
      occurredAt: "2026-04-14T10:00:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-very-hot",
      kind: "settled",
      amount: 30,
      occurredAt: "2026-04-14T10:03:00.000Z",
    });
    state = recordPeerInteraction(state, {
      peerId: "peer-target",
      kind: "received",
      amount: 5,
      occurredAt: "2026-04-10T10:00:00.000Z",
    });
    state = ingestReputationCheckpoints(
      state,
      [
        {
          peerId: "peer-target",
          checkpointHash: "cp-target",
          rootHash: "root-target",
          createdAt: "2026-04-14T09:55:00.000Z",
          ttlSeconds: 3600,
        },
      ],
      "2026-04-14T10:04:00.000Z",
    );

    const envelope = buildSelectiveGossipEnvelope(state, {
      now: "2026-04-14T10:10:00.000Z",
      maxPeers: 1,
      maxCheckpoints: 1,
      targetPeerIds: ["peer-target"],
    });

    expect(envelope.reputations.map((item) => item.peerId)).toEqual(["peer-target"]);
    expect(envelope.checkpoints.map((item) => item.checkpointHash)).toEqual(["cp-target"]);
  });
});
