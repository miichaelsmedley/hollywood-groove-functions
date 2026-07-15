import * as admin from "firebase-admin";
import { rebuildSetScoresLeaderboard, scheduleDebouncedLeaderboardRebuild } from "./leaderboardDebounce";

export type ScoreBreakdownKey = "trivia" | "dancing" | "participation" | "starting_bonus";

type LiveSetState = {
  number?: number | null;
  status?: string | null;
  startedAt?: number | null;
  closedAt?: number | null;
};

function intOrDefault(value: unknown, defaultValue: number): number {
  const asNumber = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(asNumber)) return defaultValue;
  return Math.trunc(asNumber);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function showPath(root: string, showId: string, path: string): string {
  const trimmedRoot = root.replace(/\/+$/, "");
  const trimmedPath = path.replace(/^\/+/, "");
  return `${trimmedRoot}/shows/${showId}/${trimmedPath}`;
}

export function setNumberFromActivity(activity: unknown): number | null {
  const raw = activity && typeof activity === "object" ? (activity as Record<string, unknown>).setNumber : null;
  const value = numberOrNull(raw);
  if (value === null || value <= 0) return null;
  return Math.trunc(value);
}

export async function resolveSetNumberForScore(params: {
  database: admin.database.Database;
  showId: string;
  root: string;
  activity: unknown;
  scoredAt: number;
}): Promise<number | null> {
  const fromActivity = setNumberFromActivity(params.activity);
  if (fromActivity !== null) return fromActivity;

  const liveSetSnap = await params.database.ref(showPath(params.root, params.showId, "live/set")).get();
  const liveSet = liveSetSnap.val() as LiveSetState | null;
  const setNumber = numberOrNull(liveSet?.number);
  if (setNumber === null || setNumber <= 0) return null;

  const startedAt = numberOrNull(liveSet?.startedAt);
  const closedAt = numberOrNull(liveSet?.closedAt);
  if (startedAt !== null && params.scoredAt < startedAt) return null;
  if (closedAt !== null && params.scoredAt > closedAt) return null;

  return Math.trunc(setNumber);
}

export async function applySetScoreDelta(params: {
  database: admin.database.Database;
  showId: string;
  root: string;
  setNumber: number | null;
  uid: string;
  displayName: string;
  tier: string | null;
  category: ScoreBreakdownKey;
  scoreDelta: number;
  scoredAt: number;
  correctIncrement?: number;
  currentStreak?: number;
}): Promise<void> {
  const {
    database,
    showId,
    root,
    setNumber,
    uid,
    displayName,
    tier,
    category,
    scoreDelta,
    scoredAt,
    correctIncrement = 0,
    currentStreak,
  } = params;

  if (setNumber === null || setNumber <= 0) return;

  await database.ref(showPath(root, showId, `set_scores/${setNumber}/${uid}`)).transaction((current) => {
    const existing = (current ?? {}) as Record<string, any>;
    const existingTotal = intOrDefault(existing.totalScore, 0);
    const nextTotal = existingTotal + scoreDelta;
    const existingCorrectCount = intOrDefault(existing.correctCount, 0);
    const breakdown = (existing.breakdown ?? {}) as Record<string, any>;
    const categoryTotal = intOrDefault(breakdown[category], 0);
    const next: Record<string, any> = {
      ...existing,
      setNumber,
      displayName: existing.displayName ?? displayName,
      tier: existing.tier ?? tier,
      totalScore: nextTotal,
      breakdown: {
        ...breakdown,
        [category]: categoryTotal + scoreDelta,
      },
      correctCount: existingCorrectCount + correctIncrement,
      lastAnsweredAt: scoredAt,
    };

    if (typeof currentStreak === "number" && Number.isFinite(currentStreak)) {
      next.currentStreak = currentStreak;
    }
    if (nextTotal > existingTotal) {
      next.scoreReachedAt = scoredAt;
    } else if (existing.scoreReachedAt !== undefined) {
      next.scoreReachedAt = existing.scoreReachedAt;
    }

    return next;
  });

  await scheduleDebouncedLeaderboardRebuild({
    database,
    showId,
    root,
    kind: `set_leaderboard_${setNumber}`,
    reason: `${category}_set_score`,
    rebuild: () => rebuildSetScoresLeaderboard(database, showId, root, setNumber),
  });
}
