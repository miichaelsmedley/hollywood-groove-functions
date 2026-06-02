# Firebase Trivia Contract

This file documents the trivia scoring contract used by the Hollywood Groove
Cloud Functions. It is intentionally scoped to the live response payload and
scoring paths. Do not rename, remove, or reinterpret response payload fields
without coordinating controller and PWA changes.

## Namespaces

Production shows use:

```text
shows/{showId}/...
```

Test-mode and emulator proofs use:

```text
test/shows/{showId}/...
```

The P1 scoring emulator writes only under:

```text
test/shows/p1_trivia_scoring
```

## Public Activity Data

Trivia activities are published under:

```text
shows/{showId}/activities/{activityId}
```

Public trivia fields:

| Field | Description |
| --- | --- |
| `type` | Must be `trivia` for trivia activities. |
| `title` | Operator-facing and audience-facing activity title. |
| `trivia.question` | Question text shown to attendees. |
| `trivia.kind` | One of `multi`, `boolean`, `freeform`, `scale`. |
| `trivia.durationSeconds` | Optional display/input duration. |
| `trivia.options` | Required for `multi`; optional display labels for `boolean`. |
| `trivia.scale` | Optional scale config for `scale`: `{ min, max, step }`. |
| `trivia.image` | Optional `{ mimeType, base64 }` image payload. |

## Private Scoring Data

Private answer data is stored under:

```text
shows/{showId}/activities_private/{activityId}/trivia
```

| Trivia kind | Required private data | Notes |
| --- | --- | --- |
| `multi` | `correctOptionIndex` | Correct response `optionIndex` receives base points, speed bonus, and streak scoring. |
| `boolean` | `correctOptionIndex` | `booleanValue: true` maps to index `0`; `booleanValue: false` maps to index `1`. |
| `freeform` | `acceptableAnswers` | Array of accepted answers for OpenAI scoring or no-key normalized fallback matching. |
| `scale` | None | Uses public `trivia.scale` range when present; defaults to 0-10. |

## Response Payload

Attendee responses are written under:

```text
shows/{showId}/responses/{activityId}/{odience}
```

The response payload contract is:

| Field | Used by | Description |
| --- | --- | --- |
| `optionIndex` | `multi` | Selected option index. |
| `booleanValue` | `boolean` | `true` maps to option index `0`; `false` maps to option index `1`. |
| `scaleValue` | `scale` | Numeric slider value. |
| `text` | `freeform` | Freeform answer text. |
| `answeredAt` | all trivia | Client answer timestamp. |
| `responseTime` | choice trivia | Milliseconds elapsed since question start, used for speed bonus. |
| `displayName` | scores | Display name copied into running score totals when needed. |

Do not change these field names as part of scoring-only work.

## Scored Results

Successfully scored responses write public per-question results under:

```text
shows/{showId}/results/{activityId}/{odience}
```

Shape:

```json
{
  "isCorrect": true,
  "baseScore": 100,
  "speedBonus": 45,
  "streakMultiplier": 1.2,
  "totalScore": 174,
  "answeredAt": 1710000000000
}
```

Running totals are written under:

```text
shows/{showId}/scores/{odience}
```

Leaderboard data is rebuilt under:

```text
shows/{showId}/leaderboard
```

## Skip Diagnostics

Misconfigured activities do not write public `results` and do not create or
update `scores`. Instead, the scorer writes an operator diagnostic under:

```text
shows/{showId}/scoring_diagnostics/{activityId}/{odience}
```

Shape:

```json
{
  "scored": false,
  "reason": "missing_correctOptionIndex",
  "answeredAt": 1710000000000
}
```

Allowed `reason` values:

| Reason | Applies to |
| --- | --- |
| `missing_correctOptionIndex` | `multi` or `boolean` without private `correctOptionIndex`. |
| `missing_acceptableAnswers` | `freeform` without private `acceptableAnswers`. |

Production RTDB rules should keep `scoring_diagnostics` admin-readable only. The
emulator rules in this repo are permissive only for local regression testing.

## Scoring Rules

- `multi`: compares `optionIndex` to private `correctOptionIndex`; correct
  answers receive base points plus speed bonus and participate in streak scoring.
- `boolean`: maps `booleanValue` to option index `0` or `1`, then uses the same
  choice scoring path as `multi`.
- `freeform`: requires private `acceptableAnswers`; uses the OpenAI scorer when
  `OPENAI_API_KEY` is present, otherwise exact normalized fallback matching.
  Freeform awards proportional base points and participates in streak scoring.
- `scale`: awards proportional base points across the configured or default
  range. Scale responses do not require private answer data and do not affect
  streaks or speed bonus.

Scoring is create-only. Response updates are ignored, and an existing public
result prevents duplicate scoring. If an operator fixes private answer data after
attendees have already answered, those earlier answers are not automatically
rescored; the P0 readiness preflight is expected to catch missing scoring data
before an activity goes live.
