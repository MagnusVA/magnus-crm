import { expect, test, vi } from "vitest";
import { buildMessagesRequest, callMessages, maxCostMicroUsd } from "./gateway";
const getToken = async () => "fake-token";
const reply = (body: unknown, status = 200, headers?: Record<string, string>) =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));
test("builds the verified Anthropic request and fresh bearer token", async () => {
  const request = buildMessagesRequest({
    model: "anthropic/claude-sonnet-5.5",
    system: "sys",
    user: "user",
    schema: { type: "object" },
    maxTokens: 8000,
    effort: "low",
  });
  expect(request).toEqual({
    model: "anthropic/claude-sonnet-5.5",
    system: "sys",
    messages: [{ role: "user", content: "user" }],
    max_tokens: 8000,
    provider: { zdr: true, data_collection: "deny", require_parameters: true },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: { type: "object" } },
    },
  });
  const fetch = reply({
    id: "request1",
    content: [{ type: "thinking" }, { type: "text", text: "{}" }],
    usage: { cost: 0.002226, input_tokens: 698, output_tokens: 83 },
  });
  const token = vi.fn(getToken);
  expect(await callMessages(request, token, fetch)).toEqual({
    kind: "ok",
    text: "{}",
    id: "request1",
    inputTokens: 698,
    outputTokens: 83,
    costUsd: 0.002226,
  });
  expect(fetch.mock.calls[0]).toEqual([
    "https://ai-gateway.convex.dev/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fake-token",
      },
      body: JSON.stringify(request),
    },
  ]);
  await callMessages(request, token, fetch);
  expect(token).toHaveBeenCalledTimes(2);
});
test.each([429, 502, 503, 529])(
  "maps %i to busy with retry-after",
  async (status) => {
    expect(
      await callMessages(
        {},
        getToken,
        reply({}, status, { "Retry-After": "42" }),
      ),
    ).toEqual({ kind: "busy", status, retryAfterSeconds: 42 });
  },
);
test.each([400, 401, 403, 413, 500, 201])(
  "rejects other status %i",
  async (status) => {
    expect(await callMessages({}, getToken, reply({}, status))).toEqual({
      kind: "rejected",
      status,
    });
  },
);
test("network and token failures are busy without exposing error text", async () => {
  expect(
    await callMessages(
      {},
      getToken,
      vi.fn<typeof fetch>().mockRejectedValue(new Error("private")),
    ),
  ).toEqual({ kind: "busy", status: 0 });
  expect(
    await callMessages(
      {},
      async () => {
        throw new Error("secret");
      },
      reply({}),
    ),
  ).toEqual({ kind: "busy", status: 0 });
});
test("refusal preserves billed cost", async () => {
  expect(
    await callMessages(
      {},
      getToken,
      reply({ stop_reason: "refusal", usage: { cost: 0.01 } }),
    ),
  ).toEqual({ kind: "refused", costUsd: 0.01 });
});
test.each([
  null,
  [],
  "text",
  {},
  { content: [{ type: "text", text: " " }], usage: { cost: 0.01 } },
  { content: [{ type: "tool_use" }] },
])("rejects unusable response %#", async (body) => {
  expect((await callMessages({}, getToken, reply(body))).kind).toBe(
    "format_changed",
  );
});
test("bad JSON is a format change", async () => {
  expect(
    await callMessages(
      {},
      getToken,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private invalid JSON")),
    ),
  ).toEqual({ kind: "format_changed" });
});
test("a network failure while reading the body is busy", async () => {
  const response = new Response("{}");
  vi.spyOn(response, "text").mockRejectedValue(new Error("private body"));
  expect(
    await callMessages(
      {},
      getToken,
      vi.fn<typeof fetch>().mockResolvedValue(response),
    ),
  ).toEqual({ kind: "busy", status: 200 });
});
test("ignores invalid usage numbers and retry headers", async () => {
  expect(
    await callMessages(
      {},
      getToken,
      reply({
        content: [{ type: "text", text: "{}" }],
        usage: { cost: -1, input_tokens: "1" },
      }),
    ),
  ).toMatchObject({ kind: "ok", costUsd: undefined, inputTokens: undefined });
  expect(
    await callMessages({}, getToken, reply({}, 429, { "retry-after": "bad" })),
  ).toEqual({ kind: "busy", status: 429 });
});
test("reserves micro-USD at Sonnet or fallback Opus prices, rounding up", () => {
  expect(maxCostMicroUsd("anthropic/claude-sonnet-5.5", 1000, 8000)).toBe(
    82000,
  );
  expect(maxCostMicroUsd("anthropic/claude-opus-5.5", 1000, 8000)).toBe(164000);
  expect(maxCostMicroUsd("unknown", 1000, 8000)).toBe(164000);
  expect(maxCostMicroUsd("unknown", 0.1, 0)).toBe(1);
});
