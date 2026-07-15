import * as admin from "firebase-admin";
import { onValueWritten, DataSnapshot, DatabaseEvent } from "firebase-functions/v2/database";
import { Change } from "firebase-functions/common";
import { logger } from "firebase-functions/v2";

const DEFAULT_SEASON_ID = "2026";
const ATTENDANCE_SEASON_POINTS = 200;

type ScoreRecord = {
  displayName?: string;
  totalScore?: number;
  tier?: string | null;
  lastAnsweredAt?: number | null;
  scoreReachedAt?: number | null;
};

type AttendeeRecord = {
  display_name?: string;
  tier_at_checkin?: string | null;
};

type MemberRecord = {
  display_name?: string;
  season_points?: Record<string, number>;
  season_points_awards?: Record<string, Record<string, unknown>>;
  stars?: {
    tier?: string | null;
  };
};

type Winner = {
  uid: string;
  displayName: string;
  points: number;
  tier: string | null;
  scoreReachedAt: number | null;
};

function normalizeNamespacePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed;
}

function namespaceRoot(prefix: string): string {
  const normalized = normalizeNamespacePrefix(prefix);
  return normalized.length > 0 ? `/${normalized}` : "";
}

function showPath(root: string, showId: string, path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  return `${root}/shows/${showId}/${trimmed}`;
}

function rootPath(root: string, path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  return `${root}/${trimmed}`;
}

function intOrDefault(value: unknown, defaultValue: number): number {
  const asNumber = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(asNumber)) return defaultValue;
  return Math.trunc(asNumber);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function chooseWinner(scores: Record<string, ScoreRecord>): Winner | null {
  const candidates = Object.entries(scores)
    .map(([uid, score]) => ({
      uid,
      displayName: score.displayName ?? "Guest",
      points: intOrDefault(score.totalScore, 0),
      tier: score.tier ?? null,
      scoreReachedAt: numberOrNull(score.scoreReachedAt) ?? numberOrNull(score.lastAnsweredAt),
    }))
    .filter((entry) => entry.points > 0);

  if (candidates.length === 0) return null;

  return candidates.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const aReached = a.scoreReachedAt ?? Number.MAX_SAFE_INTEGER;
    const bReached = b.scoreReachedAt ?? Number.MAX_SAFE_INTEGER;
    if (aReached !== bReached) return aReached - bReached;
    return a.uid.localeCompare(b.uid);
  })[0];
}

function makeResultPayload(params: {
  winner: Winner | null;
  setNumber?: number;
  closedAt: number;
}) {
  const base: Record<string, unknown> = {
    closedAt: params.closedAt,
    computedAt: admin.database.ServerValue.TIMESTAMP,
    tieBreak: "earliest_to_reach_score",
  };
  if (typeof params.setNumber === "number") {
    base.setNumber = params.setNumber;
  }
  if (!params.winner) {
    return {
      ...base,
      uid: null,
      displayName: null,
      points: 0,
      noWinner: true,
    };
  }
  return {
    ...base,
    uid: params.winner.uid,
    displayName: params.winner.displayName,
    points: params.winner.points,
    tier: params.winner.tier,
    scoreReachedAt: params.winner.scoreReachedAt,
  };
}

async function rebuildSeasonLeaderboard(
  database: admin.database.Database,
  root: string,
  seasonId: string
): Promise<void> {
  const membersSnap = await database
    .ref(rootPath(root, "members"))
    .orderByChild(`season_points/${seasonId}`)
    .limitToLast(50)
    .get();

  const membersValue = (membersSnap.val() as Record<string, MemberRecord> | null) ?? {};
  const top = Object.entries(membersValue)
    .map(([uid, member]) => ({
      uid,
      displayName: member.display_name ?? "Guest",
      seasonPoints: intOrDefault(member.season_points?.[seasonId], 0),
      tier: member.stars?.tier ?? null,
    }))
    .filter((entry) => entry.seasonPoints > 0)
    .sort((a, b) => b.seasonPoints - a.seasonPoints || a.uid.localeCompare(b.uid))
    .slice(0, 50);

  await database.ref(rootPath(root, `leaderboards/season/${seasonId}`)).set({
    seasonId,
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    top,
  });
}

