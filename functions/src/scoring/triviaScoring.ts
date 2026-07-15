import * as admin from "firebase-admin";
import { onValueWritten, DataSnapshot, DatabaseEvent } from "firebase-functions/v2/database";
import { Change } from "firebase-functions/common";
import { logger } from "firebase-functions/v2";
import { rebuildScoresLeaderboard, scheduleDebouncedLeaderboardRebuild } from "./leaderboardDebounce";
import { isTriviaResponsePayload, type TriviaResponseContract } from "./responseContracts";
import { applySetScoreDelta, resolveSetNumberForScore } from "./setScoring";

type TriviaResponse = TriviaResponseContract;

type TriviaPrivateActivity = {
  trivia?: {
    correctOptionIndex?: number | null;
    acceptableAnswers?: string[] | null;
  };
};

type TriviaPublicActivity = {
  setNumber?: number | null;
  trivia?: {
    question?: string;
    kind?: string;
    scale?: {
      min?: number;
      max?: number;
      step?: number;
    };
  };
};

type LiveTriviaState = {
  activityId?: string | null;
  startedAt?: number | null;
  durationSeconds?: number | null;
};

type ShowSettings = {
  trivia_base_points?: number;
  trivia_speed_bonus?: number;
  trivia_time_limit?: number; // seconds
  streak_mode?: "per_round" | "per_show" | "disabled";

  // Backwards-compat / alternate naming
  base_points?: number;
  speed_bonus?: number;
  time_limit?: number;
};

type AttendeeRecord = {
  current_streak?: number;
  display_name?: string;
  tier_at_checkin?: string;
};

function numberOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

function intOrDefault(value: unknown, defaultValue: number): number {
  const asNumber = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(asNumber)) return defaultValue;
  return Math.trunc(asNumber);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function timestampFromEventTime(eventTime: string | undefined): number | null {
  if (!eventTime) return null;
  const timestamp = Date.parse(eventTime);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normaliseAnswer(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

function fallbackFreeformScore(responseText: string, acceptableAnswers: string[]): { isCorrect: boolean; score: number } {
  const response = normaliseAnswer(responseText);
  const isCorrect = acceptableAnswers.some((answer) => normaliseAnswer(answer) === response);
  return { isCorrect, score: isCorrect ? 1 : 0 };
}

async function scoreFreeformResponse(params: {
  responseText: string;
  questionText: string;
  acceptableAnswers: string[];
}): Promise<{ isCorrect: boolean; score: number }> {
  const { responseText, questionText, acceptableAnswers } = params;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return fallbackFreeformScore(responseText, acceptableAnswers);
  }

  const prompt = [
    "You are scoring a trivia response.",
    `Question: ${questionText}`,
    `Accepted answers: ${acceptableAnswers.join(", ")}`,
    `Response: ${responseText}`,
    "Return JSON with keys isCorrect (boolean) and score (number between 0 and 1)."
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: "You are a strict JSON generator." },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!response.ok) {
      return fallbackFreeformScore(responseText, acceptableAnswers);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const trimmed = typeof content === "string" ? content.trim() : "";
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");
    const jsonText = jsonStart >= 0 && jsonEnd > jsonStart ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed;
    const parsed = JSON.parse(jsonText);
    const isCorrect = Boolean(parsed?.isCorrect);
    const score = clamp01(numberOrDefault(parsed?.score, isCorrect ? 1 : 0));
    return { isCorrect, score };
  } catch (error) {
    logger.warn("Freeform scoring fallback", { error });
    return fallbackFreeformScore(responseText, acceptableAnswers);
  }
}

function getStreakMultiplier(streak: number): number {
  if (streak >= 4) return 2.0;
  if (streak >= 3) return 1.5;
  if (streak >= 2) return 1.2;
  return 1.0;
}

function normalizeNamespacePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed;
}

function namespaceRoot(prefix: string): string {
  const normalized = normalizeNamespacePrefix(prefix);
  return normalized.length > 0 ? `/${normalized}` : "";
}

function resolveTriviaSettings(settings: ShowSettings | null): {
  basePoints: number;
  speedBonus: number;
  timeLimitSeconds: number;
  streakMode: "per_round" | "per_show" | "disabled";
} {
  const basePoints = numberOrDefault(settings?.trivia_base_points ?? settings?.base_points, 100);
  const speedBonus = numberOrDefault(settings?.trivia_speed_bonus ?? settings?.speed_bonus, 50);
  const timeLimitSeconds = numberOrDefault(settings?.trivia_time_limit ?? settings?.time_limit, 15);

  const streakModeRaw = settings?.streak_mode;
  const streakMode: "per_round" | "per_show" | "disabled" =
    streakModeRaw === "per_round" || streakModeRaw === "per_show" || streakModeRaw === "disabled"
      ? streakModeRaw
      : "per_round";

  return {
    basePoints,
    speedBonus,
    timeLimitSeconds: timeLimitSeconds > 0 ? timeLimitSeconds : 15,
    streakMode,
  };
}

