import { describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { fetchInviteeSnapshot, isCalendlyInviteeUri } from "./inviteeSnapshot";

const URI = "https://api.calendly.com/scheduled_events/EV1/invitees/INV1";
const target = { meetingId: "m1" as Id<"meetings">, inviteeUri: URI };
const deps = (fetchFn: typeof fetch, sleep = vi.fn(async () => {})) => ({
  accessToken: "token",
  fetchFn,
  sleep,
  now: () => 42,
});

function json(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("isCalendlyInviteeUri", () => {
  it.each([
    [URI, true],
    ["http://api.calendly.com/scheduled_events/EV1/invitees/INV1", false],
    ["https://api.calendly.com.evil.test/scheduled_events/EV1/invitees/INV1", false],
    ["https://user:pass@api.calendly.com/scheduled_events/EV1/invitees/INV1", false],
    ["https://api.calendly.com:8443/scheduled_events/EV1/invitees/INV1", false],
    ["https://api.calendly.com/scheduled_events/EV1/invitees/INV1?next=x", false],
    ["https://api.calendly.com/users/me", false],
    ["not a url", false],
  ])("%s -> %s", (uri, expected) => {
    expect(isCalendlyInviteeUri(uri)).toBe(expected);
  });
});

describe("fetchInviteeSnapshot", () => {
  it("sends the token only to the invitee URI, without following redirects", async () => {
    const fetchFn = vi.fn(async () => json(200, { resource: { email: "A@X.com", name: "Ana" } }));
    await fetchInviteeSnapshot(target, deps(fetchFn as typeof fetch));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URI);
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ Authorization: "Bearer token" });
  });

  it("never calls Calendly for a URI off its API", async () => {
    const fetchFn = vi.fn();
    const result = await fetchInviteeSnapshot(
      { ...target, inviteeUri: "https://example.test/invitees/1" },
      deps(fetchFn as unknown as typeof fetch),
    );
    expect(result.outcome).toBe("invalid_uri");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reads email, name, phone and handle from the invitee", async () => {
    const fetchFn = vi.fn(async () =>
      json(200, {
        resource: {
          email: " Ana@Example.org ",
          first_name: "Ana",
          last_name: "Lopez",
          text_reminder_number: "+1 604-555-0101",
          questions_and_answers: [
            { question: "Phone", answer: "(778) 955-9253", position: 0 },
            { question: "What's your Instagram username? (Example @therealbrianmark)", answer: "@Ana.Lopez", position: 1 },
          ],
        },
      }),
    );
    expect(await fetchInviteeSnapshot(target, deps(fetchFn as typeof fetch))).toEqual({
      meetingId: "m1",
      inviteeUri: URI,
      outcome: "ok",
      httpStatus: 200,
      email: "ana@example.org",
      name: "Ana Lopez",
      phone: "+17789559253",
      social: { platform: "instagram", handle: "ana.lopez" },
      fetchedAt: 42,
    });
  });

  it("falls back to the reminder number and skips placeholder answers", async () => {
    const fetchFn = vi.fn(async () =>
      json(200, {
        resource: {
          email: "email@gmail.com",
          name: "Ana",
          text_reminder_number: "+1 604-555-0101",
          questions_and_answers: [
            { question: "Phone", answer: "+1 234-567-8910" },
            { question: "Instagram Handle", answer: "na" },
          ],
        },
      }),
    );
    const result = await fetchInviteeSnapshot(target, deps(fetchFn as typeof fetch));
    expect(result).toMatchObject({ outcome: "ok", email: "email@gmail.com", phone: "+16045550101" });
    expect(result.social).toBeUndefined();
  });

  it("waits out a rate limit and retries", async () => {
    const sleep = vi.fn(async () => {});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}, { "retry-after": "3" }))
      .mockResolvedValueOnce(json(200, { resource: { email: "a@x.com" } }));
    const result = await fetchInviteeSnapshot(target, deps(fetchFn, sleep));
    expect(result.outcome).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("gives up after repeated network failures", async () => {
    const sleep = vi.fn(async () => {});
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const result = await fetchInviteeSnapshot(target, deps(fetchFn, sleep));
    expect(result).toMatchObject({ outcome: "network_error", httpStatus: undefined });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it.each([
    [404, "not_found"],
    [401, "http_error"],
    [403, "http_error"],
  ] as const)("does not retry HTTP %s", async (status, outcome) => {
    const fetchFn = vi.fn(async () => json(status));
    const result = await fetchInviteeSnapshot(target, deps(fetchFn as typeof fetch));
    expect(result).toMatchObject({ outcome, httpStatus: status });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
