import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../lib/scoring/responseContracts.js';

const {
  getTriviaResponseKind,
  isDanceClaimResponse,
  isTriviaResponsePayload,
} = contracts;

test('classifies every trivia response contract', () => {
  assert.equal(
    getTriviaResponseKind({ optionIndex: 1, answeredAt: 1, responseTime: 250, displayName: 'A' }),
    'choice'
  );
  assert.equal(
    getTriviaResponseKind({ booleanValue: false, answeredAt: 1, responseTime: 250, displayName: 'A' }),
    'boolean'
  );
  assert.equal(
    getTriviaResponseKind({ text: 'Freddie Mercury', answeredAt: 1, responseTime: 250, displayName: 'A' }),
    'freeform'
  );
  assert.equal(
    getTriviaResponseKind({ scaleValue: 7, answeredAt: 1, responseTime: 250, displayName: 'A' }),
    'scale'
  );
});

test('keeps non-trivia activity responses out of trivia scoring', () => {
  assert.equal(isTriviaResponsePayload({ type: 'dance_claim', claimedAt: 1, displayName: 'A' }), false);
  assert.equal(isTriviaResponsePayload({ action: 'join', joinedAt: 1, displayName: 'A' }), false);
  assert.equal(isTriviaResponsePayload({ optionText: 'Queen', votedAt: 1, displayName: 'A' }), false);
  assert.equal(isTriviaResponsePayload({ text: '   ', answeredAt: 1, displayName: 'A' }), false);
});

test('classifies dance claims and ignores other activity payloads', () => {
  assert.equal(isDanceClaimResponse({ type: 'dance_claim', claimedAt: 1, displayName: 'A' }), true);
  assert.equal(isDanceClaimResponse({ action: 'dance_claim', claimedAt: 1, displayName: 'A' }), true);
  assert.equal(isDanceClaimResponse({ action: 'join', joinedAt: 1, displayName: 'A' }), false);
  assert.equal(isDanceClaimResponse({ optionIndex: 0, optionText: 'Queen', votedAt: 1 }), false);
});
