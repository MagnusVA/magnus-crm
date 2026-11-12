import { describe, expect, it, vi } from "vitest";
import { callGenericDecisions } from "./decisions";

const request = {
  state: "#1 [00:00] P: Private transcript words",
  questions: {
    present: {
      type: "noul" as const,
      instructions: "Fixed category instruction",
    },
    resolved: {
      type: "noul" as const,
      instructions: "Fixed resolution instruction",
    },
  },
};
const token = async () => "private-token";
const body = () => ({
  id: "request-1",
  answers: {
    present: { type: "noul", noul: 0.98 },
    resolved: { type: "noul", noul: 0.7 },
  },
  usage: { input_tokens: 123, output_tokens: 4, cost: 0.00002 },
});
const respond = (json: unknown, status = 200) =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(json), { status }));

describe("callGenericDecisions", () => {
  it("sends caller keys, the Jev model and privacy flags with a fresh bearer token", async () => {
    const fetchImpl = respond(body());
    const getToken = vi.fn(token);
    const result = await callGenericDecisions(request, getToken, fetchImpl);
    expect(result).toEqual({
      kind: "ok",
      answers: { present: { noul: 0.98 }, resolved: { noul: 0.7 } },
      id: "request-1",
      inputTokens: 123,
      outputTokens: 4,
      costUsd: 0.00002,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://ai-gateway.convex.dev/alpha/decisions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer private-token",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      ...request,
      model: "typesafe/jev-1.13",
      provider: { zdr: true, data_collection: "deny" },
    });
    await callGenericDecisions(request, getToken, respond(body()));
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it.each(["noul", "probability", "value"])(
    "accepts the %s answer field and inclusive probability bounds",
    async (field) => {
      expect(
        await callGenericDecisions(
          request,
          token,
          respond({
            answers: { present: { [field]: 0 }, resolved: { [field]: 1 } },
          }),
        ),
      ).toMatchObject({
        kind: "ok",
        answers: { present: { noul: 0 }, resolved: { noul: 1 } },
      });
    },
  );

  it("accepts a bare probability like Second opinion and ignores unrequested answers", async () => {
    expect(
      await callGenericDecisions(
        request,
        token,
        respond({
          answers: { present: 0.8, resolved: 0.9, extra: { noul: 999 } },
        }),
      ),
    ).toMatchObject({
      kind: "ok",
      answers: { present: { noul: 0.8 }, resolved: { noul: 0.9 } },
    });
  });

  it.each([
    null,
    [],
    {},
    { answers: null },
    { answers: [] },
    { answers: { present: { noul: 0.8 } } },
    ...[-0.1, 1.1, "0.98", null, {}, { choice: "yes" }, { noul: "0.98" }].map(
      (value) => ({
        answers: { present: value, resolved: { noul: 0.7 } },
      }),
    ),
  ])("rejects missing or invalid requested answers: %j", async (value) => {
    expect(await callGenericDecisions(request, token, respond(value))).toEqual({
      kind: "format_changed",
    });
  });

  it("maps malformed JSON to format_changed without returning the body", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private model output"));
    expect(await callGenericDecisions(request, token, fetchImpl)).toEqual({
      kind: "format_changed",
    });
  });

  it("ignores invalid optional usage metadata", async () => {
    const json = body();
    expect(
      await callGenericDecisions(
        request,
        token,
        respond({
          ...json,
          id: 5,
          usage: { cost: -1, input_tokens: "123", output_tokens: null },
        }),
      ),
    ).toEqual({
      kind: "ok",
      answers: { present: { noul: 0.98 }, resolved: { noul: 0.7 } },
      id: undefined,
      costUsd: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
    });
  });

  it.each([429, 502, 503])(
    "maps HTTP %s to busy without exposing response text",
    async (status) => {
      expect(
        await callGenericDecisions(
          request,
          token,
          respond({ private: "response text" }, status),
        ),
      ).toEqual({ kind: "busy", status });
    },
  );

  it.each([201, 400, 401, 403, 413, 500, 529])(
    "maps other non-200 status %s to rejected",
    async (status) => {
      expect(
        await callGenericDecisions(
          request,
          token,
          respond({ private: "response text" }, status),
        ),
      ).toEqual({ kind: "rejected", status });
    },
  );

  it("maps network and token failures to busy without exposing their messages", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("private-token and transcript"));
    expect(await callGenericDecisions(request, token, fetchImpl)).toEqual({
      kind: "busy",
      status: 0,
    });
    const untouched = vi.fn<typeof fetch>();
    expect(
      await callGenericDecisions(
        request,
        async () => {
          throw new Error("private-token");
        },
        untouched,
      ),
    ).toEqual({ kind: "busy", status: 0 });
    expect(untouched).not.toHaveBeenCalled();
  });

  it("maps a response stream failure to busy", async () => {
    const response = new Response("private response");
    vi.spyOn(response, "text").mockRejectedValue(
      new Error("private transcript"),
    );
    expect(
      await callGenericDecisions(
        request,
        token,
        vi.fn<typeof fetch>().mockResolvedValue(response),
      ),
    ).toEqual({ kind: "busy", status: 200 });
  });
});
