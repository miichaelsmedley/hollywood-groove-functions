import * as admin from "firebase-admin";
import { logger } from "firebase-functions/v2";

const DEFAULT_REBUILD_DEBOUNCE_MS = 3_000;
const STALE_REBUILD_MS = 60_000;

type LeaderboardKind = string;

type DebouncedRebuildState = {
  dirtyVersion?: number | null;
  lastDirtyAt?: number | null;
  lastDirtyReason?: string | null;
  scheduledAt?: number | null;
  scheduledBy?: string | null;
  runningBy?: string | null;
  runningStartedAt?: number | null;
  runningDirtyVersion?: number | null;
  lastRebuiltAt?: number | null;
  lastRebuiltDirtyVersion?: number | null;
};

function intOrDefault(value: unknown, defaultValue: number): number {
  const asNumber = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(asNumber)) return defaultValue;
  return Math.trunc(asNumber);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stateOrEmpty(value: unknown): DebouncedRebuildState {
  return value && typeof value === "object" ? (value as DebouncedRebuildState) : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createRunId(kind: LeaderboardKind): string {
  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function showPath(root: string, showId: string, path: string): string {
  const trimmedRoot = root.replace(/\/+$/, "");
  const trimmedPath = path.replace(/^\/+/, "");
  return `${trimmedRoot}/shows/${showId}/${trimmedPath}`;
}

function dirtyPath(root: string, showId: string, kind: LeaderboardKind): string {
  return showPath(root, showId, `_internal/leaderboard_rebuilds/${kind}`);
}

function hasActiveSchedule(state: DebouncedRebuildState, now: number): boolean {
  const scheduledAt = numberOrNull(state.scheduledAt);
  return typeof state.scheduledBy === "string" && scheduledAt !== null && scheduledAt > now - STALE_REBUILD_MS;
}

function hasActiveRun(state: DebouncedRebuildState, now: number): boolean {
  const runningStartedAt = numberOrNull(state.runningStartedAt);
  return typeof state.runningBy === "string" && runningStartedAt !== null && runningStartedAt > now - STALE_REBUILD_MS;
}

export async function rebuildScoresLeaderboard(
  database: admin.database.Database,
  showId: string,
  root: string
): Promise<void> {
  const scoresSnap = await database
    .ref(showPath(root, showId, "scores"))
    .orderByChild("totalScore")
    .limitToLast(50)
    .get();

  const scoresValue = (scoresSnap.val() as Record<string, any> | null) ?? {};
  const top = Object.entries(scoresValue)
    .map(([uid, score]) => ({
      uid,
      displayName: (score as any)?.displayName ?? "Guest",
      totalScore: intOrDefault((score as any)?.totalScore, 0),
      tier: (score as any)?.tier ?? null,
    }))
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 50);

  await database.ref(showPath(root, showId, "leaderboard")).set({
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    top,
  });

  logger.info("Leaderboard rebuilt", {
    showId,
    count: top.length,
    root,
  });
}

export async function rebuildSetScoresLeaderboard(
  database: admin.database.Database,
  showId: string,
  root: string,
  setNumber: number
): Promise<void> {
  const scoresSnap = await database
    .ref(showPath(root, showId, `set_scores/${setNumber}`))
    .orderByChild("totalScore")
    .limitToLast(50)
    .get();

  const scoresValue = (scoresSnap.val() as Record<string, any> | null) ?? {};
  const top = Object.entries(scoresValue)
    .map(([uid, score]) => ({
      uid,
      displayName: (score as any)?.displayName ?? "Guest",
      totalScore: intOrDefault((score as any)?.totalScore, 0),
      tier: (score as any)?.tier ?? null,
    }))
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 50);

  await database.ref(showPath(root, showId, `set_leaderboards/${setNumber}`)).set({
    setNumber,
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    top,
  });

  logger.info("Set leaderboard rebuilt", {
    showId,
    setNumber,
    count: top.length,
    root,
  });
}

