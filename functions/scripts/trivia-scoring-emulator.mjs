import assert from "node:assert/strict";
import admin from "firebase-admin";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "theta-inkwell-448908-g9";
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;
process.env.FIREBASE_DATABASE_EMULATOR_HOST =
  process.env.FIREBASE_DATABASE_EMULATOR_HOST || "127.0.0.1:9000";
delete process.env.OPENAI_API_KEY;

const databaseURL = `https://${projectId}-default-rtdb.asia-southeast1.firebasedatabase.app`;

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId, databaseURL });
}

const db = admin.database();
const showId = "p1_trivia_scoring";
const uid = "p1_attendee";
const skippedUid = "p1_skip_attendee";
const root = `test/shows/${showId}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, read, predicate, timeoutMs = 20000) {
  const startedAt = Date.now();
  let latest;

  while (Date.now() - startedAt < timeoutMs) {
    latest = await read();
    if (predicate(latest)) {
      return latest;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${label}. Latest value: ${JSON.stringify(latest)}`);
}

async function seedActivity(id, publicTrivia, privateTrivia) {
  await db.ref(`${root}/activities/${id}`).set({
    type: "trivia",
    title: id,
    trivia: publicTrivia,
  });

  if (privateTrivia !== undefined) {
    await db.ref(`${root}/activities_private/${id}`).set({
      trivia: privateTrivia,
    });
  }
}

async function seedResponse(activityId, attendeeId, response) {
  await db.ref(`${root}/responses/${activityId}/${attendeeId}`).set(response);
}

async function readResult(activityId, attendeeId = uid) {
  const snap = await db.ref(`${root}/results/${activityId}/${attendeeId}`).get();
  return snap.val();
}

function assertScored(kind, result) {
  assert.ok(result, `${kind} result should exist`);
  assert.notEqual(result.scored, false, `${kind} should not be marked skipped`);
  assert.ok(result.totalScore > 0, `${kind} should award a positive score`);
}

async function main() {
  const now = Date.now();
  await db.ref(root).remove();

  await db.ref(`${root}/settings`).set({
    trivia_base_points: 100,
    trivia_speed_bonus: 50,
    trivia_time_limit: 10,
    streak_mode: "disabled",
  });
  await db.ref(`${root}/attendees/${uid}`).set({
    display_name: "P1 Scoring",
    current_streak: 0,
    tier_at_checkin: "vip",
  });
  await db.ref(`${root}/attendees/${skippedUid}`).set({
    display_name: "P1 Skip",
    current_streak: 0,
  });

  await seedActivity(
    "multi",
    {
      kind: "multi",
      question: "What year was The Godfather released?",
      options: [
        { index: 0, text: "1970" },
        { index: 1, text: "1972" },
        { index: 2, text: "1974" },
        { index: 3, text: "1976" },
      ],
    },
    { correctOptionIndex: 1 }
  );
  await seedActivity(
    "boolean",
    {
      kind: "boolean",
      question: "The Oscars are held every year.",
      options: [
        { index: 0, text: "True" },
        { index: 1, text: "False" },
      ],
    },
    { correctOptionIndex: 0 }
  );
  await seedActivity(
    "freeform",
    {
      kind: "freeform",
      question: "Name the lead singer of Queen.",
    },
    { acceptableAnswers: ["Freddie Mercury"] }
  );
  await seedActivity(
    "scale",
    {
      kind: "scale",
      question: "How hyped are you right now?",
      scale: { min: 0, max: 10, step: 1 },
    },
    {}
  );
  await seedActivity(
    "missing_boolean",
    {
      kind: "boolean",
      question: "This question intentionally has no private answer.",
    },
    {}
  );
  await seedActivity(
    "missing_freeform",
    {
      kind: "freeform",
      question: "This question intentionally has no acceptable answers.",
    },
    {}
  );

  await seedResponse("multi", uid, {
    optionIndex: 1,
    answeredAt: now,
    responseTime: 1000,
    displayName: "P1 Scoring",
  });
  await seedResponse("boolean", uid, {
    booleanValue: true,
    answeredAt: now + 1,
    responseTime: 1000,
    displayName: "P1 Scoring",
  });
  await seedResponse("freeform", uid, {
    text: "Freddie Mercury",
    answeredAt: now + 2,
    responseTime: 1000,
    displayName: "P1 Scoring",
  });
  await seedResponse("scale", uid, {
    scaleValue: 7,
    answeredAt: now + 3,
    responseTime: 1000,
    displayName: "P1 Scoring",
  });
  await seedResponse("missing_boolean", skippedUid, {
    booleanValue: true,
    answeredAt: now + 4,
    responseTime: 1000,
    displayName: "P1 Skip",
  });
  await seedResponse("missing_freeform", skippedUid, {
    text: "Freddie Mercury",
    answeredAt: now + 5,
    responseTime: 1000,
    displayName: "P1 Skip",
  });

  const results = {};
  for (const kind of ["multi", "boolean", "freeform", "scale"]) {
    results[kind] = await waitFor(
      `${kind} scored result`,
      () => readResult(kind),
      (value) => Boolean(value && value.totalScore > 0 && value.scored !== false)
    );
    assertScored(kind, results[kind]);
  }

  const score = await waitFor(
    "running score total",
    async () => {
      const snap = await db.ref(`${root}/scores/${uid}`).get();
      return snap.val();
    },
    (value) => Boolean(value && value.totalScore > 0)
  );
  assert.ok(score.breakdown?.trivia > 0, "scoring should update trivia breakdown");

  const skippedBoolean = await waitFor(
    "missing boolean skipped result",
    () => readResult("missing_boolean", skippedUid),
    (value) => Boolean(value && value.scored === false)
  );
  assert.equal(skippedBoolean.reason, "missing_correctOptionIndex");
  assert.equal(skippedBoolean.totalScore, 0);

  const skippedFreeform = await waitFor(
    "missing freeform skipped result",
    () => readResult("missing_freeform", skippedUid),
    (value) => Boolean(value && value.scored === false)
  );
  assert.equal(skippedFreeform.reason, "missing_acceptableAnswers");
  assert.equal(skippedFreeform.totalScore, 0);

  const skippedScoreSnap = await db.ref(`${root}/scores/${skippedUid}`).get();
  assert.equal(skippedScoreSnap.exists(), false, "skipped responses must not create score totals");

  console.log("P1 trivia scoring emulator results:");
  for (const kind of ["multi", "boolean", "freeform", "scale"]) {
    console.log(`  ${kind} scored: totalScore=${results[kind].totalScore}`);
  }
  console.log(
    `  missing_boolean skipped: reason=${skippedBoolean.reason}, totalScore=${skippedBoolean.totalScore}`
  );
  console.log(
    `  missing_freeform skipped: reason=${skippedFreeform.reason}, totalScore=${skippedFreeform.totalScore}`
  );
  console.log(`  attendee totalScore=${score.totalScore}, triviaBreakdown=${score.breakdown.trivia}`);

  await db.ref(root).remove();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
