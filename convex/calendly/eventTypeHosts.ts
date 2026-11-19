// The event type sync's host check: which round robins have exactly one host
// in Calendly, so closer links can treat them as that person's own calendar.
// No "use node": the sync action wires in fetch, token refresh and the clock,
// and the tests drive the same code with fakes.

import { SINGLE_HOST_POOLING_TYPES } from "../lib/closerLinks";

const MEMBERSHIPS_URL = "https://api.calendly.com/event_type_memberships";
const CALENDLY_USER_URI_PREFIX = "https://api.calendly.com/users/";

/** Pages read per event type. Two hosts end the read early, so more means a bad response. */
const MAX_PAGES = 5;
/** Membership reads at a time. */
export const HOST_CHECK_CONCURRENCY = 4;
/** One membership request, including its wait. */
export const HOST_CHECK_REQUEST_TIMEOUT_MS = 8_000;
/** The whole host check, from its start to its last response. */
export const HOST_CHECK_PHASE_MS = 45_000;
/** Requests kept in reserve under Calendly's rate limit. */
const QUOTA_RESERVE = 5;
/** Failed checks in a row that mean Calendly is down: stop asking. */
const OUTAGE_FAILURES = 4;
/** Event types per `recordEventTypeHosts` call. */
export const HOST_RESULTS_PER_BATCH = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the sync should ask Calendly who hosts this event type. */
export function isHostCheckCandidate(resource: unknown): resource is Record<string, unknown> & { uri: string } {
  if (!isRecord(resource) || typeof resource.uri !== "string" || resource.uri.length === 0) return false;
  const kind = resource.kind;
  if (kind !== undefined && kind !== null && kind !== "solo") return false;
  if (typeof resource.pooling_type !== "string" || !SINGLE_HOST_POOLING_TYPES.has(resource.pooling_type)) {
    return false;
  }
  if (typeof resource.deleted_at === "string" && resource.deleted_at.length > 0) return false;
  return resource.active !== false;
}

/**
 * A memberships page URL. Always built here from the event type and the page
 * token: a `next_page` URL from a response is never followed with the token.
 */
export function membershipsPageUrl(eventTypeUri: string, pageToken?: string) {
  const url = new URL(MEMBERSHIPS_URL);
  url.searchParams.set("event_type", eventTypeUri);
  url.searchParams.set("count", "2");
  if (pageToken) url.searchParams.set("page_token", pageToken);
  return url.toString();
}

export type MembershipsPage =
  | { kind: "page"; memberUris: string[]; nextPageToken: string | null }
  | { kind: "malformed" };

/**
 * One memberships page. The last page must say so (`next_page: null`); a
 * page that leaves pagination out, or names a next page without a token,
 * proves nothing about the hosts after it.
 */
export function parseMembershipsPage(value: unknown, eventTypeUri: string): MembershipsPage {
  if (!isRecord(value) || !Array.isArray(value.collection) || !isRecord(value.pagination)) {
    return { kind: "malformed" };
  }
  const memberUris: string[] = [];
  for (const row of value.collection) {
    if (!isRecord(row) || !isRecord(row.member)) return { kind: "malformed" };
    const memberUri = row.member.uri;
    if (typeof memberUri !== "string" || !memberUri.startsWith(CALENDLY_USER_URI_PREFIX)) {
      return { kind: "malformed" };
    }
    if (row.event_type !== undefined && (!isRecord(row.event_type) || row.event_type.uri !== eventTypeUri)) {
      return { kind: "malformed" };
    }
    memberUris.push(memberUri);
  }
  const { next_page: nextPage, next_page_token: token } = value.pagination;
  if (nextPage === null && (token === null || token === undefined)) {
    return { kind: "page", memberUris, nextPageToken: null };
  }
  if (typeof nextPage === "string" && nextPage.length > 0 && typeof token === "string" && token.length > 0) {
    return { kind: "page", memberUris, nextPageToken: token };
  }
  return { kind: "malformed" };
}

/**
 * What Calendly said about an event type's hosts:
 * - `single`: exactly one host, read to an explicit last page;
 * - `not_single`: none, or two or more, or Calendly says the event type is
 *   gone or not ours to read (404, 403);
 * - `failed`: asked, but the answer proved nothing (bad response, errors
 *   after a retry, a token that stayed rejected).
 */
export type HostVerdict =
  | { kind: "single"; hostUri: string }
  | { kind: "not_single" }
  | { kind: "failed"; reason: string };

export type HostCheckDeps = {
  /** GET with the bearer token; rejects on network failure or timeout. */
  fetch: (url: string, accessToken: string, timeoutMs: number) => Promise<Response>;
  /** A fresh access token after a 401, or null if none could be had. */
  refreshToken: () => Promise<string | null>;
  now: () => number;
};

export type HostCheckResult = {
  verdicts: Map<string, HostVerdict>;
  /** Candidates never asked about, in order: their stored host is kept. */
  unchecked: string[];
  stoppedBy: "rate_limited" | "quota" | "deadline" | "outage" | null;
  /** The 429 that stopped the check; the caller fails the sync with it. */
  rateLimitResponse: Response | null;
  accessToken: string;
};

class RateLimited extends Error {
  constructor(readonly response: Response) {
    super("Calendly rate limited the host check");
  }
}

class Unchecked extends Error {}

/**
 * Asks Calendly who hosts each candidate, in the given order, a few at a
 * time, inside a hard deadline and under the rate limit. Stops early on a
 * 429 (the caller fails the sync), low quota, the deadline, or a run of
 * failures that looks like an outage; candidates not reached are unchecked.
 */