async function applySeasonAwards(params: {
  database: admin.database.Database;
  root: string;
  showId: string;
  seasonId: string;
  scores: Record<string, ScoreRecord>;
  attendees: Record<string, AttendeeRecord>;
  closedAt: number;
}): Promise<void> {
  const { database, root, showId, seasonId, scores, attendees, closedAt } = params;
  const uids = new Set([...Object.keys(scores), ...Object.keys(attendees)]);

  await Promise.all([...uids].map(async (uid) => {
    const score = scores[uid];
    const attendee = attendees[uid];
    const nightTotal = intOrDefault(score?.totalScore, 0);
    const pointsAwarded = nightTotal + ATTENDANCE_SEASON_POINTS;
    const displayName = score?.displayName ?? attendee?.display_name ?? "Guest";

    await database.ref(rootPath(root, `members/${uid}`)).transaction((current) => {
      const member = ((current ?? {}) as Record<string, any>);
      const seasonPoints = { ...((member.season_points ?? {}) as Record<string, number>) };
      const awardsBySeason = {
        ...((member.season_points_awards ?? {}) as Record<string, Record<string, unknown>>),
      };
      const seasonAwards = { ...((awardsBySeason[seasonId] ?? {}) as Record<string, unknown>) };

      if (seasonAwards[showId]) {
        return member;
      }

      seasonPoints[seasonId] = intOrDefault(seasonPoints[seasonId], 0) + pointsAwarded;
      seasonAwards[showId] = {
        showId,
        seasonId,
        nightTotal,
        attendanceBonus: ATTENDANCE_SEASON_POINTS,
        pointsAwarded,
        awardedAt: closedAt,
      };
      awardsBySeason[seasonId] = seasonAwards;

      return {
        ...member,
        display_name: member.display_name ?? displayName,
        season_points: seasonPoints,
        season_points_awards: awardsBySeason,
      };
    });
  }));

  await rebuildSeasonLeaderboard(database, root, seasonId);
}

type SetCloseParams = { showId: string; setNumber: string };
type ShowCloseParams = { showId: string };

function makeSetWinnerFinalizer(namespacePrefix: string) {
  const normalizedPrefix = normalizeNamespacePrefix(namespacePrefix);
  const root = namespaceRoot(normalizedPrefix);

  return onValueWritten(
    { ref: `${root}/shows/{showId}/set_closures/{setNumber}/closedAt`, region: "asia-southeast1" },
    async (event: DatabaseEvent<Change<DataSnapshot>, SetCloseParams>) => {
      if (!event.data.after.exists() || event.data.before.exists()) return null;

      const { showId, setNumber: setNumberParam } = event.params;
      const setNumber = intOrDefault(Number(setNumberParam), 0);
      if (setNumber <= 0) return null;

      const closedAt = intOrDefault(event.data.after.val(), Date.now());
      const database = admin.database();
      const scoresSnap = await database.ref(showPath(root, showId, `set_scores/${setNumber}`)).get();
      const scores = (scoresSnap.val() as Record<string, ScoreRecord> | null) ?? {};
      const winner = chooseWinner(scores);

      await database.ref(showPath(root, showId, `set_winners/${setNumber}`)).set(
        makeResultPayload({ winner, setNumber, closedAt })
      );

      logger.info("Set winner finalized", {
        showId,
        setNumber,
        uid: winner?.uid ?? null,
        points: winner?.points ?? 0,
        namespacePrefix: normalizedPrefix,
      });
      return null;
    }
  );
}

function makeNightWinnerFinalizer(namespacePrefix: string) {
  const normalizedPrefix = normalizeNamespacePrefix(namespacePrefix);
  const root = namespaceRoot(normalizedPrefix);

  return onValueWritten(
    { ref: `${root}/shows/{showId}/show_closures/final/closedAt`, region: "asia-southeast1" },
    async (event: DatabaseEvent<Change<DataSnapshot>, ShowCloseParams>) => {
      if (!event.data.after.exists() || event.data.before.exists()) return null;

      const { showId } = event.params;
      const closedAt = intOrDefault(event.data.after.val(), Date.now());
      const database = admin.database();

      const [scoresSnap, attendeesSnap, seasonSnap] = await Promise.all([
        database.ref(showPath(root, showId, "scores")).get(),
        database.ref(showPath(root, showId, "attendees")).get(),
        database.ref(rootPath(root, "config/current_season")).get(),
      ]);

      const scores = (scoresSnap.val() as Record<string, ScoreRecord> | null) ?? {};
      const attendees = (attendeesSnap.val() as Record<string, AttendeeRecord> | null) ?? {};
      const seasonValue = seasonSnap.val();
      const seasonId = typeof seasonValue === "string" && seasonValue.trim().length > 0
        ? seasonValue.trim()
        : DEFAULT_SEASON_ID;
      const winner = chooseWinner(scores);

      await database.ref(showPath(root, showId, "night_winner")).set(
        makeResultPayload({ winner, closedAt })
      );

      await applySeasonAwards({
        database,
        root,
        showId,
        seasonId,
        scores,
        attendees,
        closedAt,
      });

      logger.info("Night winner and season points finalized", {
        showId,
        seasonId,
        uid: winner?.uid ?? null,
        points: winner?.points ?? 0,
        attendeeCount: Object.keys(attendees).length,
        scoreCount: Object.keys(scores).length,
        namespacePrefix: normalizedPrefix,
      });
      return null;
    }
  );
}

export const setWinnerFinalizer = makeSetWinnerFinalizer("");
export const setWinnerFinalizerTest = makeSetWinnerFinalizer("test");
export const nightWinnerFinalizer = makeNightWinnerFinalizer("");
export const nightWinnerFinalizerTest = makeNightWinnerFinalizer("test");
