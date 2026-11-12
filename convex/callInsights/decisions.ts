import { DECISIONS_URL, JEV_MODEL } from "../secondOpinion/jev";

export type GenericDecisionsResult =
  | {
      kind: "ok";
      answers: Record<
        string,
        { noul?: number; choice?: string; confidence?: number }
      >;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      id?: string;
    }
  | { kind: "busy"; status: number }
  | { kind: "rejected"; status: number }
  | { kind: "format_changed" };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function probability(value: unknown): number | undefined {
  const n = nonnegative(value);
  return n !== undefined && n <= 1 ? n : undefined;
}

function noul(value: unknown): number | undefined {
  const direct = probability(value);
  if (direct !== undefined) return direct;
  const answer = object(value);
  if (!answer) return undefined;
  for (const key of ["noul", "probability", "value"]) {
    const n = probability(answer[key]);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** A fresh token is used for each request. Failures expose fixed codes only. */
export async function callGenericDecisions(
  request: {
    state: string;
    questions: Record<string, { type: "noul"; instructions: string }>;
  },
  getToken: () => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<GenericDecisionsResult> {
  let response: Response;
  try {
    response = await fetchImpl(DECISIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await getToken()}`,
      },
      body: JSON.stringify({
        model: JEV_MODEL,
        provider: { zdr: true, data_collection: "deny" },
        state: request.state,
        questions: request.questions,
      }),
    });
  } catch {
    return { kind: "busy", status: 0 };
  }
  if ([429, 502, 503].includes(response.status))
    return { kind: "busy", status: response.status };
  if (response.status !== 200)
    return { kind: "rejected", status: response.status };

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: "busy", status: response.status };
  }
  let body: Record<string, unknown> | undefined;
  try {
    body = object(JSON.parse(text));
  } catch {
    return { kind: "format_changed" };
  }
  const rawAnswers = object(body?.answers);
  if (!rawAnswers) return { kind: "format_changed" };
  const entries: Array<[string, { noul: number }]> = [];
  for (const key of Object.keys(request.questions)) {
    const value = Object.hasOwn(rawAnswers, key)
      ? noul(rawAnswers[key])
      : undefined;
    if (value === undefined) return { kind: "format_changed" };
    entries.push([key, { noul: value }]);
  }
  const usage = object(body?.usage);
  return {
    kind: "ok",
    answers: Object.fromEntries(entries),
    costUsd: nonnegative(usage?.cost),
    inputTokens: nonnegative(usage?.input_tokens),
    outputTokens: nonnegative(usage?.output_tokens),
    id: typeof body?.id === "string" ? body.id : undefined,
  };
}
