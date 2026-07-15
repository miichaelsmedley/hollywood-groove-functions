import * as admin from "firebase-admin";
import { onValueWritten, DataSnapshot, DatabaseEvent } from "firebase-functions/v2/database";
import { Change } from "firebase-functions/common";
import { logger } from "firebase-functions/v2";
import { rebuildScoresLeaderboard, scheduleDebouncedLeaderboardRebuild } from "./leaderboardDebounce";
import { isDanceClaimResponse, type DanceClaimResponseContract } from "./responseContracts";
import { applySetScoreDelta, resolveSetNumberForScore } from "./setScoring";

type DanceClaimResponse = DanceClaimResponseContract;

type ShowSettings = {
  dancing_mode?: "per_song" | "interval" | "activity" | "disabled";
  dancing_cooldown_minutes?: number;
  dancing_floor?: number;
  dancing_cap?: number;
};

type AttendeeRecord = {
  last_dance_claim?: number;
  dance_claim_count?: number;
  display_name?: string;
  tier_at_checkin?: string;
  total_score?: number;
  breakdown?: {
    dancing?: number;
    trivia?: number;
    participation?: number;
    starting_bonus?: number;
  };
};

type LiveActivity = {
  activityId?: string | null;
  type?: string | null;
  status?: string | null;
  startedAt?: number | null;
};

type PublicActivity = {
  setNumber?: number | null;
};

function numberOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

function intOrDefault(value: unknown, defaultValue: number): number {
  const asNumber = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(asNumber)) return defaultValue;
  return Math.trunc(asNumber);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function normalizeNamespacePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed;
}

function namespaceRoot(prefix: string): string {
  const normalized = normalizeNamespacePrefix(prefix);
  return normalized.length > 0 ? `/${normalized}` : "";
}

type DancingScoringParams = { showId: string; activityId: string; odience: string };

