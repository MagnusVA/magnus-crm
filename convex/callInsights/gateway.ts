export type MessagesCallResult =
  | {
      kind: "ok";
      text: string;
      id?: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    }
  | { kind: "busy"; status: number; retryAfterSeconds?: number }
  | { kind: "rejected"; status: number }
  | { kind: "refused"; costUsd?: number }
  | { kind: "format_changed"; costUsd?: number };

export function buildMessagesRequest(a: {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  effort: "low" | "medium" | "high";
}): Record<string, unknown> {
  return {
    model: a.model,
    system: a.system,
    messages: [{ role: "user", content: a.user }],
    max_tokens: a.maxTokens,
    output_config: {
      effort: a.effort,
      format: { type: "json_schema", schema: a.schema },
    },
    provider: { zdr: true, data_collection: "deny", require_parameters: true },
  };
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

export async function callMessages(
  request: Record<string, unknown>,
  getToken: () => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<MessagesCallResult> {
  let response: Response;
  try {
    response = await fetchImpl("https://ai-gateway.convex.dev/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await getToken()}`,
      },
      body: JSON.stringify(request),
    });
  } catch {
    return { kind: "busy", status: 0 };
  }
  if ([429, 502, 503, 529].includes(response.status)) {
    const header = response.headers.get("retry-after");
    const seconds = header === null ? undefined : Number(header);
    return {
      kind: "busy",
      status: response.status,
      ...(seconds !== undefined && Number.isFinite(seconds) && seconds >= 0
        ? { retryAfterSeconds: seconds }
        : {}),
    };
  }
  if (response.status !== 200)
    return { kind: "rejected", status: response.status };
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: "busy", status: response.status };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "format_changed" };
  }
  if (!object(body)) return { kind: "format_changed" };
  const usage = object(body.usage) ? body.usage : {};
  const costUsd = number(usage.cost);
  if (body.stop_reason === "refusal") return { kind: "refused", costUsd };
  const block = Array.isArray(body.content)
    ? body.content.find(
        (block) =>
          object(block) &&
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim(),
      )
    : undefined;
  if (!object(block) || typeof block.text !== "string")
    return { kind: "format_changed", costUsd };
  return {
    kind: "ok",
    text: block.text,
    id: typeof body.id === "string" ? body.id : undefined,
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
    costUsd,
  };
}

export function maxCostMicroUsd(
  model: string,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number {
  const [input, output] =
    model === "anthropic/claude-sonnet-5.5" ? [2, 10] : [4, 20];
  return Math.ceil(
    Math.max(0, estimatedInputTokens) * input +
      Math.max(0, maxOutputTokens) * output,
  );
}
