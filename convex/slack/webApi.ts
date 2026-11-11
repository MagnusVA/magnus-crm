const SLACK_FETCH_TIMEOUT_MS = 30_000;
import { timeoutSignal } from "../lib/timeoutSignal";

type SlackApiErrorResponse = {
  ok: false;
  error?: string;
  /** Slack's `Retry-After` on a failed POST, when it sent one. */
  retryAfterSeconds?: number;
};

export type SlackApiResponse<T extends object> =
  | (T & { ok: true })
  | SlackApiErrorResponse;

type SlackApiParam = string | number | boolean | undefined;
type SlackJsonBody = Record<
  string,
  string | number | boolean | null | undefined | object | unknown[]
>;

function appendParams(url: URL, params: Record<string, SlackApiParam>) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
}

export async function slackApiGet<T extends object>(
  method: string,
  token: string,
  params: Record<string, SlackApiParam>,
): Promise<SlackApiResponse<T>> {
  const url = new URL(`https://slack.com/api/${method}`);
  appendParams(url, params);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: timeoutSignal(SLACK_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    return {
      ok: false,
      error: `http_${response.status}`,
    };
  }

  return (await response.json()) as SlackApiResponse<T>;
}

export async function slackApiPostJson<T extends object>(
  method: string,
  token: string,
  body: SlackJsonBody,
): Promise<SlackApiResponse<T>> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: timeoutSignal(SLACK_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Slack sends seconds. Anything else (absent, an HTTP date) is ignored.
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    return {
      ok: false,
      error: `http_${response.status}`,
      ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? { retryAfterSeconds }
        : {}),
    };
  }

  return (await response.json()) as SlackApiResponse<T>;
}

/**
 * A UUID-shaped `client_msg_id` that is the same on every attempt to post
 * one record, so a retry carries the identity of the post it repeats. Slack
 * names the field in `chat.postMessage` errors but documents no dedupe
 * guarantee, so treat it as best effort.
 */
export async function slackClientMessageId(recordId: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recordId)),
  );
  const hex = [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
