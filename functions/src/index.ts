import * as admin from "firebase-admin";

if (admin.apps.length === 0) {
  admin.initializeApp();
}

export { triviaScoring, triviaScoringTest } from "./scoring/triviaScoring";
export { dancingScoring, dancingScoringTest } from "./scoring/dancingScoring";
export { allTimeLeaderboard, allTimeLeaderboardTest } from "./scoring/allTimeLeaderboard";
export { teamScoring, teamScoringTest } from "./scoring/teamScoring";