export async function scheduleDebouncedLeaderboardRebuild(params: {
  database: admin.database.Database;
  showId: string;
  root: string;
  kind: LeaderboardKind;
  reason: string;
  rebuild: () => Promise<void>;
  debounceMs?: number;
}): Promise<void> {
  const {
    database,
    showId,
    root,
    kind,
    reason,
    rebuild,
    debounceMs = DEFAULT_REBUILD_DEBOUNCE_MS,
  } = params;

  const runId = createRunId(kind);
  const ref = database.ref(dirtyPath(root, showId, kind));
  const now = Date.now();

  const scheduleResult = await ref.transaction((current) => {
    const state = stateOrEmpty(current);
    const dirtyVersion = intOrDefault(state.dirtyVersion, 0) + 1;
    const nextState: DebouncedRebuildState = {
      ...state,
      dirtyVersion,
      lastDirtyAt: now,
      lastDirtyReason: reason,
    };

    if (hasActiveSchedule(state, now) || hasActiveRun(state, now)) {
      return nextState;
    }

    return {
      ...nextState,
      scheduledAt: now + debounceMs,
      scheduledBy: runId,
    };
  });

  const scheduledState = stateOrEmpty(scheduleResult.snapshot.val());
  if (!scheduleResult.committed || scheduledState.scheduledBy !== runId) {
    return;
  }

  await runScheduledRebuild({
    ref,
    runId,
    showId,
    root,
    kind,
    rebuild,
    debounceMs,
    initialScheduledAt: numberOrNull(scheduledState.scheduledAt) ?? Date.now(),
  });
}

async function runScheduledRebuild(params: {
  ref: admin.database.Reference;
  runId: string;
  showId: string;
  root: string;
  kind: LeaderboardKind;
  rebuild: () => Promise<void>;
  debounceMs: number;
  initialScheduledAt: number;
}): Promise<void> {
  const { ref, runId, showId, root, kind, rebuild, debounceMs } = params;
  let scheduledAt = params.initialScheduledAt;

  while (true) {
    const waitMs = Math.max(0, scheduledAt - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const claimResult = await ref.transaction((current) => {
      const state = stateOrEmpty(current);
      if (state.scheduledBy !== runId) {
        return state;
      }

      const dueAt = numberOrNull(state.scheduledAt);
      const now = Date.now();
      if (dueAt !== null && dueAt > now) {
        return state;
      }

      return {
        ...state,
        scheduledAt: null,
        scheduledBy: null,
        runningBy: runId,
        runningStartedAt: now,
        runningDirtyVersion: intOrDefault(state.dirtyVersion, 0),
      };
    });

    const claimedState = stateOrEmpty(claimResult.snapshot.val());
    if (claimedState.runningBy !== runId) {
      return;
    }

    const runningDirtyVersion = intOrDefault(
      claimedState.runningDirtyVersion,
      intOrDefault(claimedState.dirtyVersion, 0)
    );

    await rebuild();

    const completedAt = Date.now();
    const finalizeResult = await ref.transaction((current) => {
      const state = stateOrEmpty(current);
      if (state.runningBy !== runId) {
        return state;
      }

      const latestDirtyVersion = intOrDefault(state.dirtyVersion, runningDirtyVersion);
      const baseState: DebouncedRebuildState = {
        ...state,
        runningBy: null,
        runningStartedAt: null,
        runningDirtyVersion: null,
        lastRebuiltAt: completedAt,
        lastRebuiltDirtyVersion: runningDirtyVersion,
      };

      if (latestDirtyVersion > runningDirtyVersion) {
        return {
          ...baseState,
          scheduledAt: completedAt + debounceMs,
          scheduledBy: runId,
        };
      }

      return {
        ...baseState,
        scheduledAt: null,
        scheduledBy: null,
      };
    });

    const finalizedState = stateOrEmpty(finalizeResult.snapshot.val());
    if (finalizedState.scheduledBy !== runId) {
      return;
    }

    scheduledAt = numberOrNull(finalizedState.scheduledAt) ?? Date.now() + debounceMs;
    logger.info("Leaderboard rebuild rescheduled for fresh writes", {
      showId,
      root,
      kind,
      scheduledAt,
    });
  }
}
