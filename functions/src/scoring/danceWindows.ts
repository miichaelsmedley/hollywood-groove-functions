import * as admin from "firebase-admin";
import { randomBytes } from "crypto";
import { onValueWritten, DataSnapshot, DatabaseEvent } from "firebase-functions/v2/database";
import { Change } from "firebase-functions/common";
import { logger } from "firebase-functions/v2";
import { rebuildScoresLeaderboard, scheduleDebouncedLeaderboardRebuild } from "./leaderboardDebounce";
import { applySetScoreDelta } from "./setScoring";

const REGION = "asia-southeast1";
const PARTICIPATION_POINTS = 100;
const SPOTLIGHT_POINTS = 150;
const PRESENCE_FRESH_MS = 35_000;
const SPOTLIGHT_LATE_GRACE_MS = 2_000;

type DanceWindowState = {
  windowId?: string | null;
  songTitle?: string | null;
  status?: "open" | "closed" | string | null;
  startedAt?: number | null;
  endsAt?: number | null;
  setNumber?: number | null;
};

type DancePresence = {
  active?: boolean | null;
  mode?: string | null;
  displayName?: string | null;
  enteredAt?: number | null;
  updatedAt?: number | null;
};

type AttendeeRecord = {
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

type DanceWindowParams = { showId: string };
type DancePresenceParams = { showId: string; uid: string };
type SpotlightParams = { showId: string; windowId: string };

function normalizeNamespacePrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function namespaceRoot(prefix: string): string {
  const normalized = normalizeNamespacePrefix(prefix);
  return normalized.length > 0 ? `/${normalized}` : "";
}

function showPath(root: string, showId: string, path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  return `${root}/shows/${showId}/${trimmed}`;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function intOrDefault(value: unknown, fallback: number): number {
  const asNumber = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(asNumber)) return fallback;
  return Math.trunc(asNumber);
}

function isOpenWindow(value: DanceWindowState | null): value is Required<Pick<DanceWindowState, "windowId">> & DanceWindowState {
  return Boolean(value?.windowId) && value?.status === "open";
}

function isActivePresenceAt(presence: DancePresence | null, atMs: number, allowLate = false): boolean {
  if (!presence || presence.active !== true || presence.mode !== "dancing") return false;
  const updatedAt = numberOrDefault(presence.updatedAt, 0);
  if (updatedAt <= 0) return false;
  const latestAllowed = allowLate ? atMs + SPOTLIGHT_LATE_GRACE_MS : atMs;
  return updatedAt >= atMs - PRESENCE_FRESH_MS && updatedAt <= latestAllowed;
}

async function displayNameFor(
  database: admin.database.Database,
  root: string,
  showId: string,
  uid: string,
  presence: DancePresence | null
): Promise<{ displayName: string; tier: string | null }> {
  const attendeeSnap = await database.ref(showPath(root, showId, `attendees/${uid}`)).get();
  const attendee = attendeeSnap.val() as AttendeeRecord | null;
  return {
    displayName: presence?.displayName || attendee?.display_name || "Guest",
    tier: attendee?.tier_at_checkin ?? null,
  };
}

async function applyScoreDelta(params: {
  database: admin.database.Database;
  root: string;
  showId: string;
  uid: string;
  displayName: string;
  tier: string | null;
  setNumber: number | null;
  points: number;
  scoredAt: number;
  reason: string;
}): Promise<void> {
  const { database, root, showId, uid, displayName, tier, setNumber, points, scoredAt, reason } = params;

  await database.ref(showPath(root, showId, `attendees/${uid}`)).transaction((current) => {
    const existing = (current ?? {}) as AttendeeRecord;
    const totalScore = intOrDefault(existing.total_score, 0);
    const breakdown = (existing.breakdown ?? {}) as NonNullable<AttendeeRecord["breakdown"]>;
    const participation = intOrDefault(breakdown.participation, 0);
    return {
      ...existing,
      total_score: totalScore + points,
      breakdown: {
        ...breakdown,
        participation: participation + points,
      },
    };
  });

  await database.ref(showPath(root, showId, `scores/${uid}`)).transaction((current) => {
    const existing = (current ?? {}) as Record<string, any>;
    const existingTotal = intOrDefault(existing.totalScore, 0);
    const nextTotal = existingTotal + points;
    const breakdown = (existing.breakdown ?? {}) as Record<string, any>;
    const participation = intOrDefault(breakdown.participation, 0);
    return {
      ...existing,
      displayName: existing.displayName ?? displayName,
      tier: existing.tier ?? tier,
      totalScore: nextTotal,
      breakdown: {
        ...breakdown,
        participation: participation + points,
      },
      lastAnsweredAt: scoredAt,
      scoreReachedAt: nextTotal > existingTotal ? scoredAt : existing.scoreReachedAt ?? null,
    };
  });

  await Promise.all([
    applySetScoreDelta({
      database,
      showId,
      root,
      setNumber,
      uid,
      displayName,
      tier,
      category: "participation",
      scoreDelta: points,
      scoredAt,
    }),
    scheduleDebouncedLeaderboardRebuild({
      database,
      showId,
      root,
      kind: "leaderboard",
      reason,
      rebuild: () => rebuildScoresLeaderboard(database, showId, root),
    }),
  ]);
}

async function awardWindowPoints(params: {
  database: admin.database.Database;
  root: string;
  showId: string;
  window: DanceWindowState;
  uid: string;
  presence: DancePresence | null;
  kind: "participation" | "spotlight";
  points: number;
  awardedAt: number;
}): Promise<boolean> {
  const { database, root, showId, window, uid, presence, kind, points, awardedAt } = params;
  const windowId = window.windowId;
  if (!windowId) return false;

  const runId = randomBytes(8).toString("hex");
  const awardRef = database.ref(showPath(root, showId, `dance_window_awards/${windowId}/${uid}`));
  const pointsKey = `${kind}Points`;
  const awardedAtKey = `${kind}AwardedAt`;
  const runIdKey = `${kind}RunId`;

  const result = await awardRef.transaction((current) => {
    const existing = (current ?? {}) as Record<string, any>;
    if (intOrDefault(existing[pointsKey], 0) > 0) {
      return existing;
    }
    return {
      ...existing,
      uid,
      windowId,
      showId,
      songTitle: window.songTitle ?? null,
      setNumber: window.setNumber ?? null,
      displayName: presence?.displayName ?? existing.displayName ?? "Guest",
      totalPoints: intOrDefault(existing.totalPoints, 0) + points,
      [pointsKey]: points,
      [awardedAtKey]: awardedAt,
      [runIdKey]: runId,
    };
  });

  const awarded = (result.snapshot.val() as Record<string, any> | null)?.[runIdKey] === runId;
  if (!awarded) return false;

  const identity = await displayNameFor(database, root, showId, uid, presence);
  await awardRef.update({ displayName: identity.displayName });
  await applyScoreDelta({
    database,
    root,
    showId,
    uid,
    displayName: identity.displayName,
    tier: identity.tier,
    setNumber: intOrDefault(window.setNumber, 0) > 0 ? intOrDefault(window.setNumber, 0) : null,
    points,
    scoredAt: awardedAt,
    reason: `dance_window_${kind}`,
  });

  return true;
}

async function activePresenceEntries(database: admin.database.Database, root: string, showId: string, atMs: number, allowLate = false) {
  const snap = await database.ref(showPath(root, showId, "dance_presence")).get();
  const value = (snap.val() as Record<string, DancePresence> | null) ?? {};
  return Object.entries(value).filter(([, presence]) => isActivePresenceAt(presence, atMs, allowLate));
}

async function awardParticipationForPresence(params: {
  database: admin.database.Database;
  root: string;
  showId: string;
  uid: string;
  presence: DancePresence | null;
  window: DanceWindowState | null;
}): Promise<boolean> {
  const { database, root, showId, uid, presence, window } = params;
  if (!isOpenWindow(window)) return false;
  const now = Date.now();
  const startedAt = numberOrDefault(window.startedAt, now);
  const endsAt = numberOrDefault(window.endsAt, now);
  if (now < startedAt || now > endsAt) return false;
  if (!isActivePresenceAt(presence, now, true)) return false;

  return awardWindowPoints({
    database,
    root,
    showId,
    window,
    uid,
    presence,
    kind: "participation",
    points: PARTICIPATION_POINTS,
    awardedAt: now,
  });
}

function makeDanceWindowOpenedScoring(namespacePrefix: string) {
  const root = namespaceRoot(namespacePrefix);
  return onValueWritten(
    { ref: `${root}/shows/{showId}/live/dance_window`, region: REGION },
    async (event: DatabaseEvent<Change<DataSnapshot>, DanceWindowParams>) => {
      const after = event.data.after.val() as DanceWindowState | null;
      const before = event.data.before.val() as DanceWindowState | null;
      if (!isOpenWindow(after)) return null;
      if (before?.windowId === after.windowId && before?.status === "open") return null;

      const database = admin.database();
      const now = Date.now();
      const entries = await activePresenceEntries(database, root, event.params.showId, now, true);
      const awarded = await Promise.all(entries.map(([uid, presence]) =>
        awardWindowPoints({
          database,
          root,
          showId: event.params.showId,
          window: after,
          uid,
          presence,
          kind: "participation",
          points: PARTICIPATION_POINTS,
          awardedAt: now,
        })
      ));

      await database.ref(showPath(root, event.params.showId, "live/dance_window/dancerCount")).set(entries.length);
      logger.info("Dance window opened", {
        showId: event.params.showId,
        windowId: after.windowId,
        dancerCount: entries.length,
        awardedCount: awarded.filter(Boolean).length,
        namespacePrefix,
      });
      return null;
    }
  );
}

function makeDancePresenceScoring(namespacePrefix: string) {
  const root = namespaceRoot(namespacePrefix);
  return onValueWritten(
    { ref: `${root}/shows/{showId}/dance_presence/{uid}`, region: REGION },
    async (event: DatabaseEvent<Change<DataSnapshot>, DancePresenceParams>) => {
      const presence = event.data.after.val() as DancePresence | null;
      if (!presence?.active || presence.mode !== "dancing") return null;

      const database = admin.database();
      const windowSnap = await database.ref(showPath(root, event.params.showId, "live/dance_window")).get();
      const window = windowSnap.val() as DanceWindowState | null;
      const awarded = await awardParticipationForPresence({
        database,
        root,
        showId: event.params.showId,
        uid: event.params.uid,
        presence,
        window,
      });

      if (awarded) {
        const now = Date.now();
        const count = (await activePresenceEntries(database, root, event.params.showId, now, true)).length;
        await database.ref(showPath(root, event.params.showId, "live/dance_window/dancerCount")).set(count);
      }
      return null;
    }
  );
}

function makeDanceWindowSpotlightScoring(namespacePrefix: string) {
  const root = namespaceRoot(namespacePrefix);
  return onValueWritten(
    { ref: `${root}/shows/{showId}/dance_window_control/{windowId}/spotlightFiredAt`, region: REGION },
    async (event: DatabaseEvent<Change<DataSnapshot>, SpotlightParams>) => {
      if (!event.data.after.exists() || event.data.before.exists()) return null;
      const firedAt = numberOrDefault(event.data.after.val(), Date.now());
      const database = admin.database();
      const [windowSnap, controlSnap] = await Promise.all([
        database.ref(showPath(root, event.params.showId, "live/dance_window")).get(),
        database.ref(showPath(root, event.params.showId, `dance_window_control/${event.params.windowId}`)).get(),
      ]);
      const publicWindow = windowSnap.val() as DanceWindowState | null;
      const controlWindow = controlSnap.val() as DanceWindowState | null;
      const window = publicWindow?.windowId === event.params.windowId ? publicWindow : controlWindow;
      if (!window?.windowId) return null;

      const entries = await activePresenceEntries(database, root, event.params.showId, firedAt);
      const awarded = await Promise.all(entries.map(([uid, presence]) =>
        awardWindowPoints({
          database,
          root,
          showId: event.params.showId,
          window,
          uid,
          presence,
          kind: "spotlight",
          points: SPOTLIGHT_POINTS,
          awardedAt: firedAt,
        })
      ));
      const awardedCount = awarded.filter(Boolean).length;

      await database.ref(showPath(root, event.params.showId, "live/dance_window/spotlight")).set({
        status: "fired",
        firedAt,
        dancerCount: entries.length,
        awardedCount,
        points: SPOTLIGHT_POINTS,
      });

      logger.info("Dance spotlight fired", {
        showId: event.params.showId,
        windowId: event.params.windowId,
        dancerCount: entries.length,
        awardedCount,
        namespacePrefix,
      });
      return null;
    }
  );
}

export const danceWindowOpenedScoring = makeDanceWindowOpenedScoring("");
export const danceWindowOpenedScoringTest = makeDanceWindowOpenedScoring("test");
export const dancePresenceScoring = makeDancePresenceScoring("");
export const dancePresenceScoringTest = makeDancePresenceScoring("test");
export const danceWindowSpotlightScoring = makeDanceWindowSpotlightScoring("");
export const danceWindowSpotlightScoringTest = makeDanceWindowSpotlightScoring("test");
