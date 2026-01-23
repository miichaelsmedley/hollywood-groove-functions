import * as admin from "firebase-admin";
import { onValueWritten, DataSnapshot, DatabaseEvent } from "firebase-functions/v2/database";
import { Change } from "firebase-functions/common";
import { logger } from "firebase-functions/v2";

type MemberRecord = {
  display_name?: string;
  stars?: {
    total?: number;
    tier?: string;
  };
};

function intOrDefault(value: unknown, defaultValue: number): number {
  const asNumber = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(asNumber)) return defaultValue;
  return Math.trunc(asNumber);
}

function normalizeNamespacePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed;
}

function namespaceRoot(prefix: string): string {
  const normalized = normalizeNamespacePrefix(prefix);
  return normalized.length > 0 ? `/${normalized}` : "";
}

type LeaderboardParams = { odience: string };

function makeAllTimeLeaderboard(namespacePrefix: string) {
  const normalizedPrefix = normalizeNamespacePrefix(namespacePrefix);
  const root = namespaceRoot(normalizedPrefix);

  const rootPath = (path: string): string => {
    const trimmed = path.replace(/^\/+/, "");
    return `${root}/${trimmed}`;
  };

  return onValueWritten(
    { ref: `${root}/members/{odience}/stars/total`, region: "asia-southeast1" },
    async (_event: DatabaseEvent<Change<DataSnapshot>, LeaderboardParams>) => {
      const database = admin.database();

      const membersSnap = await database
        .ref(rootPath("members"))
        .orderByChild("stars/total")
        .limitToLast(50)
        .get();

      const membersValue = (membersSnap.val() as Record<string, MemberRecord> | null) ?? {};
      const top = Object.entries(membersValue)
        .map(([memberId, member]) => ({
          member_id: memberId,
          display_name: member.display_name ?? "Guest",
          stars: intOrDefault(member?.stars?.total, 0),
          tier: member?.stars?.tier ?? null,
        }))
        .sort((a, b) => b.stars - a.stars)
        .slice(0, 50);

      await database.ref(rootPath("leaderboards/all_time")).set({
        updatedAt: admin.database.ServerValue.TIMESTAMP,
        top,
      });

      logger.info("All-time leaderboard rebuilt", {
        count: top.length,
        namespacePrefix: normalizedPrefix,
      });

      return null;
    }
  );
}

export const allTimeLeaderboard = makeAllTimeLeaderboard("");
export const allTimeLeaderboardTest = makeAllTimeLeaderboard("test");
