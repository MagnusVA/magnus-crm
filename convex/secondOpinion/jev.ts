import { buildQuestions, type DecisionQuestion } from "./questions";
import type { ChoiceAnswer, PartialAnswers } from "./verdict";

/**
 * The Convex AI Gateway's Decisions endpoint, read on 3 November 2026 from
 * https://docs.convex.dev/ai-gateway/api (docs/plans/closer-assistant.md
 * §2.9). It's in alpha, so every response is checked against the shape
 * below before anything uses it; a mismatch fails as `format_changed`.
 */
export const DECISIONS_URL = "https://ai-gateway.convex.dev/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";

export type DecisionsRequest = {
  model: string;
  provider: { zdr: true; data_collection: "deny" };
  state: unknown;
  questions: Record<string, DecisionQuestion>;
};

export function buildDecisionsRequest(
  state: unknown,
  claim: string | undefined,
  questions: Record<string, DecisionQuestion> = buildQuestions(claim),
): DecisionsRequest {
  return {
    model: JEV_MODEL,
    // Zero-data-retention endpoints only: the request fails rather than
    // reach a provider that keeps or collects the transcript.
    provider: { zdr: true, data_collection: "deny" },
    state,
    questions,
  };
}

export type ParsedDecisions = {
  id: string | undefined;
  /** Only the questions the request asked. */
  answers: PartialAnswers;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  costUsd: number | undefined;
};

export class FormatChangedError extends Error {
  constructor(detail: string) {
    super(`Decisions response format changed: ${detail}`);
    this.name = "FormatChangedError";
  }
}

const isProbability = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

function parseChoice(raw: unknown, key: string, allowed: readonly string[]): ChoiceAnswer {
  if (!raw || typeof raw !== "object") throw new FormatChangedError(`${key} is missing`);
  const answer = raw as Record<string, unknown>;
  if (typeof answer.choice !== "string" || !allowed.includes(answer.choice)) {
    // Jev may only answer with an option Magnus offered. Anything else,
    // including text a transcript talked it into, is discarded.
    throw new FormatChangedError(`${key}.choice is not one of the offered keys`);
  }
  const out: ChoiceAnswer = { choice: answer.choice };
  if (answer.confidence !== undefined) {
    if (!isProbability(answer.confidence)) throw new FormatChangedError(`${key}.confidence is out of range`);
    out.confidence = answer.confidence;
  }
  if (answer.probabilities !== undefined) {
    if (!answer.probabilities || typeof answer.probabilities !== "object") {
      throw new FormatChangedError(`${key}.probabilities is not an object`);
    }
    const probabilities: Record<string, number> = {};
    for (const [option, value] of Object.entries(answer.probabilities as Record<string, unknown>)) {
      if (!allowed.includes(option) || !isProbability(value)) {
        throw new FormatChangedError(`${key}.probabilities has an unknown option or value`);
      }
      probabilities[option] = value;
    }
    out.probabilities = probabilities;
  }
  return out;
}

/** The noul answer's number. The docs name the field `noul` and show no full example. */
function parseNoul(raw: unknown): number {
  if (isProbability(raw)) return raw;
  if (raw && typeof raw === "object") {
    const answer = raw as Record<string, unknown>;
    for (const field of ["noul", "probability", "value"]) {
      if (isProbability(answer[field])) return answer[field] as number;
    }
  }
  throw new FormatChangedError("claim has no number between 0 and 1");
}

export function parseDecisionsResponse(
  body: unknown,
  request: DecisionsRequest,
): ParsedDecisions {
  if (!body || typeof body !== "object") throw new FormatChangedError("body is not an object");
  const json = body as Record<string, unknown>;
  const answers = json.answers as Record<string, unknown> | undefined;
  if (!answers || typeof answers !== "object") throw new FormatChangedError("answers is missing");
  const parsed: PartialAnswers = {};
  for (const name of ["attendance", "ending", "objection"] as const) {
    const question = request.questions[name];
    if (question?.type === "choice")
      parsed[name] = parseChoice(answers[name], name, Object.keys(question.criteria));
  }
  if (request.questions.claim) parsed.claim = parseNoul(answers.claim);
  const usage = (json.usage ?? {}) as Record<string, unknown>;
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);
  return {
    id: typeof json.id === "string" ? json.id : undefined,
    answers: parsed,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    costUsd: num(usage.cost),
  };
}

export type DecisionsCallResult =
  | { kind: "ok"; parsed: ParsedDecisions }
  | { kind: "retryable"; status: number; detail: string }
  | { kind: "rejected"; status: number; detail: string }
  | { kind: "format_changed"; detail: string };

/**
 * One call to Decisions. A fresh token per request, as the docs ask; it is
 * never stored or logged. 502/503 `upstream_error` and network failures
 * are retryable; any other non-200 is rejected.
 */
export async function callDecisions(
  request: DecisionsRequest,
  getToken: () => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<DecisionsCallResult> {
  let response: Response;
  try {
    response = await fetchImpl(DECISIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await getToken()}` },
      body: JSON.stringify(request),
    });
  } catch (err) {
    return { kind: "retryable", status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: "retryable", status: response.status, detail: "Could not read gateway response" };
  }
  if (response.status === 502 || response.status === 503) {
    return { kind: "retryable", status: response.status, detail: text.slice(0, 300) };
  }
  if (!response.ok) return { kind: "rejected", status: response.status, detail: text.slice(0, 300) };
  try {
    return { kind: "ok", parsed: parseDecisionsResponse(JSON.parse(text), request) };
  } catch (err) {
    return { kind: "format_changed", detail: err instanceof Error ? err.message : String(err) };
  }
}
