import * as admin from "firebase-admin";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";

const REGION = "asia-southeast1";
const SCHEDULE_CRON = "5 0 * * *"; // 00:05 every day
const DEFAULT_TIMEZONE = "Australia/Melbourne";
const SCHEDULE_HORIZON_DAYS = 7;
const MIN_QUESTIONS_PER_POOL = 3;
const MIN_QUESTION_LENGTH = 12;
const MIN_DURATION_SECONDS = 30;
const GENERATOR_VERSION = "daily-trivia-scheduler-v1";

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

type QuestionQualityStats = {
  total: number;
  valid: number;
  inactive: number;
  missingCategory: number;
  shortQuestion: number;
  invalidOptions: number;
  invalidCorrectAnswer: number;
  shortDuration: number;
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

function validateQuestion(question: Record<string, unknown>, stats: QuestionQualityStats): {
  isValid: boolean;
  categoryId: string | null;
  subcategory: string | null;
} {
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
  if (options.length < 2) {
    stats.invalidOptions += 1;
    return { isValid: false, categoryId: null, subcategory: null };
  }

  const uniqueOptionCount = new Set(
    options.map((option) => option.text.toLowerCase())
  ).size;
  if (uniqueOptionCount < 2) {
    stats.invalidOptions += 1;
    return { isValid: false, categoryId: null, subcategory: null };
  }

  const correctIndex = question.correct_index;
  const hasValidCorrectIndex = typeof correctIndex === "number" &&
    Number.isInteger(correctIndex) &&
    options.some((option) => option.index === correctIndex);

  if (!hasValidCorrectIndex) {
    stats.invalidCorrectAnswer += 1;
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

function buildQuestionPools(questionsValue: unknown): {
  pools: PoolCandidate[];
  stats: QuestionQualityStats;
  usedFallbackPools: boolean;
} {
  const stats: QuestionQualityStats = {
    total: 0,
    valid: 0,
    inactive: 0,
    missingCategory: 0,
    shortQuestion: 0,
    invalidOptions: 0,
    invalidCorrectAnswer: 0,
    shortDuration: 0,
  };

  const poolCounts = new Map<string, PoolCandidate>();
  const records = Object.values(asRecord(questionsValue));

  for (const record of records) {
    if (!isRecord(record)) {
      continue;
    }

    const validation = validateQuestion(record, stats);
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