type TriviaScoringParams = { showId: string; activityId: string; odience: string };

function makeTriviaScoring(namespacePrefix: string) {
  const normalizedPrefix = normalizeNamespacePrefix(namespacePrefix);
  const root = namespaceRoot(normalizedPrefix);

  const showPath = (showId: string, path: string): string => {
    const trimmed = path.replace(/^\/+/, "");
    return `${root}/shows/${showId}/${trimmed}`;
  };

  return onValueWritten(
    { ref: `${root}/shows/{showId}/responses/{activityId}/{odience}`, region: "asia-southeast1" },
    async (event: DatabaseEvent<Change<DataSnapshot>, TriviaScoringParams>) => {
    const { showId, activityId, odience } = event.params;
    const change = event.data;

    if (!change.after.exists()) {
      return null;
    }

    // Only score the first write (create). Updates are ignored to prevent double scoring.
    if (change.before.exists()) {
      return null;
    }

    const rawResponse = change.after.val();
    if (!isTriviaResponsePayload(rawResponse)) {
      // Not a trivia response (e.g., dance claim or signup).
      return null;
    }
    const response = rawResponse as TriviaResponse;

    const optionIndexRaw = typeof response.optionIndex === "number" && Number.isFinite(response.optionIndex)
      ? response.optionIndex
      : null;
    const booleanValue = typeof response.booleanValue === "boolean" ? response.booleanValue : null;
    const scaleValue = typeof response.scaleValue === "number" && Number.isFinite(response.scaleValue)
      ? response.scaleValue
      : null;
    const responseText = typeof response.text === "string" ? response.text.trim() : null;

    const hasChoice = optionIndexRaw !== null || booleanValue !== null;
    const hasScale = scaleValue !== null;
    const hasFreeform = responseText !== null && responseText.length > 0;

    const database = admin.database();

    const [existingResultSnap, privateSnap, settingsSnap, attendeeSnap, activitySnap, liveTriviaSnap] = await Promise.all([
      database.ref(showPath(showId, `results/${activityId}/${odience}`)).get(),
      database.ref(showPath(showId, `activities_private/${activityId}`)).get(),
      database.ref(showPath(showId, "settings")).get(),
      database.ref(showPath(showId, `attendees/${odience}`)).get(),
      database.ref(showPath(showId, `activities/${activityId}`)).get(),
      database.ref(showPath(showId, "live/trivia")).get(),
    ]);

    // Idempotency guard: if a result already exists for this user+activity, do not apply scoring again.
    if (existingResultSnap.exists()) {
      return null;
    }

    const privateActivity = privateSnap.val() as TriviaPrivateActivity | null;
    const publicActivity = activitySnap.val() as TriviaPublicActivity | null;
    const liveTrivia = liveTriviaSnap.val() as LiveTriviaState | null;
    const correctOptionIndex = privateActivity?.trivia?.correctOptionIndex;

    const settings = settingsSnap.val() as ShowSettings | null;
    const { basePoints, speedBonus, timeLimitSeconds, streakMode } = resolveTriviaSettings(settings);
    const timeLimitMs = timeLimitSeconds * 1000;

    const attendee = (attendeeSnap.val() as AttendeeRecord | null) ?? {};
    const currentStreak = intOrDefault(attendee.current_streak, 0);

    let isCorrect = false;
    let awardedBase = 0;
    let awardedSpeedBonus = 0;
    let totalScore = 0;
    let affectsStreak = false;
    let allowPartialScore = false;

    const eventTime = (event as { time?: string }).time;
    const answeredAt = timestampFromEventTime(eventTime) ?? Date.now();
    const liveDurationSeconds = numberOrDefault(liveTrivia?.durationSeconds, timeLimitSeconds);
    const scoringWindowMs = Math.max(0, liveDurationSeconds) * 1000 || timeLimitMs;
    const hasMatchingLiveTrivia =
      liveTrivia?.activityId === activityId &&
      typeof liveTrivia.startedAt === "number" &&
      Number.isFinite(liveTrivia.startedAt);
    const elapsedMs = hasMatchingLiveTrivia
      ? answeredAt - (liveTrivia.startedAt as number)
      : scoringWindowMs;
    const clampedElapsedMs = Math.min(Math.max(elapsedMs, 0), scoringWindowMs);
    const speedFactor = clamp01(1 - clampedElapsedMs / scoringWindowMs);

    if (hasChoice) {
      const resolvedIndex = optionIndexRaw ?? (booleanValue ? 0 : 1);
      if (typeof correctOptionIndex !== "number" || !Number.isFinite(correctOptionIndex)) {
        logger.warn("Trivia scoring skipped: missing correctOptionIndex", {
          showId,
          activityId,
          namespacePrefix: normalizedPrefix,
        });
        return null;
      }
      isCorrect = resolvedIndex === correctOptionIndex;
      awardedBase = isCorrect ? Math.floor(basePoints) : 0;
      awardedSpeedBonus = isCorrect ? Math.floor(speedBonus * speedFactor) : 0;
      affectsStreak = true;
    } else if (hasScale && scaleValue !== null) {
      const scaleConfig = publicActivity?.trivia?.scale ?? {};
      const min = numberOrDefault(scaleConfig.min, 0);
      const max = numberOrDefault(scaleConfig.max, 10);
      const range = max > min ? max - min : 10;
      const ratio = clamp01((scaleValue - min) / range);
      awardedBase = Math.floor(basePoints * ratio);
      awardedSpeedBonus = 0;
      totalScore = awardedBase;
      isCorrect = false;
      affectsStreak = false;
    } else if (hasFreeform && responseText) {
      const acceptableAnswers = privateActivity?.trivia?.acceptableAnswers ?? [];
      if (!Array.isArray(acceptableAnswers) || acceptableAnswers.length === 0) {
        logger.warn("Trivia scoring skipped: missing acceptableAnswers", {
          showId,
          activityId,
          namespacePrefix: normalizedPrefix,
        });
        return null;
      }
      const questionText = publicActivity?.trivia?.question ?? "";
      const freeform = await scoreFreeformResponse({
        responseText,
        questionText,
        acceptableAnswers,
      });
      isCorrect = freeform.isCorrect;
      awardedBase = Math.floor(basePoints * freeform.score);
      awardedSpeedBonus = 0;
      affectsStreak = true;
      allowPartialScore = true;
    }

    let nextStreak = currentStreak;
    if (streakMode === "disabled") {
      nextStreak = 0;
    } else if (affectsStreak) {
      nextStreak = isCorrect ? Math.max(0, currentStreak) + 1 : 0;
    }

    const streakMultiplier = streakMode === "disabled" || !affectsStreak
      ? 1.0
      : getStreakMultiplier(nextStreak);

    if (affectsStreak) {
      if (isCorrect) {
        totalScore = Math.floor((awardedBase + awardedSpeedBonus) * streakMultiplier);
      } else {
        totalScore = allowPartialScore ? awardedBase : 0;
      }
    } else if (!hasChoice && hasScale) {
      totalScore = awardedBase;
    }

    // 1) Update attendee streak
    await database.ref(showPath(showId, `attendees/${odience}/current_streak`)).set(nextStreak);

    // 2) Write per-question result
    await database.ref(showPath(showId, `results/${activityId}/${odience}`)).set({
      isCorrect,
      baseScore: awardedBase,
      speedBonus: awardedSpeedBonus,
      streakMultiplier,
      totalScore,
      answeredAt,
    });

    // 3) Update running totals
    const displayName = response.displayName ?? attendee.display_name ?? "Guest";
    const tier = attendee.tier_at_checkin ?? null;

    await database.ref(showPath(showId, `scores/${odience}`)).transaction((current) => {
      const existing = (current ?? {}) as Record<string, any>;
      const existingTotal = intOrDefault(existing.totalScore, 0);
      const nextTotal = existingTotal + totalScore;
      const existingCorrectCount = intOrDefault(existing.correctCount, 0);

      const breakdown = (existing.breakdown ?? {}) as Record<string, any>;
      const triviaBreakdown = intOrDefault(breakdown.trivia, 0);

      return {
        ...existing,
        displayName: existing.displayName ?? displayName,
        tier: existing.tier ?? tier,
        totalScore: nextTotal,
        breakdown: {
          ...breakdown,
          trivia: triviaBreakdown + totalScore,
        },
        correctCount: existingCorrectCount + (isCorrect ? 1 : 0),
        currentStreak: nextStreak,
        lastAnsweredAt: answeredAt,
        scoreReachedAt: nextTotal > existingTotal ? answeredAt : existing.scoreReachedAt ?? null,
      };
    });

    const setNumber = await resolveSetNumberForScore({
      database,
      showId,
      root,
      activity: publicActivity,
      scoredAt: answeredAt,
    });

    // 4) Update set tally and coalesce leaderboard rebuilds across the response burst.
    await Promise.all([
      applySetScoreDelta({
        database,
        showId,
        root,
        setNumber,
        uid: odience,
        displayName,
        tier,
        category: "trivia",
        scoreDelta: totalScore,
        scoredAt: answeredAt,
        correctIncrement: isCorrect ? 1 : 0,
        currentStreak: nextStreak,
      }),
      scheduleDebouncedLeaderboardRebuild({
        database,
        showId,
        root,
        kind: "leaderboard",
        reason: "trivia_score",
        rebuild: () => rebuildScoresLeaderboard(database, showId, root),
      }),
    ]);

    return null;
    }
  );
}

export const triviaScoring = makeTriviaScoring("");
export const triviaScoringTest = makeTriviaScoring("test");
