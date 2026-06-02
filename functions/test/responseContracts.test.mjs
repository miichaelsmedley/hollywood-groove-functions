import test from "node:test";
import assert from "node:assert/strict";
import contracts from "../lib/scoring/responseContracts.js";

const { getTriviaResponseKind, isTriviaResponsePayload } = contracts;

test("classifies every live trivia response contract without changing field names", () => {
  assert.equal(getTriviaResponseKind({ optionIndex: 2, answeredAt: 1 }), "choice");
  assert.equal(getTriviaResponseKind({ booleanValue: true, answeredAt: 1 }), "boolean");
  assert.equal(getTriviaResponseKind({ text: "Freddie Mercury", answeredAt: 1 }), "freeform");
  assert.equal(getTriviaResponseKind({ scaleValue: 7, answeredAt: 1 }), "scale");

  assert.equal(isTriviaResponsePayload({ optionIndex: 0, displayName: "Pat" }), true);
  assert.equal(isTriviaResponsePayload({ booleanValue: false, responseTime: 1200 }), true);
  assert.equal(isTriviaResponsePayload({ text: "Mercury" }), true);
  assert.equal(isTriviaResponsePayload({ scaleValue: 10 }), true);
});

test("keeps non-trivia response payloads out of trivia scoring", () => {
  assert.equal(getTriviaResponseKind(null), null);
  assert.equal(getTriviaResponseKind({}), null);
  assert.equal(getTriviaResponseKind({ claimed: true }), null);
  assert.equal(getTriviaResponseKind({ text: "   " }), null);
  assert.equal(getTriviaResponseKind({ optionIndex: Number.NaN }), null);
  assert.equal(getTriviaResponseKind({ booleanValue: "true" }), null);
  assert.equal(getTriviaResponseKind({ scaleValue: Infinity }), null);
});