export async function runHostChecks(args: {
  candidates: string[];
  accessToken: string;
  /** `X-RateLimit-Remaining` from the last listing response, if any. */
  rateLimitRemaining: number | null;
  deadline: number;
  deps: HostCheckDeps;
}): Promise<HostCheckResult> {
  const { deps, deadline } = args;
  const queue = [...args.candidates];
  const verdicts = new Map<string, HostVerdict>();
  const unchecked: string[] = [];
  let token = args.accessToken;
  let refreshing: Promise<string | null> | null = null;
  let remaining = args.rateLimitRemaining;
  let inFlight = 0;
  let failuresInARow = 0;
  let stoppedBy: HostCheckResult["stoppedBy"] = null;
  let rateLimitResponse: Response | null = null;

  /** Why no new request may start now, if any. */
  function stopReason(): HostCheckResult["stoppedBy"] {
    if (stoppedBy) return stoppedBy;
    if (deps.now() + HOST_CHECK_REQUEST_TIMEOUT_MS > deadline) return "deadline";
    if (remaining !== null && remaining - inFlight <= QUOTA_RESERVE) return "quota";
    if (failuresInARow >= OUTAGE_FAILURES) return "outage";
    return null;
  }

  function noteQuota(response: Response) {
    const header = response.headers.get("X-RateLimit-Remaining");
    const value = header === null ? Number.NaN : Number(header);
    if (Number.isFinite(value)) remaining = value;
  }

  /** One shared refresh at a time; a 401 on a token already replaced just retries. */
  async function freshToken(usedToken: string): Promise<string | null> {
    if (token !== usedToken) return token;
    refreshing ??= deps
      .refreshToken()
      .catch(() => null)
      .finally(() => {
        refreshing = null;
      });
    const next = await refreshing;
    if (next) token = next;
    return next && next !== usedToken ? next : null;
  }

  async function send(url: string, accessToken: string): Promise<Response> {
    const reason = stopReason();
    if (reason) {
      stoppedBy = reason;
      throw new Unchecked();
    }
    inFlight += 1;
    try {
      const response = await deps.fetch(url, accessToken, HOST_CHECK_REQUEST_TIMEOUT_MS);
      noteQuota(response);
      return response;
    } finally {
      inFlight -= 1;
    }
  }

  /** A response for the URL, after one retry on a transient failure and one on a 401. */
  async function request(url: string): Promise<Response | { failed: string }> {
    let usedToken = token;
    let refreshed = false;
    let retried = false;
    for (;;) {
      let response: Response;
      try {
        response = await send(url, usedToken);
      } catch (error) {
        // A stop before a retry, once Calendly was asked: asked, not proven.
        if (error instanceof Unchecked) {
          if (retried || refreshed) return { failed: "interrupted" };
          throw error;
        }
        if (retried) return { failed: "network" };
        retried = true;
        continue;
      }
      if (response.status === 429) {
        // Stop the other workers now, before this error climbs back to the loop.
        stoppedBy = "rate_limited";
        rateLimitResponse ??= response;
        throw new RateLimited(response);
      }
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        // No refresh the retry couldn't use before the deadline.
        if (stopReason()) return { failed: "unauthorized" };
        const next = await freshToken(usedToken);
        if (!next) return { failed: "unauthorized" };
        usedToken = next;
        continue;
      }
      if (response.status >= 500 && !retried) {
        retried = true;
        continue;
      }
      return response;
    }
  }

  async function check(eventTypeUri: string): Promise<HostVerdict> {
    const hosts = new Set<string>();
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      let response: Response | { failed: string };
      try {
        response = await request(membershipsPageUrl(eventTypeUri, pageToken));
      } catch (error) {
        // Stopped after Calendly already answered a page: asked, not proven.
        if (error instanceof Unchecked && page > 0) return { kind: "failed", reason: "interrupted" };
        throw error;
      }
      if ("failed" in response) return { kind: "failed", reason: response.failed };
      if (response.status === 403 || response.status === 404) return { kind: "not_single" };
      if (!response.ok) return { kind: "failed", reason: `http_${response.status}` };
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: "failed", reason: "malformed" };
      }
      const parsed = parseMembershipsPage(body, eventTypeUri);
      if (parsed.kind === "malformed") return { kind: "failed", reason: "malformed" };
      for (const uri of parsed.memberUris) hosts.add(uri);
      if (hosts.size >= 2) return { kind: "not_single" };
      if (parsed.nextPageToken === null) {
        const [only] = [...hosts];
        return only ? { kind: "single", hostUri: only } : { kind: "not_single" };
      }
      if (seenTokens.has(parsed.nextPageToken)) return { kind: "failed", reason: "repeated_page" };
      seenTokens.add(parsed.nextPageToken);
      pageToken = parsed.nextPageToken;
    }
    return { kind: "failed", reason: "too_many_pages" };
  }

  async function worker() {
    for (;;) {
      const eventTypeUri = queue.shift();
      if (eventTypeUri === undefined) return;
      if (stopReason()) {
        stoppedBy ??= stopReason();
        unchecked.push(eventTypeUri);
        continue;
      }
      try {
        const verdict = await check(eventTypeUri);
        verdicts.set(eventTypeUri, verdict);
        failuresInARow = verdict.kind === "failed" ? failuresInARow + 1 : 0;
      } catch (error) {
        if (error instanceof RateLimited) {
          stoppedBy = "rate_limited";
          rateLimitResponse ??= error.response;
          unchecked.push(eventTypeUri);
        } else if (error instanceof Unchecked) {
          unchecked.push(eventTypeUri);
        } else {
          throw error;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: HOST_CHECK_CONCURRENCY }, () => worker()));
  return { verdicts, unchecked, stoppedBy, rateLimitResponse, accessToken: token };
}
