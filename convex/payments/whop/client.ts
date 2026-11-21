import { reportError, type ObsAttributes } from "../../lib/observability/log";
import { timeoutSignal } from "../../lib/timeoutSignal";

/**
 * Whop's REST API (https://docs.whop.com/api-reference). Pure HTTP: no
 * database, no logging of bodies. Callers that hold a connection go through
 * `whopFetch`, which adds the connection's request clock and failure state.
 */
export const WHOP_API_BASE = {
  live: "https://api.whop.com/api/v1",
  sandbox: "https://sandbox-api.whop.com/api/v1",
} as const;

/** The dated API version every request pins. Change it on purpose, with tests. */
export const WHOP_API_VERSION_DATE = "2026-11-16-2";

export const MAX_RETRY_AFTER_MS = 15 * 60_000;

function retryAfterDelay(value: string | null): number {
  if (!value) return 60_000;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(Math.max(timestamp - Date.now(), 0), MAX_RETRY_AFTER_MS)
    : 60_000;
}

export type WhopEnvironment = keyof typeof WHOP_API_BASE;

export type WhopCredentials = {
  environment: WhopEnvironment;
  apiKey: string;
  apiVersionDate: string;
};

export type WhopErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "provider_unavailable"
  | "unexpected_response";

/** A failed request. Carries a fixed code and never Whop's message text. */
export class WhopRequestError extends Error {
  constructor(
    public code: WhopErrorCode,
    public status?: number,
    public retryAfterMs?: number,
  ) {
    super(status ? `Whop request failed: HTTP ${status} ${code}` : `Whop request failed: request error ${code}`);
  }
}

export function reportWhopRequestError(event: string, error: unknown, attrs: ObsAttributes) {
  const failure = error instanceof WhopRequestError ? error : new WhopRequestError("unexpected_response");
  reportError(event, failure, {
    ...attrs, integration: "whop", fingerprint: `integration:whop:${failure.status ?? failure.code}`,
  });
}

export type WhopQuery = Record<string, string | number | string[] | undefined>;

function buildUrl(base: string, path: string, query: WhopQuery = {}): string {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value))
      for (const item of value) url.searchParams.append(`${key}[]`, item);
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** One request. Returns the parsed JSON body; throws `WhopRequestError`. */
export async function whopRequest(
  credentials: WhopCredentials,
  path: string,
  init: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    query?: WhopQuery;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(
      buildUrl(WHOP_API_BASE[credentials.environment], path, init.query),
      {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          "Api-Version-Date": credentials.apiVersionDate,
          Accept: "application/json",
          ...(init.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: timeoutSignal(init.timeoutMs ?? 20_000),
      },
    );
  } catch {
    throw new WhopRequestError("provider_unavailable");
  }
  if (response.ok) {
    try {
      return await response.json();
    } catch {
      throw new WhopRequestError("unexpected_response", response.status);
    }
  }
  if (response.status === 401)
    throw new WhopRequestError("unauthorized", 401);
  if (response.status === 403) throw new WhopRequestError("forbidden", 403);
  if (response.status === 429) {
    throw new WhopRequestError(
      "rate_limited",
      429,
      retryAfterDelay(response.headers.get("Retry-After")),
    );
  }
  if (response.status >= 500)
    throw new WhopRequestError("provider_unavailable", response.status);
  throw new WhopRequestError("unexpected_response", response.status);
}
