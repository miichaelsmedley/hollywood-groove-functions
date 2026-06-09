import test from 'node:test';
import assert from 'node:assert/strict';
import scheduler from '../lib/scheduling/dailyTriviaScheduler.js';

const {
  createEmptyQuestionQualityStats,
  planDailyTriviaBackfillCandidates,
  validateQuestionForDailyScheduler,
} = scheduler;

function baseQuestion(overrides = {}) {
  return {
    active: true,
    category_id: 'music',
    question: 'Which clue points to this Hollywood Groove answer?',
    type: 'multiple_choice',
    options: [
      { index: 0, text: 'Melbourne' },
      { index: 1, text: 'Sydney' },
      { index: 2, text: 'Brisbane' },
      { index: 3, text: 'Perth' },
    ],
    correct_index: 0,
    ...overrides,
  };
}

test('daily scheduler accepts playable rich trivia types', () => {
  const imageStats = createEmptyQuestionQualityStats();
  assert.equal(
    validateQuestionForDailyScheduler(
      baseQuestion({ type: 'image_choice', image_url: 'https://example.com/still.jpg' }),
      imageStats
    ).isValid,
    true
  );

  const audioStats = createEmptyQuestionQualityStats();
  assert.equal(
    validateQuestionForDailyScheduler(
      baseQuestion({
        type: 'audio_clip',
        options: undefined,
        correct_index: undefined,
        audio_url: 'https://example.com/hook.mp3',
        correct_text: ['Bee Gees'],
      }),
      audioStats
    ).isValid,
    true
  );

  const mapStats = createEmptyQuestionQualityStats();
  assert.equal(
    validateQuestionForDailyScheduler(
      baseQuestion({
        type: 'map_guess_place',
        map_target: { lat: -37.8136, lng: 144.9631, label: 'Melbourne' },
        correct_text: 'Melbourne',
      }),
      mapStats
    ).isValid,
    true
  );
});

test('daily scheduler rejects rich trivia without required media', () => {
  const stats = createEmptyQuestionQualityStats();
  const result = validateQuestionForDailyScheduler(
    baseQuestion({
      type: 'audio_clip',
      correct_text: ['Bee Gees'],
    }),
    stats
  );

  assert.equal(result.isValid, false);
  assert.equal(stats.invalidMedia, 1);
});

test('autopilot plans backfill for missing and thin pools', () => {
  const candidates = planDailyTriviaBackfillCandidates({
    questionPools: [
      { categoryId: 'music', subcategory: 'pop', questionCount: 2 },
      { categoryId: 'movies', subcategory: null, questionCount: 4 },
    ],
    categoryPools: [
      { categoryId: 'music', subcategory: 'pop', questionCount: 0 },
      { categoryId: 'eighties', subcategory: null, questionCount: 0 },
    ],
    settings: {
      enabled: true,
      minQuestionsPerPool: 3,
      targetQuestionsPerPool: 8,
      batchSize: 5,
      model: 'test-model',
    },
  });

  assert.deepEqual(candidates, [
    { categoryId: 'eighties', subcategory: null, questionCount: 0, questionsNeeded: 5 },
    { categoryId: 'music', subcategory: 'pop', questionCount: 2, questionsNeeded: 5 },
  ]);
});
