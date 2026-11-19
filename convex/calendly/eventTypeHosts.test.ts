import { describe, expect, it, vi } from "vitest";
import {
  isHostCheckCandidate,
  membershipsPageUrl,
  parseMembershipsPage,
  runHostChecks,
  type HostCheckDeps,
} from "./eventTypeHosts";

const EVENT_TYPE = "https://api.calendly.com/event_types/round-robin";
const HOST = "https://api.calendly.com/users/first";
const OTHER_HOST = "https://api.calendly.com/users/second";
const OLD_TOKEN = "old-token";
const NEW_TOKEN = "new-token";
const END = { next_page: null };
const CONTINUATION = {
  next_page: "https://example.test/untrusted-page",
  next_page_token: "page+/=2",
};

function member(hostUri = HOST, eventTypeUri = EVENT_TYPE) {
  return { member: { uri: hostUri }, event_type: { uri: eventTypeUri } };
}

function page(collection = [member()], pagination: object = END) {
  return Response.json({ collection, pagination });
}

function httpError(status: number) {
  return new Response(null, { status });
}

function candidates(count: number) {
  return Array.from({ length: count }, (_, i) => `${EVENT_TYPE}-${i + 1}`);
}

function requestedEventType(url: string) {
  const uri = new URL(url).searchParams.get("event_type");
  if (!uri) throw new Error(`Missing event_type in ${url}`);
  return uri;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function hostChecks() {
  const fetch = vi.fn<HostCheckDeps["fetch"]>();
  const refreshToken = vi.fn<HostCheckDeps["refreshToken"]>().mockResolvedValue(NEW_TOKEN);
  const now = vi.fn(() => 0);
  return {
    fetch,
    refreshToken,
    now,
    requestedEventTypes: () => fetch.mock.calls.map(([url]) => requestedEventType(url)),
    run: (
      eventTypes = [EVENT_TYPE],
      limits: { rateLimitRemaining?: number; deadline?: number } = {},
    ) => runHostChecks({
      candidates: eventTypes,
      accessToken: OLD_TOKEN,
      rateLimitRemaining: limits.rateLimitRemaining ?? null,
      deadline: limits.deadline ?? 45_000,
      deps: { fetch, refreshToken, now },
    }),
  };
}

describe("membershipsPageUrl", () => {
  it("builds a Calendly URL with the event type and two results per page", () => {
    const url = new URL(membershipsPageUrl(`${EVENT_TYPE}?name=a&b=c`));

    expect(`${url.origin}${url.pathname}`).toBe("https://api.calendly.com/event_type_memberships");
    expect(url.searchParams.get("event_type")).toBe(`${EVENT_TYPE}?name=a&b=c`);
    expect(url.searchParams.get("count")).toBe("2");
    expect(url.searchParams.has("page_token")).toBe(false);
  });

  it("encodes the continuation token on the same endpoint", () => {
    const url = new URL(membershipsPageUrl(EVENT_TYPE, CONTINUATION.next_page_token));

    expect(`${url.origin}${url.pathname}`).toBe("https://api.calendly.com/event_type_memberships");
    expect(url.searchParams.get("event_type")).toBe(EVENT_TYPE);
    expect(url.searchParams.get("count")).toBe("2");
    expect(url.searchParams.get("page_token")).toBe(CONTINUATION.next_page_token);
  });
});

describe("parseMembershipsPage", () => {
  it.each([END, { ...END, next_page_token: null }])("accepts an explicit final page %j", (pagination) => {
    expect(parseMembershipsPage({ collection: [member()], pagination }, EVENT_TYPE)).toEqual({
      kind: "page", memberUris: [HOST], nextPageToken: null,
    });
  });

  it("returns the continuation token from a valid page", () => {
    expect(parseMembershipsPage({ collection: [member()], pagination: CONTINUATION }, EVENT_TYPE)).toEqual({
      kind: "page", memberUris: [HOST], nextPageToken: CONTINUATION.next_page_token,
    });
  });

  it.each([
    ["an empty pagination object", { collection: [member()], pagination: {} }],
    ["missing pagination", { collection: [member()] }],
    ["a next_page without a token", { collection: [member()], pagination: { next_page: CONTINUATION.next_page } }],
    ["a token without a next_page", { collection: [member()], pagination: { next_page_token: "next" } }],
    ["a token on a final page", { collection: [member()], pagination: { ...END, next_page_token: "next" } }],
    ["a member URI outside /users/", { collection: [member(EVENT_TYPE)], pagination: END }],
    ["an event_type that is not an object", { collection: [{ member: { uri: HOST }, event_type: EVENT_TYPE }], pagination: END }],
    ["an event_type without a URI", { collection: [{ member: { uri: HOST }, event_type: {} }], pagination: END }],
    ["a mismatched event type", { collection: [member(HOST, `${EVENT_TYPE}-other`)], pagination: END }],
  ])("rejects %s", (_name, body) => {
    expect(parseMembershipsPage(body, EVENT_TYPE)).toEqual({ kind: "malformed" });
  });
});

describe("isHostCheckCandidate", () => {
  const roundRobin = { uri: EVENT_TYPE, kind: "solo", pooling_type: "round_robin", active: true };

  it("checks an active solo round robin", () => {
    expect(isHostCheckCandidate(roundRobin)).toBe(true);
  });

  it.each([
    ["one-on-one", { pooling_type: null }],
    ["group", { kind: "group" }],
    ["collective", { pooling_type: "collective" }],
    ["multi-pool", { pooling_type: "multi_pool" }],
    ["inactive", { active: false }],
    ["deleted", { deleted_at: "2026-11-16T12:00:00Z" }],
  ])("ignores an event type that is %s", (_name, fields) => {
    expect(isHostCheckCandidate({ ...roundRobin, ...fields })).toBe(false);
  });
});

describe("runHostChecks", () => {
  it("proves one host on the final page", async () => {
    const checks = hostChecks();
    checks.fetch.mockResolvedValueOnce(page());

    const result = await checks.run();

    expect(result.verdicts).toEqual(new Map([[EVENT_TYPE, { kind: "single", hostUri: HOST }]]));
    expect(result.unchecked).toEqual([]);
    expect(result.stoppedBy).toBeNull();
    expect(checks.fetch).toHaveBeenCalledTimes(1);
  });

  it("stops reading when the first page proves two distinct hosts", async () => {
    const checks = hostChecks();
    checks.fetch.mockResolvedValueOnce(page([member(), member(OTHER_HOST)], CONTINUATION));

    expect((await checks.run()).verdicts.get(EVENT_TYPE)).toEqual({ kind: "not_single" });
    expect(checks.fetch).toHaveBeenCalledTimes(1);
  });

  it("finds a second host on page two using Calendly's token and the original endpoint", async () => {
    const checks = hostChecks();
    checks.fetch.mockResolvedValueOnce(page([member()], CONTINUATION))
      .mockResolvedValueOnce(page([member(OTHER_HOST)]));

    expect((await checks.run()).verdicts.get(EVENT_TYPE)).toEqual({ kind: "not_single" });
    expect(checks.fetch).toHaveBeenCalledTimes(2);
    const nextUrl = new URL(checks.fetch.mock.calls[1][0]);
    expect(`${nextUrl.origin}${nextUrl.pathname}`).toBe("https://api.calendly.com/event_type_memberships");
    expect(nextUrl.searchParams.get("event_type")).toBe(EVENT_TYPE);
    expect(nextUrl.searchParams.get("page_token")).toBe(CONTINUATION.next_page_token);
  });

  it("counts the same host on both pages only once", async () => {
    const checks = hostChecks();
    checks.fetch.mockResolvedValueOnce(page([member()], CONTINUATION)).mockResolvedValueOnce(page());

    expect((await checks.run()).verdicts.get(EVENT_TYPE)).toEqual({ kind: "single", hostUri: HOST });
    expect(checks.fetch).toHaveBeenCalledTimes(2);
  });

  it("reports an empty final page as not_single", async () => {
    const checks = hostChecks();
    checks.fetch.mockResolvedValueOnce(page([]));

    expect((await checks.run()).verdicts.get(EVENT_TYPE)).toEqual({ kind: "not_single" });
    expect(checks.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails when a one-host page has an empty pagination object", async () => {
    const checks = hostChecks();
    checks.fetch.mockResolvedValueOnce(page([member()], {}));

    expect((await checks.run()).verdicts.get(EVENT_TYPE)).toEqual({ kind: "failed", reason: "malformed" });
    expect(checks.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails on a repeated pagination token", async () => {
    const checks = hostChecks();
    checks.fetch.mockResolvedValueOnce(page([member()], CONTINUATION))
      .mockResolvedValueOnce(page([member()], CONTINUATION));

    expect((await checks.run()).verdicts.get(EVENT_TYPE)).toEqual({ kind: "failed", reason: "repeated_page" });
    expect(checks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([403, 404])("reports HTTP %i as not_single without a retry", async (status) => {
    const checks = hostChecks();
    checks.fetch.mockResolvedValueOnce(httpError(status));

    expect((await checks.run()).verdicts.get(EVENT_TYPE)).toEqual({ kind: "not_single" });
    expect(checks.fetch).toHaveBeenCalledTimes(1);
  });

  it("proves the host after retrying a 500 once", async () => {
    const checks = hostChecks();
    checks.fetch.mockResolvedValueOnce(httpError(500)).mockResolvedValueOnce(page());

    expect((await checks.run()).verdicts.get(EVENT_TYPE)).toEqual({ kind: "single", hostUri: HOST });
    expect(checks.fetch).toHaveBeenCalledTimes(2);
    expect(checks.fetch.mock.calls[0]).toEqual(checks.fetch.mock.calls[1]);
  });

  it("fails after two HTTP 500 responses", async () => {
    const checks = hostChecks();
    checks.fetch.mockResolvedValue(httpError(500));

    expect((await checks.run()).verdicts.get(EVENT_TYPE)).toEqual({ kind: "failed", reason: "http_500" });
    expect(checks.fetch).toHaveBeenCalledTimes(2);
  });

  it("fails after two network rejections", async () => {
    const checks = hostChecks();
    checks.fetch.mockRejectedValue(new TypeError("Network failure"));

    expect((await checks.run()).verdicts.get(EVENT_TYPE)).toEqual({ kind: "failed", reason: "network" });
    expect(checks.fetch).toHaveBeenCalledTimes(2);
  });

  it("joins one token refresh when four workers get a 401 at the same time", async () => {
    const checks = hostChecks();
    const eventTypes = candidates(4);
    const expired = deferred<Response>();
    const refreshed = deferred<string>();
    const refreshStarted = deferred<void>();
    checks.refreshToken.mockImplementation(() => {
      refreshStarted.resolve();
      return refreshed.promise;
    });
    checks.fetch.mockImplementation((url, token) => token === OLD_TOKEN
      ? expired.promise
      : Promise.resolve(page([member(HOST, requestedEventType(url))])));

    const running = checks.run(eventTypes);
    expect(checks.requestedEventTypes()).toEqual(eventTypes);
    expired.resolve(httpError(401));
    await refreshStarted.promise;
    refreshed.resolve(NEW_TOKEN);
    const result = await running;

    expect(checks.refreshToken).toHaveBeenCalledTimes(1);
    expect(checks.fetch.mock.calls.map(([, token]) => token)).toEqual([
      OLD_TOKEN, OLD_TOKEN, OLD_TOKEN, OLD_TOKEN,
      NEW_TOKEN, NEW_TOKEN, NEW_TOKEN, NEW_TOKEN,
    ]);
    expect(result.verdicts).toEqual(new Map(eventTypes.map((uri) => [uri, { kind: "single", hostUri: HOST }])));
    expect(result.accessToken).toBe(NEW_TOKEN);
  });

  it("retries a late 401 with the already refreshed token", async () => {
    const checks = hostChecks();
    const [first, late] = candidates(2);
    const lateResponse = deferred<Response>();
    const retried = deferred<void>();
    checks.fetch.mockImplementation(async (url, token) => {
      const uri = requestedEventType(url);
      if (token === OLD_TOKEN) return uri === late ? lateResponse.promise : httpError(401);
      if (uri === first) retried.resolve();
      return page([member(HOST, uri)]);
    });

    const running = checks.run([first, late]);
    await retried.promise;
    lateResponse.resolve(httpError(401));
    const result = await running;

    expect(checks.refreshToken).toHaveBeenCalledTimes(1);
    expect(checks.fetch.mock.calls.map(([url, token]) => [requestedEventType(url), token])).toEqual([
      [first, OLD_TOKEN], [late, OLD_TOKEN], [first, NEW_TOKEN], [late, NEW_TOKEN],
    ]);
    expect(result.verdicts).toEqual(new Map([
      [first, { kind: "single", hostUri: HOST }], [late, { kind: "single", hostUri: HOST }],
    ]));
  });

  it("fails when refresh returns no access token", async () => {
    const checks = hostChecks();
    checks.fetch.mockResolvedValueOnce(httpError(401));
    checks.refreshToken.mockResolvedValueOnce(null);

    expect((await checks.run()).verdicts.get(EVENT_TYPE)).toEqual({ kind: "failed", reason: "unauthorized" });
    expect(checks.refreshToken).toHaveBeenCalledTimes(1);
    expect(checks.fetch).toHaveBeenCalledTimes(1);
  });

  it("stops dispatching on HTTP 429 and drains the requests already sent", async () => {
    const checks = hostChecks();
    const eventTypes = candidates(7);
    const rateLimited = httpError(429);
    checks.fetch.mockResolvedValueOnce(rateLimited).mockImplementation(async (url) =>
      page([member(HOST, requestedEventType(url))]));

    const result = await checks.run(eventTypes);

    expect(result.stoppedBy).toBe("rate_limited");
    expect(result.rateLimitResponse).toBe(rateLimited);
    expect(checks.requestedEventTypes()).toEqual(eventTypes.slice(0, 4));
    expect(result.verdicts).toEqual(new Map(eventTypes.slice(1, 4).map((uri) => [uri, { kind: "single", hostUri: HOST }])));
    expect(result.unchecked).toEqual([eventTypes[0], ...eventTypes.slice(4)]);
  });

  it("sends no retry when a 500 arrives alongside a 429", async () => {
    const checks = hostChecks();
    const eventTypes = candidates(2);
    checks.fetch.mockResolvedValueOnce(httpError(429)).mockResolvedValueOnce(httpError(500))
      .mockResolvedValueOnce(page([member(HOST, eventTypes[1])]));

    const result = await checks.run(eventTypes);

    expect(result.stoppedBy).toBe("rate_limited");
    expect(checks.requestedEventTypes()).toEqual(eventTypes);
    expect(result.verdicts.size).toBe(0);
    expect(result.unchecked).toEqual(eventTypes);
  });

  it("checks only the first of three candidates when six requests remain", async () => {
    const checks = hostChecks();
    const eventTypes = candidates(3);
    checks.fetch.mockResolvedValueOnce(page([member(HOST, eventTypes[0])]));

    const result = await checks.run(eventTypes, { rateLimitRemaining: 6 });

    expect(result.stoppedBy).toBe("quota");
    expect(checks.requestedEventTypes()).toEqual(eventTypes.slice(0, 1));
    expect(result.verdicts).toEqual(new Map([[eventTypes[0], { kind: "single", hostUri: HOST }]]));
    expect(result.unchecked).toEqual(eventTypes.slice(1));
  });

  it("starts candidates in order and leaves the rest unchecked when time runs out", async () => {
    const checks = hostChecks();
    const eventTypes = candidates(6);
    const deadline = 45_000;
    checks.fetch.mockImplementation(async (url) => {
      const uri = requestedEventType(url);
      if (uri === eventTypes[1]) checks.now.mockReturnValue(deadline - 7_999);
      return page([member(HOST, uri)]);
    });

    const result = await checks.run(eventTypes, { deadline });

    expect(result.stoppedBy).toBe("deadline");
    expect(checks.requestedEventTypes()).toEqual(eventTypes.slice(0, 2));
    expect(result.verdicts).toEqual(new Map(eventTypes.slice(0, 2).map((uri) => [uri, { kind: "single", hostUri: HOST }])));
    expect(result.unchecked).toEqual(eventTypes.slice(2));
  });

  it("stops an outage after four consecutive failed checks", async () => {
    const checks = hostChecks();
    const eventTypes = candidates(10);
    checks.fetch.mockResolvedValue(httpError(500));

    const result = await checks.run(eventTypes);

    const failed = eventTypes.slice(0, 4);
    expect(result.stoppedBy).toBe("outage");
    expect(result.verdicts).toEqual(new Map(failed.map((uri) => [uri, { kind: "failed", reason: "http_500" }])));
    expect(new Set(result.unchecked)).toEqual(new Set(eventTypes.slice(4)));
    expect(checks.requestedEventTypes().slice(0, 8)).toEqual([...failed, ...failed]);
    // Up to three new requests can start while the last failure is still in flight.
    const startedDuringFailures = checks.requestedEventTypes().slice(8);
    expect(startedDuringFailures.length).toBeLessThanOrEqual(3);
    expect(startedDuringFailures).toEqual(eventTypes.slice(4, 4 + startedDuringFailures.length));
  });

  it("fails a lookup that stops after its first page instead of leaving it unchecked", async () => {
    const checks = hostChecks();
    // The first page answers and asks for a second; by then the phase is over.
    checks.fetch.mockImplementationOnce(async () => {
      checks.now.mockReturnValue(40_000);
      return page([member()], CONTINUATION);
    });

    const result = await checks.run([EVENT_TYPE]);

    expect(result.verdicts.get(EVENT_TYPE)).toEqual({ kind: "failed", reason: "interrupted" });
    expect(result.unchecked).toEqual([]);
  });

  it("fails one lookup when the token refresh throws, and keeps the other results", async () => {
    const checks = hostChecks();
    const [first, second] = candidates(2);
    checks.refreshToken.mockRejectedValueOnce(new Error("network down"));
    checks.fetch.mockImplementation(async (url) =>
      requestedEventType(url) === first ? httpError(401) : page([member(HOST, second)]));

    const result = await checks.run([first, second]);

    expect(result.verdicts.get(first)).toEqual({ kind: "failed", reason: "unauthorized" });
    expect(result.verdicts.get(second)).toEqual({ kind: "single", hostUri: HOST });
  });
});
