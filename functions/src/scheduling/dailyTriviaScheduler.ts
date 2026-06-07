import * as admin from "firebase-admin";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";

const REGION = "asia-southeast1";
const SCHEDULE_CRON = "5 0 * * *"; // 00:05 every day
const AUTOPILOT_CRON = "15 0 * * *"; // 00:15 every day, after schedule refresh
const DEFAULT_TIMEZONE = "Australia/Melbourne";
const SCHEDULE_HORIZON_DAYS = 7;
const MIN_QUESTIONS_PER_POOL = 3;
const DEFAULT_AUTOPILOT_TARGET_QUESTIONS_PER_POOL = 8;
const DEFAULT_AUTOPILOT_BATCH_SIZE = 5;
const MAX_AUTOPILOT_POOLS_PER_RUN = 3;
const MIN_QUESTION_LENGTH = 12;
const MIN_DURATION_SECONDS = 30;
const GENERATOR_VERSION = "daily-trivia-scheduler-v1";
const AUTOPILOT_VERSION = "daily-trivia-autopilot-v1";
const DEFAULT_AUTOPILOT_MODEL = "gpt-4o-mini";

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type CategoryMetadata = {
  name: string;
  description: string | null;
};

type PoolCandidate = {
  categoryId: string;
  subcategory: string | null;
  questionCount: number;
};

type QuestionValidationResult = {
  isValid: boolean;
  categoryId: string | null;
  subcategory: string | null;
};

type QuestionQualityStats = {
  total: number;
  valid: number;
  inactive: number;
  missingCategory: number;
  shortQuestion: number;
  invalidOptions: number;
  invalidCorrectAnswer: number;
  invalidMedia: number;
  unsupportedType: number;
  shortDuration: number;
};

type AutopilotSettings = {
  enabled: boolean;
  minQuestionsPerPool: number;
  targetQuestionsPerPool: number;
  batchSize: number;
  model: string;
};

export type DailyTriviaBackfillCandidate = {
  categoryId: string;
  subcategory: string | null;
  questionCount: number;
  questionsNeeded: number;
};

type GeneratedQuestion = {
  question: string;
  options: string[];
  correct_index: number;
  difficulty?: string;
  explanation?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeIntArray(value: unknown): number[] {
  return toStableArray<unknown>(value)
    .map((item) => {
      if (typeof item === "number" && Number.isInteger(item)) {
        return item;
      }
      if (typeof item === "string") {
        const parsed = Number(item);
        return Number.isInteger(parsed) ? parsed : null;
      }
      return null;
    })
    .filter((item): item is number => item !== null);
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    const normalized = normalizeString(value);
    return normalized ? [normalized] : [];
  }

  return toStableArray<unknown>(value)
    .map(normalizeString)
    .filter((item): item is string => item !== null);
}

function extractDateParts(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  let year = 0;
  let month = 0;
  let day = 0;

  for (const part of formatter.formatToParts(date)) {
    if (part.type === "year") year = Number(part.value);
    if (part.type === "month") month = Number(part.value);
    if (part.type === "day") day = Number(part.value);
  }

  if (!year || !month || !day) {
    throw new Error(`Could not resolve date parts for timezone ${timeZone}`);
  }

  return { year, month, day };
}

function formatDateKey(date: Date, timeZone: string): string {
  const parts = extractDateParts(date, timeZone);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

function getTodayAnchor(timeZone: string): Date {
  const today = extractDateParts(new Date(), timeZone);
  // Noon UTC avoids edge-cases around timezone transitions.
  return new Date(Date.UTC(today.year, today.month - 1, today.day, 12, 0, 0));
}

function buildDateWindow(timeZone: string, days: number): string[] {
  const anchor = getTodayAnchor(timeZone);
  const keys: string[] = [];

  for (let index = 0; index < days; index += 1) {
    const date = new Date(anchor);
    date.setUTCDate(anchor.getUTCDate() + index);
    keys.push(formatDateKey(date, timeZone));
  }

  return keys;
}

function toStableArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (!isRecord(value)) {
    return [];
  }

  const keys = Object.keys(value).sort((left, right) => {
    const leftNumeric = Number(left);
    const rightNumeric = Number(right);
    if (Number.isFinite(leftNumeric) && Number.isFinite(rightNumeric)) {
      return leftNumeric - rightNumeric;
    }
    return left.localeCompare(right);
  });

  return keys.map((key) => value[key] as T);
}