function makeDancingScoring(namespacePrefix: string) {
  const normalizedPrefix = normalizeNamespacePrefix(namespacePrefix);
  const root = namespaceRoot(normalizedPrefix);

  const showPath = (showId: string, path: string): string => {
    const trimmed = path.replace(/^\/+/, "");
    return `${root}/shows/${showId}/${trimmed}`;
  };

  return onValueWritten(
    { ref: `${root}/shows/{showId}/responses/{activityId}/{odience}`, region: "asia-southeast1" },
    async (event: DatabaseEvent<Change<DataSnapshot>, DancingScoringParams>) => {
      const { showId, activityId, odience } = event.params;
      const change = event.data;

      if (!change.after.exists()) {
        return null;
      }

      const rawResponse = change.after.val();
      if (!isDanceClaimResponse(rawResponse)) {
        return null;
      }
      const response = rawResponse as DanceClaimResponse;

      const claimedAt = numberOrDefault(response.claimedAt, Date.now());
      if (change.before.exists()) {
        const before = change.before.val() as DanceClaimResponse | null;
        const previousClaimedAt = numberOrDefault(before?.claimedAt, 0);
        if (claimedAt <= previousClaimedAt) {
          return null;
        }
      }

      const database = admin.database();

      const [settingsSnap, attendeeSnap, scoresSnap, liveActivitySnap, activitySnap] = await Promise.all([
        database.ref(showPath(showId, "settings")).get(),
        database.ref(showPath(showId, `attendees/${odience}`)).get(),
        database.ref(showPath(showId, "scores")).get(),
        database.ref(showPath(showId, "live/activity")).get(),
        database.ref(showPath(showId, `activities/${activityId}`)).get(),
      ]);

      const settings = settingsSnap.val() as ShowSettings | null;
      const attendee = attendeeSnap.val() as AttendeeRecord | null;
      const liveActivity = liveActivitySnap.val() as LiveActivity | null;
      const publicActivity = activitySnap.val() as PublicActivity | null;

      const mode = settings?.dancing_mode ?? "per_song";
      if (mode === "disabled") {
        return null;
      }

      const isLiveDancing =
        liveActivity?.status === "active" && liveActivity?.type === "dancing";

      if (mode === "per_song" || mode === "activity") {
        if (!isLiveDancing) {
          return null;
        }
        if (liveActivity?.activityId && liveActivity.activityId !== activityId) {
          return null;
        }
        const liveStartedAt = numberOrDefault(liveActivity?.startedAt, 0);
        const lastDanceClaim = numberOrDefault(attendee?.last_dance_claim, 0);
        if (liveStartedAt > 0 && lastDanceClaim >= liveStartedAt) {
          return null;
        }
      }

      if (mode === "interval") {
        const cooldownMinutes = numberOrDefault(settings?.dancing_cooldown_minutes, 5);
        const cooldownMs = Math.max(0, cooldownMinutes) * 60 * 1000;
        const lastDanceClaim = numberOrDefault(attendee?.last_dance_claim, 0);
        if (lastDanceClaim > 0 && claimedAt - lastDanceClaim < cooldownMs) {
          return null;
        }
      }

      const scoresValue = (scoresSnap.val() as Record<string, any> | null) ?? {};
      const scoreList = Object.values(scoresValue)
        .map((entry) => numberOrDefault((entry as any)?.totalScore, 0))
        .filter((value) => Number.isFinite(value));

      const rawMedian = median(scoreList);
      const floor = numberOrDefault(settings?.dancing_floor, 50);
      const cap = numberOrDefault(settings?.dancing_cap, 200);
      const minPoints = Math.min(floor, cap);
      const maxPoints = Math.max(floor, cap);
      const awardedPoints = clamp(Math.floor(rawMedian), minPoints, maxPoints);

      const displayName = response.displayName ?? attendee?.display_name ?? "Guest";
      const tier = attendee?.tier_at_checkin ?? null;

      await database.ref(showPath(showId, `attendees/${odience}`)).transaction((current) => {
        const existing = (current ?? {}) as AttendeeRecord;
        const lastClaim = numberOrDefault(existing.last_dance_claim, 0);
        if (claimedAt <= lastClaim) {
          return existing;
        }

        const totalScore = intOrDefault(existing.total_score, 0);
        const breakdown = (existing.breakdown ?? {}) as NonNullable<AttendeeRecord["breakdown"]>;
        const dancingBreakdown = intOrDefault(breakdown.dancing, 0);

        return {
          ...existing,
          last_dance_claim: claimedAt,
          dance_claim_count: intOrDefault(existing.dance_claim_count, 0) + 1,
          total_score: totalScore + awardedPoints,
          breakdown: {
            ...breakdown,
            dancing: dancingBreakdown + awardedPoints,
          },
        };
      });

      await database.ref(showPath(showId, `scores/${odience}`)).transaction((current) => {
        const existing = (current ?? {}) as Record<string, any>;
        const existingTotal = intOrDefault(existing.totalScore, 0);
        const nextTotal = existingTotal + awardedPoints;

        const breakdown = (existing.breakdown ?? {}) as Record<string, any>;
        const dancingBreakdown = intOrDefault(breakdown.dancing, 0);

        return {
          ...existing,
          displayName: existing.displayName ?? displayName,
          tier: existing.tier ?? tier,
          totalScore: nextTotal,
          breakdown: {
            ...breakdown,
            dancing: dancingBreakdown + awardedPoints,
          },
          lastAnsweredAt: claimedAt,
          scoreReachedAt: nextTotal > existingTotal ? claimedAt : existing.scoreReachedAt ?? null,
        };
      });

      if (isLiveDancing) {
        await database.ref(showPath(showId, "live/activity/currentMedian")).set(awardedPoints);
      }

      const setNumber = await resolveSetNumberForScore({
        database,
        showId,
        root,
        activity: publicActivity,
        scoredAt: claimedAt,
      });

      await Promise.all([
        applySetScoreDelta({
          database,
          showId,
          root,
          setNumber,
          uid: odience,
          displayName,
          tier,
          category: "dancing",
          scoreDelta: awardedPoints,
          scoredAt: claimedAt,
        }),
        scheduleDebouncedLeaderboardRebuild({
          database,
          showId,
          root,
          kind: "leaderboard",
          reason: "dancing_score",
          rebuild: () => rebuildScoresLeaderboard(database, showId, root),
        }),
      ]);

      logger.info("Dancing scored", {
        showId,
        activityId,
        odience,
        awardedPoints,
        namespacePrefix: normalizedPrefix,
      });

      return null;
    }
  );
}

export const dancingScoring = makeDancingScoring("");
export const dancingScoringTest = makeDancingScoring("test");
