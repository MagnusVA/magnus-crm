type SlackApiErrorResponse = {
  ok: false;
  error?: string;
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
  });
  if (!response.ok) {
    return {
      ok: false,
      error: `http_${response.status}`,
    };
  }

  return (await response.json()) as SlackApiResponse<T>;
}