function normalizeOptions(value: unknown): Array<{ index: number; text: string }> {
  const options = toStableArray<unknown>(value);
  const normalized: Array<{ index: number; text: string }> = [];

  for (let position = 0; position < options.length; position += 1) {
    const option = options[position];
    if (!isRecord(option)) {
      continue;
    }

    const text = normalizeString(option.text);
    if (!text) {
      continue;
    }

    const explicitIndex = option.index;
    const index = typeof explicitIndex === "number" && Number.isInteger(explicitIndex)
      ? explicitIndex
      : position;

    normalized.push({ index, text });
  }

  return normalized;
}

function resolveDurationSeconds(question: Record<string, unknown>): number | null {
  const snakeCase = question.duration_seconds;
  if (typeof snakeCase === "number" && Number.isFinite(snakeCase)) {
    return Math.trunc(snakeCase);
  }

  const camelCase = question.durationSeconds;
  if (typeof camelCase === "number" && Number.isFinite(camelCase)) {
    return Math.trunc(camelCase);
  }

  return null;
}

function normalizeQuestionType(question: Record<string, unknown>): string {
  return (normalizeString(question.type) ?? "multiple_choice").toLowerCase();
}

function hasValidImageUrl(question: Record<string, unknown>): boolean {
  return normalizeString(question.image_url) !== null;
}

function hasValidAudioUrl(question: Record<string, unknown>): boolean {
  return normalizeString(question.audio_url) !== null || normalizeString(question.media_url) !== null;
}

