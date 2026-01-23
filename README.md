# Hollywood Groove — Firebase Cloud Functions

Cloud Functions (TypeScript) for scoring and engagement.

## Structure

- `firebase.json` points Functions source to `functions/`
- `functions/src/index.ts` exports the deployed functions
- `functions/src/scoring/triviaScoring.ts` scores trivia responses and updates results/scores/leaderboard
- `functions/src/scoring/dancingScoring.ts` scores dance claims and updates scores/leaderboard
- `functions/src/scoring/allTimeLeaderboard.ts` rebuilds the all-time leaderboard from member stars

## Local Setup

1. Install Firebase CLI (if not installed):
   - `npm install -g firebase-tools`
2. Login + select project:
   - `firebase login`
   - From `hollywood-groove-functions/`: `firebase use theta-inkwell-448908-g9` (optional; `.firebaserc` is included)
3. Install dependencies:
   - `cd functions`
   - `npm install`

## Run Emulator (optional)

From `functions/`:
- `npm run serve`

## Deploy

From `functions/`:
- `npm run deploy` (runs `npm run build` first)

Note: Deploying Cloud Functions generally requires the Firebase project to be on the Blaze plan.

## Test (Realtime Database)

The trivia scoring trigger is:

- `/shows/{showId}/responses/{activityId}/{odience}` (production)
- `/test/shows/{showId}/responses/{activityId}/{odience}` (test mode)

Minimal data required for a successful score:

1. `shows/{showId}/activities_private/{activityId}/trivia/correctOptionIndex` (number)
2. `shows/{showId}/settings` (optional; defaults used if missing)
3. `shows/{showId}/attendees/{odience}/current_streak` (optional; defaults to 0)
4. `shows/{showId}/responses/{activityId}/{odience}` written by the PWA:
   ```json
   {
     "optionIndex": 1,
     "answeredAt": 1735600207000,
     "displayName": "Jess",
     "responseTime": 3200
   }
   ```

Expected writes:

- `shows/{showId}/results/{activityId}/{odience}`
- `shows/{showId}/scores/{odience}`
- `shows/{showId}/leaderboard`

## Dancing Scoring (Realtime Database)

The dancing scoring trigger is:

- `/shows/{showId}/responses/{activityId}/{odience}` (production)
- `/test/shows/{showId}/responses/{activityId}/{odience}` (test mode)

Requires a response payload:
```json
{
  "type": "dance_claim",
  "claimedAt": 1735600207000,
  "displayName": "Jess"
}
```

Expected writes:

- `shows/{showId}/scores/{odience}` (adds dancing points)
- `shows/{showId}/leaderboard`

## All-Time Leaderboard (Realtime Database)

The all-time leaderboard trigger is:

- `/members/{odience}/stars/total` (production)
- `/test/members/{odience}/stars/total` (test mode)

Expected writes:

- `leaderboards/all_time`

Notes:
- The function ignores response updates (it scores the first write only).
- It also skips if a result already exists at `results/{activityId}/{odience}` (idempotency). For re-testing, delete the result node or use a new `odience`.
