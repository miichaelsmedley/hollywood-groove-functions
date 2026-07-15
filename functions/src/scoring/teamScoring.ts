import * as admin from "firebase-admin";
import { onValueWritten, DataSnapshot, DatabaseEvent } from "firebase-functions/v2/database";
import { Change } from "firebase-functions/common";
import { logger } from "firebase-functions/v2";
import { scheduleDebouncedLeaderboardRebuild } from "./leaderboardDebounce";

/**
 * Team Scoring Cloud Function
 *
 * Triggers when an individual score is updated and recalculates the team score.
 * Uses "top N contributors" scoring where only the top N member scores count
 * towards the team's combined score.
 */

type UserScore = {
  displayName?: string;
  totalScore?: number;
  tier?: string | null;
};

type TeamInfo = {
  team_id: string;
  team_name: string;
  role: "owner" | "member";
};

type Team = {
  name: string;
  settings?: {
    top_contributors?: number;
    max_members?: number;
  };
};

type TeamMember = {
  display_name: string;
  role: "owner" | "member";
};

type TeamShowScore = {
  team_name: string;
  combined_score: number;
  member_scores: Record<string, { display_name: string; score: number }>;
  contributing_members: string[];
  updated_at: number;
};

type TeamLeaderboardEntry = {
  team_id: string;
  team_name: string;
  combined_score: number;
  member_count: number;
  rank?: number;
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

type TeamScoringParams = { showId: string; odience: string };

function makeTeamScoring(namespacePrefix: string) {
  const normalizedPrefix = normalizeNamespacePrefix(namespacePrefix);
  const root = namespaceRoot(normalizedPrefix);

  const showPath = (showId: string, path: string): string => {
    const trimmed = path.replace(/^\/+/, "");
    return `${root}/shows/${showId}/${trimmed}`;
  };

  const memberPath = (uid: string): string => {
    return `${root}/members/${uid}/current_team`;
  };

  const teamPath = (teamId: string, path: string): string => {
    const trimmed = path.replace(/^\/+/, "");
    return `${root}/teams/${teamId}/${trimmed}`;
  };

  return onValueWritten(
    { ref: `${root}/shows/{showId}/scores/{odience}`, region: "asia-southeast1" },
    async (event: DatabaseEvent<Change<DataSnapshot>, TeamScoringParams>) => {
      const { showId, odience } = event.params;
      const change = event.data;

      // Only process if score exists
      if (!change.after.exists()) {
        return null;
      }

      const database = admin.database();

      // 1. Check if user has a team
      const memberTeamSnap = await database.ref(memberPath(odience)).get();
      if (!memberTeamSnap.exists()) {
        // User not in a team, nothing to update
        return null;
      }

      const teamInfo = memberTeamSnap.val() as TeamInfo | null;
      if (!teamInfo?.team_id) {
        return null;
      }

      const teamId = teamInfo.team_id;

      // 2. Get team settings
      const teamSnap = await database.ref(teamPath(teamId, "")).get();
      if (!teamSnap.exists()) {
        logger.warn("Team not found", { teamId, odience, showId, namespacePrefix: normalizedPrefix });
        return null;
      }

      const team = teamSnap.val() as Team | null;
      if (!team) {
        return null;
      }

      const topN = intOrDefault(team.settings?.top_contributors, 5);

      // 3. Get all team members
      const membersSnap = await database.ref(teamPath(teamId, "members")).get();
      const members = (membersSnap.val() as Record<string, TeamMember> | null) ?? {};
      const memberUids = Object.keys(members);

      if (memberUids.length === 0) {
        return null;
      }

      // 4. Get all members' scores for this show
      const memberScores: Record<string, { display_name: string; score: number }> = {};

      // Fetch all member scores in parallel
      const scorePromises = memberUids.map(async (memberUid) => {
        const scoreSnap = await database.ref(showPath(showId, `scores/${memberUid}`)).get();
        const scoreData = scoreSnap.val() as UserScore | null;

        if (scoreData) {
          return {
            uid: memberUid,
            display_name: scoreData.displayName ?? members[memberUid]?.display_name ?? "Guest",
            score: intOrDefault(scoreData.totalScore, 0),
          };
        }
        return null;
      });

      const scoreResults = await Promise.all(scorePromises);

      for (const result of scoreResults) {
        if (result) {
          memberScores[result.uid] = {
            display_name: result.display_name,
            score: result.score,
          };
        }
      }

      // 5. Calculate top N combined score
      const sortedScores = Object.entries(memberScores)
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, topN);

      const combinedScore = sortedScores.reduce((sum, [, data]) => sum + data.score, 0);
      const contributingMembers = sortedScores.map(([uid]) => uid);

      // 6. Write team score for this show
      const teamScore: TeamShowScore = {
        team_name: team.name,
        combined_score: combinedScore,
        member_scores: memberScores,
        contributing_members: contributingMembers,
        updated_at: Date.now(),
      };

      await database.ref(showPath(showId, `team_scores/${teamId}`)).set(teamScore);

      logger.info("Team score updated", {
        teamId,
        showId,
        combinedScore,
        contributingMembers: contributingMembers.length,
        totalMembers: memberUids.length,
        namespacePrefix: normalizedPrefix,
      });

      // 7. Coalesce team leaderboard rebuilds across score bursts.
      await scheduleDebouncedLeaderboardRebuild({
        database,
        showId,
        root,
        kind: "team_leaderboard",
        reason: "team_score",
        rebuild: () => updateTeamLeaderboard(database, showId, root),
      });

      return null;
    }
  );
}

/**
 * Rebuilds the team leaderboard for a show.
 * Gets all team scores and sorts by combined score.
 */
async function updateTeamLeaderboard(
  database: admin.database.Database,
  showId: string,
  root: string
): Promise<void> {
  const showPath = (path: string): string => {
    const trimmed = path.replace(/^\/+/, "");
    return `${root}/shows/${showId}/${trimmed}`;
  };

  const teamScoresSnap = await database.ref(showPath("team_scores")).get();
  const teamScores = (teamScoresSnap.val() as Record<string, TeamShowScore> | null) ?? {};

  const entries: TeamLeaderboardEntry[] = Object.entries(teamScores)
    .map(([teamId, data]) => ({
      team_id: teamId,
      team_name: data.team_name ?? "Unknown Team",
      combined_score: intOrDefault(data.combined_score, 0),
      member_count: Object.keys(data.member_scores ?? {}).length,
    }))
    .sort((a, b) => b.combined_score - a.combined_score)
    .slice(0, 50); // Top 50 teams

  // Add ranks
  entries.forEach((entry, i) => {
    entry.rank = i + 1;
  });

  await database.ref(showPath("team_leaderboard")).set({
    top: entries,
    updated_at: admin.database.ServerValue.TIMESTAMP,
  });

  logger.info("Team leaderboard updated", {
    showId,
    teamCount: entries.length,
    root,
  });
}

// Production function (no prefix)
export const teamScoring = makeTeamScoring("");

// Test function (test/ prefix)
export const teamScoringTest = makeTeamScoring("test");