function hasValidMapTarget(question: Record<string, unknown>): boolean {
  const target = asRecord(question.map_target);
  const lat = normalizeNumber(target.lat);
  const lng = normalizeNumber(target.lng);
  return lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function hasValidImageHotspot(question: Record<string, unknown>): boolean {
  const hotspot = asRecord(question.image_hotspot);
  const x = normalizeNumber(hotspot.x);
  const y = normalizeNumber(hotspot.y);
  return x !== null && y !== null && x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

function hasValidOptions(options: Array<{ index: number; text: string }>): boolean {
  if (options.length < 2) {
    return false;
  }

  const uniqueOptionCount = new Set(
    options.map((option) => option.text.toLowerCase())
  ).size;
  return uniqueOptionCount >= 2;
}

function hasValidCorrectIndex(
  question: Record<string, unknown>,
  options: Array<{ index: number; text: string }>
): boolean {
  const correctIndex = question.correct_index;
  return typeof correctIndex === "number" &&
    Number.isInteger(correctIndex) &&
    options.some((option) => option.index === correctIndex);
}

function hasValidCorrectIndices(
  question: Record<string, unknown>,
  options: Array<{ index: number; text: string }>
): boolean {
  const indices = normalizeIntArray(question.correct_indices);
  if (indices.length === 0) {
    return false;
  }
  const optionIndices = new Set(options.map((option) => option.index));
  return indices.every((index) => optionIndices.has(index));
}

function hasValidCorrectText(question: Record<string, unknown>): boolean {
  return normalizeStringArray(question.correct_text).length > 0;
}

function hasValidNumericAnswer(question: Record<string, unknown>): boolean {
  const answer = normalizeNumber(question.numeric_answer);
  const tolerance = normalizeNumber(question.numeric_tolerance);
  return answer !== null && (tolerance === null || tolerance >= 0);
}

function hasValidCorrectOrder(
  question: Record<string, unknown>,
  options: Array<{ index: number; text: string }>
): boolean {
  const order = normalizeIntArray(question.correct_order);
  const optionIndices = [...new Set(options.map((option) => option.index))].sort((left, right) => left - right);
  const ordered = [...order].sort((left, right) => left - right);
  return order.length === optionIndices.length &&
    ordered.every((value, index) => value === optionIndices[index]);
}

function hasPlayableAnswer(
  question: Record<string, unknown>,
  options: Array<{ index: number; text: string }>
): boolean {
  return (hasValidOptions(options) && hasValidCorrectIndex(question, options)) ||
    hasValidCorrectText(question) ||
    hasValidNumericAnswer(question);
}

function validateTypeSpecificFields(
  type: string,
  question: Record<string, unknown>,
  options: Array<{ index: number; text: string }>,
  stats: QuestionQualityStats
): boolean {
  switch (type) {
  case "multiple_choice":
  case "image_reveal":
  case "true_false":
    if (!hasValidOptions(options)) {
      stats.invalidOptions += 1;
      return false;
    }
    if (!hasValidCorrectIndex(question, options)) {
      stats.invalidCorrectAnswer += 1;
      return false;
    }
    return true;

  case "image_choice":
  case "mixed_image_faces":
  case "guess_person":
    if (!hasValidImageUrl(question)) {
      stats.invalidMedia += 1;
      return false;
    }
    if (!hasValidOptions(options)) {
      stats.invalidOptions += 1;
      return false;
    }
    if (!hasValidCorrectIndex(question, options)) {
      stats.invalidCorrectAnswer += 1;
      return false;
    }
    return true;

  case "multi_select":
    if (!hasValidOptions(options)) {
      stats.invalidOptions += 1;
      return false;
    }
    if (!hasValidCorrectIndices(question, options)) {
      stats.invalidCorrectAnswer += 1;
      return false;
    }
    return true;

  case "ordering":
    if (!hasValidOptions(options)) {
      stats.invalidOptions += 1;
      return false;
    }
    if (!hasValidCorrectOrder(question, options)) {
      stats.invalidCorrectAnswer += 1;
      return false;
    }
    return true;

  case "type_answer":
  case "lyric_completion":
    if (!hasValidCorrectText(question)) {
      stats.invalidCorrectAnswer += 1;
      return false;
    }
    return true;

  case "closest_number":
    if (!hasValidNumericAnswer(question)) {
      stats.invalidCorrectAnswer += 1;
      return false;
    }
    return true;

  case "audio_clip":
    if (!hasValidAudioUrl(question)) {
      stats.invalidMedia += 1;
      return false;
    }
    if (!hasPlayableAnswer(question, options)) {
      stats.invalidCorrectAnswer += 1;
      return false;
    }
    return true;

  case "map_guess_place":
    if (!hasValidMapTarget(question)) {
      stats.invalidMedia += 1;
      return false;
    }
    if (!hasPlayableAnswer(question, options)) {
      stats.invalidCorrectAnswer += 1;
      return false;
    }
    return true;

  case "pin_on_image":
    if (!hasValidImageUrl(question) || !hasValidImageHotspot(question)) {
      stats.invalidMedia += 1;
      return false;
    }
    if (!hasPlayableAnswer(question, options)) {
      stats.invalidCorrectAnswer += 1;
      return false;
    }
    return true;

  default:
    stats.unsupportedType += 1;
    return false;
  }
}

export function validateQuestionForDailyScheduler(
  question: Record<string, unknown>,
  stats: QuestionQualityStats
): QuestionValidationResult {
  stats.total += 1;

  if (question.active !== true) {
    stats.inactive += 1;
    return { isValid: false, categoryId: null, subcategory: null };
  }

  const categoryId = normalizeString(question.category_id);
  if (!categoryId) {
    stats.missingCategory += 1;
    return { isValid: false, categoryId: null, subcategory: null };
  }

  const questionText = normalizeString(question.question);
  if (!questionText || questionText.length < MIN_QUESTION_LENGTH) {
    stats.shortQuestion += 1;
    return { isValid: false, categoryId: null, subcategory: null };
  }

  const options = normalizeOptions(question.options);
  const type = normalizeQuestionType(question);
  if (!validateTypeSpecificFields(type, question, options, stats)) {
    return { isValid: false, categoryId: null, subcategory: null };
  }

  const durationSeconds = resolveDurationSeconds(question);
  if (durationSeconds !== null && durationSeconds < MIN_DURATION_SECONDS) {
    stats.shortDuration += 1;
    return { isValid: false, categoryId: null, subcategory: null };
  }

  stats.valid += 1;
  return {
    isValid: true,
    categoryId,
    subcategory: normalizeString(question.subcategory),
  };
}

function poolKey(categoryId: string, subcategory: string | null): string {
  return `${categoryId}::${subcategory ?? ""}`;
}

export function createEmptyQuestionQualityStats(): QuestionQualityStats {
  return {
    total: 0,
    valid: 0,
    inactive: 0,
    missingCategory: 0,
    shortQuestion: 0,
    invalidOptions: 0,
    invalidCorrectAnswer: 0,
    invalidMedia: 0,
    unsupportedType: 0,
    shortDuration: 0,
  };
}

export function collectQuestionPoolCounts(questionsValue: unknown): {
  pools: PoolCandidate[];
  stats: QuestionQualityStats;
} {
  const stats = createEmptyQuestionQualityStats();
  const poolCounts = new Map<string, PoolCandidate>();
  const records = Object.values(asRecord(questionsValue));

  for (const record of records) {
    if (!isRecord(record)) {
      continue;
    }

    const validation = validateQuestionForDailyScheduler(record, stats);
    if (!validation.isValid || !validation.categoryId) {
      continue;
    }

    const key = poolKey(validation.categoryId, validation.subcategory);
    const existing = poolCounts.get(key);
    if (existing) {
      existing.questionCount += 1;
      continue;
    }

    poolCounts.set(key, {
      categoryId: validation.categoryId,
      subcategory: validation.subcategory,
      questionCount: 1,
    });
  }

  const sortedPools = Array.from(poolCounts.values()).sort((left, right) => {
    if (left.categoryId === right.categoryId) {
      return (left.subcategory ?? "").localeCompare(right.subcategory ?? "");
    }
    return left.categoryId.localeCompare(right.categoryId);
  });

  return { pools: sortedPools, stats };
}

function buildQuestionPools(questionsValue: unknown): {
  pools: PoolCandidate[];
  stats: QuestionQualityStats;
  usedFallbackPools: boolean;
} {
  const { pools: sortedPools, stats } = collectQuestionPoolCounts(questionsValue);

  const eligible = sortedPools.filter((pool) => pool.questionCount >= MIN_QUESTIONS_PER_POOL);
  if (eligible.length > 0) {
    return {
      pools: eligible,
      stats,
      usedFallbackPools: false,
    };
  }

  // Fallback allows scheduling to continue if data volume is still low.
  return {
    pools: sortedPools,
    stats,
    usedFallbackPools: true,
  };
}

function readCategoryMetadata(
  categoriesValue: unknown,
  categoryId: string
): CategoryMetadata {
  const categories = asRecord(categoriesValue);
  const category = asRecord(categories[categoryId]);
  const name = normalizeString(category.name) ?? categoryId;
  const description = normalizeString(category.description);
  return { name, description };
}

function resolveAutopilotSettings(settingsValue: unknown): AutopilotSettings {
  const settings = asRecord(settingsValue);
  return {
    enabled: normalizeBoolean(settings.ai_autopilot_enabled ?? settings.aiAutopilotEnabled, false),
    minQuestionsPerPool: normalizePositiveInt(
      settings.ai_min_questions_per_pool ?? settings.aiMinQuestionsPerPool,
      MIN_QUESTIONS_PER_POOL
    ),
    targetQuestionsPerPool: normalizePositiveInt(
      settings.ai_target_questions_per_pool ?? settings.aiTargetQuestionsPerPool,
      DEFAULT_AUTOPILOT_TARGET_QUESTIONS_PER_POOL
    ),
    batchSize: normalizePositiveInt(
      settings.ai_batch_size ?? settings.aiBatchSize,
      DEFAULT_AUTOPILOT_BATCH_SIZE
    ),
    model: normalizeString(settings.ai_model ?? settings.aiModel) ?? DEFAULT_AUTOPILOT_MODEL,
  };
}

function collectCategoryPools(categoriesValue: unknown): PoolCandidate[] {
  const categories = asRecord(categoriesValue);
  const pools: PoolCandidate[] = [];

  for (const [categoryId, rawCategory] of Object.entries(categories)) {
    const category = asRecord(rawCategory);
    const subcategories = normalizeStringArray(category.subcategories);
    if (subcategories.length === 0) {
      pools.push({ categoryId, subcategory: null, questionCount: 0 });
      continue;
    }

    for (const subcategory of subcategories) {
      pools.push({ categoryId, subcategory, questionCount: 0 });
    }
  }

  return pools.sort((left, right) => {
    if (left.categoryId === right.categoryId) {
      return (left.subcategory ?? "").localeCompare(right.subcategory ?? "");
    }
    return left.categoryId.localeCompare(right.categoryId);
  });
}

export function planDailyTriviaBackfillCandidates(params: {
  questionPools: PoolCandidate[];
  categoryPools: PoolCandidate[];
  settings: AutopilotSettings;
}): DailyTriviaBackfillCandidate[] {
  const poolsByKey = new Map<string, PoolCandidate>();

  for (const pool of params.categoryPools) {
    poolsByKey.set(poolKey(pool.categoryId, pool.subcategory), { ...pool });
  }

  for (const pool of params.questionPools) {
    poolsByKey.set(poolKey(pool.categoryId, pool.subcategory), { ...pool });
  }

  return Array.from(poolsByKey.values())
    .filter((pool) => pool.questionCount < params.settings.minQuestionsPerPool)
    .map((pool) => ({
      categoryId: pool.categoryId,
      subcategory: pool.subcategory,
      questionCount: pool.questionCount,
      questionsNeeded: Math.max(
        1,
        Math.min(
          params.settings.batchSize,
          params.settings.targetQuestionsPerPool - pool.questionCount
        )
      ),
    }))
    .sort((left, right) => {
      if (left.questionCount !== right.questionCount) {
        return left.questionCount - right.questionCount;
      }
      if (left.categoryId === right.categoryId) {
        return (left.subcategory ?? "").localeCompare(right.subcategory ?? "");
      }
      return left.categoryId.localeCompare(right.categoryId);
    })
    .slice(0, MAX_AUTOPILOT_POOLS_PER_RUN);
}

function buildThemeName(categoryName: string, subcategory: string | null): string {
  if (subcategory) {
    return `${categoryName}: ${subcategory}`;
  }
  return `${categoryName} Spotlight`;
}

function buildDescription(
  categoryName: string,
  categoryDescription: string | null,
  subcategory: string | null
): string {
  if (subcategory) {
    return `Today's trivia comes from ${subcategory} in ${categoryName}.`;
  }
  if (categoryDescription) {
    return categoryDescription;
  }
  return `Today's trivia theme is ${categoryName}.`;
}

function dateKeyToOrdinal(dateKey: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    let hash = 0;
    for (const character of dateKey) {
      hash = (hash * 31 + character.charCodeAt(0)) | 0;
    }
    return hash;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function resolvePoolForDate(dateKey: string, pools: PoolCandidate[]): PoolCandidate {
  const ordinal = dateKeyToOrdinal(dateKey);
  const index = modulo(ordinal, pools.length);
  return pools[index];
}

function isManualSchedule(existingValue: unknown): boolean {
  if (!isRecord(existingValue)) {
    return false;
  }

  const source = normalizeString(existingValue.source);
  if (!source) {
    // Existing records without explicit source are treated as manual/admin-created.
    return true;
  }

  return source.toLowerCase() !== "auto";
}

function sanitizeKeyPart(value: string | null): string {
  return (value ?? "general")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "general";
}

function requestIdForCandidate(candidate: DailyTriviaBackfillCandidate): string {
  return `${sanitizeKeyPart(candidate.categoryId)}_${sanitizeKeyPart(candidate.subcategory)}`;
}

function buildAutopilotPrompt(params: {
  candidate: DailyTriviaBackfillCandidate;
  category: CategoryMetadata;
  count: number;
}): string {
  const subcategoryLine = params.candidate.subcategory
    ? `Subcategory: ${params.candidate.subcategory}`
    : "Subcategory: general";

  return [
    "Generate daily entertainment trivia for Hollywood Groove between-show engagement.",
    `Category: ${params.category.name}`,
    subcategoryLine,
    `Category description: ${params.category.description ?? "Music, movies, and live entertainment"}`,
    `Question count: ${params.count}`,
    "",
    "Rules:",
    "- Return valid JSON only.",
    "- Make questions fun, accessible, family-friendly, and suitable for a live music/movie audience.",
    "- Use exactly 4 options per question.",
    "- correct_index is zero based.",
    "- difficulty must be easy, medium, or hard.",
    "- Include a short explanation.",
    "",
    "JSON format:",
    "[{\"question\":\"...\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"correct_index\":0,\"difficulty\":\"easy\",\"explanation\":\"...\"}]",
  ].join("\n");
}

function extractJsonArray(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end <= start) {
    throw new Error("AI response did not contain a JSON array");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

function normalizeGeneratedQuestions(value: unknown): GeneratedQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const questions: GeneratedQuestion[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const question = normalizeString(item.question);
    const options = normalizeStringArray(item.options);
    const correctIndexRaw = item.correct_index ?? item.correctIndex;
    const correctIndex = typeof correctIndexRaw === "number" && Number.isInteger(correctIndexRaw)
      ? correctIndexRaw
      : null;
    const difficulty = normalizeString(item.difficulty) ?? "medium";

    if (!question || options.length !== 4 || correctIndex === null || correctIndex < 0 || correctIndex > 3) {
      continue;
    }

    questions.push({
      question,
      options,
      correct_index: correctIndex,
      difficulty: ["easy", "medium", "hard"].includes(difficulty) ? difficulty : "medium",
      explanation: normalizeString(item.explanation) ?? undefined,
    });
  }

  return questions;
}

async function generateQuestionsWithOpenAI(params: {
  apiKey: string;
  model: string;
  candidate: DailyTriviaBackfillCandidate;
  category: CategoryMetadata;
  count: number;
}): Promise<GeneratedQuestion[]> {
  const prompt = buildAutopilotPrompt({
    candidate: params.candidate,
    category: params.category,
    count: params.count,
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      temperature: 0.7,
      messages: [
        { role: "system", content: "You are a strict JSON generator for safe entertainment trivia." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`OpenAI trivia generation failed: ${response.status} ${message.slice(0, 300)}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice.message);
  const content = normalizeString(message.content);
  if (!content) {
    throw new Error("OpenAI trivia generation returned no message content");
  }

  return normalizeGeneratedQuestions(extractJsonArray(content));
}

function buildQuestionWritePayload(params: {
  generated: GeneratedQuestion;
  candidate: DailyTriviaBackfillCandidate;
  model: string;
  now: number;
}): Record<string, unknown> {
  return {
    category_id: params.candidate.categoryId,
    subcategory: params.candidate.subcategory ?? null,
    type: "multiple_choice",
    question: params.generated.question,
    options: params.generated.options.map((text, index) => ({ index, text })),
    correct_index: params.generated.correct_index,
    difficulty: params.generated.difficulty ?? "medium",
    star_value: 1,
    explanation: params.generated.explanation ?? null,
    created_at: params.now,
    created_by: "ai_generator",
    model_used: params.model,
    prompt_version: AUTOPILOT_VERSION,
    generator_source: "ai_daily_trivia",
    review_status: "needs_review",
    times_served: 0,
    times_correct: 0,
    correct_rate: 0,
    active: true,
    reviewed: false,
    duration_seconds: 45,
  };
}

async function writeAutopilotRequest(params: {
  database: admin.database.Database;
  dateKey: string;
  candidate: DailyTriviaBackfillCandidate;
  status: "pending" | "generated" | "failed" | "disabled";
  detail: string;
  generatedCount?: number;
}): Promise<void> {
  const requestId = requestIdForCandidate(params.candidate);
  await params.database.ref(`trivia_library/ai_generation_requests/${params.dateKey}/${requestId}`).set({
    category_id: params.candidate.categoryId,
    subcategory: params.candidate.subcategory,
    existing_question_count: params.candidate.questionCount,
    requested_question_count: params.candidate.questionsNeeded,
    generated_question_count: params.generatedCount ?? 0,
    status: params.status,
    detail: params.detail,
    generator_version: AUTOPILOT_VERSION,
    updated_at: Date.now(),
  });
}

async function generateDailyScheduleWindow(): Promise<void> {
  const database = admin.database();

  const [settingsSnap, categoriesSnap, questionsSnap, scheduleSnap] = await Promise.all([
    database.ref("trivia_library/settings").get(),
    database.ref("trivia_library/categories").get(),
    database.ref("trivia_library/questions").get(),
    database.ref("trivia_library/schedule").get(),
  ]);

  const settings = asRecord(settingsSnap.val());
  const configuredTimezone = normalizeString(settings.timezone) ?? DEFAULT_TIMEZONE;

  let timezone = configuredTimezone;
  try {
    // Validate timezone to avoid runtime failures if settings were misconfigured.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch (error) {
    logger.warn("Invalid trivia timezone in settings; defaulting to Melbourne", {
      configuredTimezone,
      defaultTimezone: DEFAULT_TIMEZONE,
      error,
    });
    timezone = DEFAULT_TIMEZONE;
  }

  const { pools, stats, usedFallbackPools } = buildQuestionPools(questionsSnap.val());
  if (pools.length === 0) {
    logger.error("Daily trivia scheduler found no valid question pools", {
      timezone,
      quality: stats,
    });
    return;
  }

  if (usedFallbackPools) {
    logger.warn("Daily trivia scheduler used fallback pools below minimum threshold", {
      minQuestionsPerPool: MIN_QUESTIONS_PER_POOL,
      poolCount: pools.length,
    });
  }

  const dateKeys = buildDateWindow(timezone, SCHEDULE_HORIZON_DAYS);
  const existingSchedules = asRecord(scheduleSnap.val());
  const generatedAt = Date.now();

  const writes: Array<Promise<void>> = [];
  const writtenDates: string[] = [];
  const skippedManualDates: string[] = [];

  for (const dateKey of dateKeys) {
    const existing = existingSchedules[dateKey];
    if (isManualSchedule(existing)) {
      skippedManualDates.push(dateKey);
      continue;
    }

    const pool = resolvePoolForDate(dateKey, pools);
    const category = readCategoryMetadata(categoriesSnap.val(), pool.categoryId);
    const existingRecord = asRecord(existing);

    const payload: Record<string, unknown> = {
      category_id: pool.categoryId,
      theme_name: buildThemeName(category.name, pool.subcategory),
      description: buildDescription(category.name, category.description, pool.subcategory),
      priority: normalizePositiveInt(existingRecord.priority, 1),
      source: "auto",
      generated_at: generatedAt,
      generator_version: GENERATOR_VERSION,
      generated_question_count: pool.questionCount,
    };

    if (pool.subcategory) {
      payload.subcategory = pool.subcategory;
    }

    writtenDates.push(dateKey);
    writes.push(
      database.ref(`trivia_library/schedule/${dateKey}`).set(payload)
    );
  }

  if (writes.length > 0) {
    await Promise.all(writes);
  }

  logger.info("Daily trivia schedule generated", {
    timezone,
    horizonDays: SCHEDULE_HORIZON_DAYS,
    generatedCount: writtenDates.length,
    skippedManualCount: skippedManualDates.length,
    poolCount: pools.length,
    quality: stats,
    writtenDates,
    skippedManualDates,
    generatorVersion: GENERATOR_VERSION,
  });
}

async function runDailyTriviaEngagementAutopilot(): Promise<void> {
  const database = admin.database();

  const [settingsSnap, categoriesSnap, questionsSnap] = await Promise.all([
    database.ref("trivia_library/settings").get(),
    database.ref("trivia_library/categories").get(),
    database.ref("trivia_library/questions").get(),
  ]);

  const settings = resolveAutopilotSettings(settingsSnap.val());
  const { pools: questionPools, stats } = collectQuestionPoolCounts(questionsSnap.val());
  const categoryPools = collectCategoryPools(categoriesSnap.val());
  const candidates = planDailyTriviaBackfillCandidates({
    questionPools,
    categoryPools,
    settings,
  });

  const dateKey = formatDateKey(new Date(), DEFAULT_TIMEZONE);

  if (candidates.length === 0) {
    logger.info("Daily trivia autopilot found no thin pools", {
      quality: stats,
      minQuestionsPerPool: settings.minQuestionsPerPool,
      targetQuestionsPerPool: settings.targetQuestionsPerPool,
    });
    return;
  }

  if (!settings.enabled) {
    await Promise.all(candidates.map((candidate) => writeAutopilotRequest({
      database,
      dateKey,
      candidate,
      status: "disabled",
      detail: "AI autopilot is disabled. Set trivia_library/settings/ai_autopilot_enabled to true to generate automatically.",
    })));

    logger.info("Daily trivia autopilot queued disabled backfill requests", {
      candidateCount: candidates.length,
      quality: stats,
    });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    await Promise.all(candidates.map((candidate) => writeAutopilotRequest({
      database,
      dateKey,
      candidate,
      status: "pending",
      detail: "OPENAI_API_KEY is not configured for Functions; request queued for manual/controller generation.",
    })));

    logger.warn("Daily trivia autopilot could not generate because OPENAI_API_KEY is missing", {
      candidateCount: candidates.length,
      quality: stats,
    });
    return;
  }

  const now = Date.now();
  const writes: Array<Promise<void>> = [];
  const generatedSummary: Array<{ candidate: string; generatedCount: number }> = [];

  for (const candidate of candidates) {
    try {
      const category = readCategoryMetadata(categoriesSnap.val(), candidate.categoryId);
      const count = Math.min(settings.batchSize, candidate.questionsNeeded);
      const generated = await generateQuestionsWithOpenAI({
        apiKey,
        model: settings.model,
        candidate,
        category,
        count,
      });

      if (generated.length === 0) {
        await writeAutopilotRequest({
          database,
          dateKey,
          candidate,
          status: "failed",
          detail: "AI returned no valid questions.",
        });
        continue;
      }

      generated.forEach((question, index) => {
        const key = [
          "ai",
          sanitizeKeyPart(candidate.categoryId),
          sanitizeKeyPart(candidate.subcategory),
          now,
          index + 1,
        ].join("_");

        writes.push(database.ref(`trivia_library/questions/${key}`).set(
          buildQuestionWritePayload({
            generated: question,
            candidate,
            model: settings.model,
            now,
          })
        ));
      });

      writes.push(writeAutopilotRequest({
        database,
        dateKey,
        candidate,
        status: "generated",
        detail: "AI generated daily trivia backfill questions.",
        generatedCount: generated.length,
      }));

      generatedSummary.push({
        candidate: requestIdForCandidate(candidate),
        generatedCount: generated.length,
      });
    } catch (error) {
      logger.error("Daily trivia autopilot failed for candidate", {
        candidate,
        error,
      });
      writes.push(writeAutopilotRequest({
        database,
        dateKey,
        candidate,
        status: "failed",
        detail: error instanceof Error ? error.message.slice(0, 500) : "Unknown AI generation error.",
      }));
    }
  }

  if (writes.length > 0) {
    await Promise.all(writes);
  }

  logger.info("Daily trivia autopilot completed", {
    generatedSummary,
    candidateCount: candidates.length,
    quality: stats,
    generatorVersion: AUTOPILOT_VERSION,
  });
}

export const dailyTriviaAutoScheduler = onSchedule(
  {
    region: REGION,
    schedule: SCHEDULE_CRON,
    timeZone: DEFAULT_TIMEZONE,
  },
  async () => {
    await generateDailyScheduleWindow();
  }
);

export const dailyTriviaEngagementAutopilot = onSchedule(
  {
    region: REGION,
    schedule: AUTOPILOT_CRON,
    timeZone: DEFAULT_TIMEZONE,
  },
  async () => {
    await runDailyTriviaEngagementAutopilot();
  }
);
