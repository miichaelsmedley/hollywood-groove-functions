export type TriviaResponseKind = "choice" | "boolean" | "freeform" | "scale";

export type TriviaResponseContract = {
  optionIndex?: number;
  answeredAt?: number;
  responseTime?: number;
  displayName?: string;
  text?: string | null;
  booleanValue?: boolean;
  scaleValue?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function getTriviaResponseKind(response: unknown): TriviaResponseKind | null {
  if (!isRecord(response)) {
    return null;
  }

  if (finiteNumber(response.optionIndex)) {
    return "choice";
  }

  if (typeof response.booleanValue === "boolean") {
    return "boolean";
  }

  if (finiteNumber(response.scaleValue)) {
    return "scale";
  }

  if (typeof response.text === "string" && response.text.trim().length > 0) {
    return "freeform";
  }

  return null;
}

export function isTriviaResponsePayload(response: unknown): response is TriviaResponseContract {
  return getTriviaResponseKind(response) !== null;
}
